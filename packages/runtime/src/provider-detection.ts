import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type DetectedAgentCli = {
  command: string;
  error?: string;
  id: string;
  name: string;
  path: string;
  version?: string;
};

type AgentCliDetector = {
  command: string;
  id: string;
  name: string;
  versionArgs?: string[];
};

const AGENT_CLI_DETECTORS: AgentCliDetector[] = [
  { id: "codex", name: "Codex", command: "codex" },
  { id: "claude-code", name: "Claude Code", command: "claude" },
  { id: "opencode", name: "OpenCode", command: "opencode" },
  { id: "pi", name: "Pi", command: "pi" },
  { id: "kimi", name: "Kimi", command: "kimi" },
  { id: "kilo", name: "Kilo", command: "kilo" },
  { id: "grok", name: "Grok", command: "grok" },
];

export function detectAgentCliProviders(env: NodeJS.ProcessEnv = process.env): DetectedAgentCli[] {
  return AGENT_CLI_DETECTORS.flatMap((detector) => {
    const cliPath = resolveCommandPath(detector.command, env);
    if (!cliPath) return [];
    const version = detectCliVersion(cliPath, detector.versionArgs ?? ["--version"], env);
    return [
      {
        command: detector.command,
        error: version.error,
        id: detector.id,
        name: detector.name,
        path: cliPath,
        version: version.version,
      },
    ];
  });
}

function resolveCommandPath(command: string, env: NodeJS.ProcessEnv): string {
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return isExecutable(command) ? path.resolve(command) : "";
  }
  for (const directory of pathDirectories(env)) {
    for (const candidate of executableCandidates(directory, command, env)) {
      if (isExecutable(candidate)) return candidate;
    }
  }
  return "";
}

function detectCliVersion(
  cliPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { error?: string; version?: string } {
  const result = spawnSync(cliPath, args, {
    encoding: "utf8",
    env: detectionEnvironment(env),
    maxBuffer: 1024 * 1024,
    shell: false,
    timeout: 5_000,
    windowsHide: true,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  const firstLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (result.error) {
    return { error: result.error.message || firstLine || "Failed to execute CLI." };
  }
  if (result.status !== 0 || result.signal) {
    return {
      error:
        firstLine ||
        (result.signal
          ? `CLI version command terminated with ${result.signal}.`
          : `CLI version command exited with status ${result.status}.`),
    };
  }
  return { version: firstLine };
}

function pathDirectories(env: NodeJS.ProcessEnv): string[] {
  return [
    env.PATH,
    path.join(os.homedir(), ".grok", "bin"),
    path.join(os.homedir(), ".kimi-code", "bin"),
    path.join(os.homedir(), ".local", "bin"),
    path.join(os.homedir(), "bin"),
    path.join(os.homedir(), ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ]
    .filter(Boolean)
    .flatMap((entry) => String(entry).split(path.delimiter))
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry, index, list) => list.indexOf(entry) === index);
}

function executableCandidates(
  directory: string,
  command: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const extensions =
    process.platform === "win32"
      ? String(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .filter(Boolean)
      : [""];
  return extensions.map((extension) => path.join(directory, `${command}${extension}`));
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function detectionEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...env,
    PATH: pathDirectories(env).join(path.delimiter),
  };
}
