import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import * as pty from "node-pty";
import type { IPty } from "node-pty";

export type TerminalEventClient = {
  send(channel: string, payload: unknown): void;
};

export type TerminalRuntimeRecord = {
  args?: string[];
  command?: string;
  cwd?: string;
  exitCode?: number | null;
  id: string;
  kind: "process" | "session";
  outputLength: number;
  signal?: string | null;
  startedAt: number;
  status: "exited" | "running";
  updatedAt: number;
};

export type TerminalOutputSnapshot = {
  id: string;
  output: string;
  truncated: boolean;
};

const TERMINAL_OUTPUT_CACHE_LIMIT = 500_000;
const TERMINAL_RECORD_LIMIT = 200;

export class TerminalService {
  private readonly exitWaiters = new Map<string, Set<(record: TerminalRuntimeRecord) => void>>();
  private readonly outputs = new Map<string, string>();
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly records = new Map<string, TerminalRuntimeRecord>();
  private readonly sessionClients = new Map<string, TerminalEventClient>();
  private readonly sessions = new Map<string, IPty>();

  constructor(
    private readonly homeDir: () => string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly broadcast: (channel: string, payload: unknown) => void,
  ) {}

  run(
    input: { id?: string; command?: string; cwd?: string },
    client: TerminalEventClient,
  ): { id: string } {
    const id = safeTerminalId(String(input?.id || ""));
    const command = String(input?.command || "").trim();
    if (!id) throw new Error("Missing terminal id.");
    if (!command) throw new Error("Missing command.");
    if (command.length > 8_192) throw new Error("Command is too long.");
    const { executable, args } = shellCommand(command);
    return this.spawnProcess(id, executable, args, input.cwd, client);
  }

  exec(
    input: {
      id?: string;
      command?: string;
      args?: unknown;
      cwd?: string;
      env?: Record<string, string>;
    },
    client: TerminalEventClient,
  ): { id: string } {
    const id = safeTerminalId(String(input?.id || ""));
    const command = String(input?.command || "").trim();
    const args = Array.isArray(input?.args)
      ? input.args.slice(0, 100).map((value) => String(value).slice(0, 8_192))
      : [];
    if (!id) throw new Error("Missing terminal id.");
    if (!command || command.length > 1_024 || /[\r\n\0]/.test(command)) {
      throw new Error("Invalid executable command.");
    }
    return this.spawnProcess(id, command, args, input.cwd, client, input.env);
  }

  create(input: { id?: string; cwd?: string }, client: TerminalEventClient): { id: string } {
    const id = safeTerminalId(String(input?.id || ""));
    if (!id) throw new Error("Missing terminal id.");
    if (this.sessions.has(id)) {
      this.sessionClients.set(id, client);
      client.send("agui:terminal:event", { id, type: "ready" });
      return { id };
    }
    this.stop(id);
    const { executable, args, env } = terminalSessionCommand();
    const cwd = safeWorkingDirectory(input?.cwd, this.homeDir());
    const session = pty.spawn(executable, args, {
      name: env.TERM || "xterm-256color",
      cols: 120,
      rows: 36,
      cwd,
      env,
    });
    this.sessions.set(id, session);
    this.sessionClients.set(id, client);
    this.setRecord(id, {
      cwd,
      id,
      kind: "session",
      outputLength: 0,
      startedAt: Date.now(),
      status: "running",
      updatedAt: Date.now(),
    });
    const send = (payload: unknown) => {
      const currentClient = this.sessionClients.get(id) ?? client;
      currentClient.send("agui:terminal:event", payload);
    };
    session.onData((chunk) => {
      if (this.sessions.get(id) === session) {
        this.appendOutput(id, chunk);
        send({ id, type: "stdout", chunk });
      }
    });
    session.onExit(({ exitCode, signal }) => {
      if (this.sessions.get(id) !== session) return;
      this.sessions.delete(id);
      this.markExited(id, exitCode, signal == null ? null : String(signal));
      send({
        id,
        type: "exit",
        status: exitCode === 0 ? "success" : "error",
        code: exitCode,
        signal: signal == null ? null : String(signal),
      });
      this.sessionClients.delete(id);
    });
    send({ id, type: "ready" });
    return { id };
  }

  write(input: { id?: string; data?: string }): boolean {
    const id = safeTerminalId(String(input?.id || ""));
    const data = String(input?.data ?? "");
    if (!id) throw new Error("Missing terminal id.");
    if (data.length > 8_192) throw new Error("Terminal input is too long.");
    if (this.env.AGUI_E2E === "1") {
      this.broadcast("agui:terminal:event", { id, type: "stdin", data });
    }
    const session = this.sessions.get(id);
    if (session) {
      session.write(data);
      return true;
    }
    const child = this.processes.get(id);
    return Boolean(child && !child.stdin.destroyed && child.stdin.write(data));
  }

  list(): TerminalRuntimeRecord[] {
    return [...this.records.values()]
      .map((record) => ({
        ...record,
        outputLength: this.outputs.get(record.id)?.length ?? record.outputLength,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  readOutput(input: { id?: string; maxChars?: number }): TerminalOutputSnapshot {
    const id = safeTerminalId(String(input?.id || ""));
    if (!id) throw new Error("Missing terminal id.");
    const output = this.outputs.get(id) ?? "";
    const maxChars = clampInteger(input?.maxChars, 1, TERMINAL_OUTPUT_CACHE_LIMIT);
    return {
      id,
      output: output.length > maxChars ? output.slice(-maxChars) : output,
      truncated: output.length > maxChars,
    };
  }

  waitForExit(input: { id?: string; timeoutMs?: number }): Promise<{
    id: string;
    exitCode?: number | null;
    signal?: string | null;
    timedOut?: boolean;
  }> {
    const id = safeTerminalId(String(input?.id || ""));
    if (!id) throw new Error("Missing terminal id.");
    const current = this.records.get(id);
    if (!current) throw new Error(`Unknown terminal id: ${id}.`);
    if (current.status === "exited") {
      return Promise.resolve({ id, exitCode: current.exitCode, signal: current.signal });
    }
    const timeoutMs = clampInteger(input.timeoutMs ?? 30_000, 1, 10 * 60_000);
    return new Promise((resolve) => {
      const complete = (record: TerminalRuntimeRecord) => {
        clearTimeout(timeout);
        const waiters = this.exitWaiters.get(id);
        waiters?.delete(complete);
        if (!waiters?.size) this.exitWaiters.delete(id);
        resolve({ id, exitCode: record.exitCode, signal: record.signal });
      };
      const timeout = setTimeout(() => {
        const waiters = this.exitWaiters.get(id);
        waiters?.delete(complete);
        if (!waiters?.size) this.exitWaiters.delete(id);
        resolve({ id, timedOut: true });
      }, timeoutMs);
      const waiters = this.exitWaiters.get(id) ?? new Set();
      waiters.add(complete);
      this.exitWaiters.set(id, waiters);
    });
  }

  release(value: string): boolean {
    const id = safeTerminalId(String(value || ""));
    if (!id) throw new Error("Missing terminal id.");
    if (this.processes.has(id) || this.sessions.has(id)) return false;
    const existed = this.records.delete(id) || this.outputs.delete(id);
    this.outputs.delete(id);
    this.exitWaiters.delete(id);
    return existed;
  }

  resize(input: { id?: string; cols?: number; rows?: number }): boolean {
    const id = safeTerminalId(String(input?.id || ""));
    if (!id) throw new Error("Missing terminal id.");
    const session = this.sessions.get(id);
    if (!session) return false;
    session.resize(clampInteger(input?.cols, 20, 400), clampInteger(input?.rows, 5, 200));
    return true;
  }

  stop(value: string): boolean {
    const id = safeTerminalId(String(value || ""));
    const child = this.processes.get(id);
    const session = this.sessions.get(id);
    if (!child && !session) return false;
    child?.kill();
    session?.kill();
    this.processes.delete(id);
    this.sessions.delete(id);
    this.sessionClients.delete(id);
    this.markExited(id, null, "killed");
    return true;
  }

  dispose(): void {
    for (const child of this.processes.values()) child.kill();
    for (const session of this.sessions.values()) session.kill();
    this.processes.clear();
    this.sessions.clear();
    this.sessionClients.clear();
    for (const id of this.records.keys()) this.markExited(id, null, "disposed");
  }

  private spawnProcess(
    id: string,
    executable: string,
    args: string[],
    cwd: string | undefined,
    client: TerminalEventClient,
    envOverride?: Record<string, string>,
  ): { id: string } {
    this.stop(id);
    const workingDirectory = safeWorkingDirectory(cwd, this.homeDir());
    const child = spawn(executable, args, {
      cwd: workingDirectory,
      env: { ...this.env, ...envOverride },
      windowsHide: true,
    });
    this.processes.set(id, child);
    this.setRecord(id, {
      args,
      command: executable,
      cwd: workingDirectory,
      id,
      kind: "process",
      outputLength: 0,
      startedAt: Date.now(),
      status: "running",
      updatedAt: Date.now(),
    });
    const send = (payload: unknown) => client.send("agui:terminal:event", payload);
    child.stdout.on("data", (chunk) => {
      if (this.processes.get(id) === child) {
        const text = String(chunk);
        this.appendOutput(id, text);
        send({ id, type: "stdout", chunk: text });
      }
    });
    child.stderr.on("data", (chunk) => {
      if (this.processes.get(id) === child) {
        const text = String(chunk);
        this.appendOutput(id, text);
        send({ id, type: "stderr", chunk: text });
      }
    });
    child.on("error", (error) => {
      if (this.processes.get(id) !== child) return;
      this.processes.delete(id);
      this.markExited(id, null, null);
      this.appendOutput(id, `${error.message}\n`);
      send({
        id,
        type: "exit",
        status: "error",
        code: null,
        signal: null,
        message: `${error.message}\n`,
      });
    });
    child.on("close", (code, signal) => {
      if (this.processes.get(id) !== child) return;
      this.processes.delete(id);
      this.markExited(id, code, signal == null ? null : String(signal));
      send({ id, type: "exit", status: code === 0 ? "success" : "error", code, signal });
    });
    return { id };
  }

  private setRecord(id: string, record: TerminalRuntimeRecord): void {
    this.records.set(id, record);
    this.outputs.set(id, "");
    this.trimRecords();
  }

  private appendOutput(id: string, chunk: string): void {
    if (!chunk) return;
    const current = this.outputs.get(id) ?? "";
    const next = `${current}${chunk}`;
    const output =
      next.length > TERMINAL_OUTPUT_CACHE_LIMIT ? next.slice(-TERMINAL_OUTPUT_CACHE_LIMIT) : next;
    this.outputs.set(id, output);
    const record = this.records.get(id);
    if (record) {
      this.records.set(id, {
        ...record,
        outputLength: output.length,
        updatedAt: Date.now(),
      });
    }
  }

  private markExited(id: string, exitCode?: number | null, signal?: string | null): void {
    const record = this.records.get(id);
    if (!record) return;
    const next = {
      ...record,
      exitCode,
      signal,
      status: "exited",
      updatedAt: Date.now(),
    } as TerminalRuntimeRecord;
    this.records.set(id, next);
    for (const resolve of this.exitWaiters.get(id) ?? []) resolve(next);
  }

  private trimRecords(): void {
    const records = [...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    for (const record of records.slice(TERMINAL_RECORD_LIMIT)) {
      if (record.status === "running") continue;
      this.records.delete(record.id);
      this.outputs.delete(record.id);
    }
  }
}

function safeTerminalId(value: string): string {
  return /^[a-zA-Z0-9._:-]{1,120}$/.test(value) ? value : "";
}

function safeWorkingDirectory(value: string | undefined, fallback: string): string {
  if (typeof value === "string" && value) {
    try {
      const resolved = path.resolve(value);
      if (fs.statSync(resolved).isDirectory()) return resolved;
    } catch {
      // Use the configured home directory when the requested path is unavailable.
    }
  }
  return fallback;
}

function clampInteger(value: unknown, min: number, max: number): number {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function shellCommand(command: string): { executable: string; args: string[] } {
  if (process.platform === "win32") {
    return { executable: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  return { executable: process.env.SHELL || "/bin/zsh", args: ["-lc", command] };
}

function terminalSessionCommand(): {
  executable: string;
  args: string[];
  env: Record<string, string>;
} {
  const shellPath = process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "/bin/zsh");
  const term = interactiveTerminalTerm(process.env.TERM);
  const env = cleanProcessEnv({
    ...process.env,
    SHELL: shellPath,
    TERM: term,
    COLORTERM: process.env.COLORTERM || "truecolor",
    CLICOLOR: process.env.CLICOLOR || "1",
    FORCE_COLOR: process.env.FORCE_COLOR || "1",
    COLUMNS: process.env.COLUMNS || "120",
    LINES: process.env.LINES || "36",
  });
  if (process.platform === "win32") {
    return { executable: process.env.ComSpec || "cmd.exe", args: ["/Q", "/K"], env };
  }
  return { executable: shellPath, args: terminalLoginShellArgs(shellPath), env };
}

function interactiveTerminalTerm(value: unknown): string {
  const term = String(value ?? "").trim();
  if (!term || term === "dumb" || term === "unknown") return "xterm-256color";
  return term;
}

function cleanProcessEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function terminalLoginShellArgs(shellPath: string): string[] {
  const shellName = path.basename(shellPath).toLowerCase();
  if (shellName.includes("fish")) return ["--login"];
  if (shellName.includes("pwsh") || shellName.includes("powershell")) return [];
  return ["-l"];
}
