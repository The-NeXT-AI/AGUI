import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AspEventSender } from "@the-next-ai/asp/manager";
import type {
  ApprovalMode,
  AspReasoningEffort,
  AspRunSpeed,
  RunInput,
  RunResult,
} from "@the-next-ai/asp/types";
import type { AppStorage } from "./storage/index.js";

export type ScheduledTaskFrequency = "once" | "daily" | "weekly" | "interval";

export type ScheduledTaskSchedule =
  | {
      type: "once";
      date: string;
      time: string;
    }
  | {
      type: "daily";
      time: string;
    }
  | {
      type: "weekly";
      weekdays: number[];
      time: string;
    }
  | {
      type: "interval";
      intervalMinutes: number;
    };

export type ScheduledTaskRetryPolicy = {
  backoffMinutes: number;
  maxRetries: number;
};

export type ScheduledTaskRunStatus = "running" | "success" | "failed" | "canceled";

export type ScheduledTaskRunReason = "scheduled" | "manual" | "retry" | "catch_up";

export type ScheduledTaskRunHistoryEntry = {
  attempt: number;
  error?: string;
  finishedAt?: number;
  id: string;
  nextRetryAt?: number;
  providerSessionId?: string;
  reason: ScheduledTaskRunReason;
  scheduledFor?: number;
  sessionId: string;
  startedAt: number;
  status: ScheduledTaskRunStatus;
};

export type ScheduledTaskPendingRetry = {
  attempt: number;
  reason: Exclude<ScheduledTaskRunReason, "manual" | "retry">;
  resumeNextRunAt: number | null;
  scheduledFor?: number;
};

export type ScheduledTaskInput = {
  approvalMode?: ApprovalMode;
  cwd?: string | null;
  effort?: AspReasoningEffort;
  enabled: boolean;
  model?: string;
  projectPath: string | null;
  prompt: string;
  providerId: string;
  retryPolicy?: ScheduledTaskRetryPolicy;
  schedule: ScheduledTaskSchedule;
  speed?: AspRunSpeed;
  title: string;
  workspaceId?: string;
};

export type ScheduledTask = Required<
  Pick<ScheduledTaskInput, "approvalMode" | "retryPolicy" | "workspaceId">
> &
  Omit<ScheduledTaskInput, "approvalMode" | "retryPolicy" | "workspaceId"> & {
    createdAt: number;
    failureCount: number;
    id: string;
    lastFinishedAt?: number;
    lastProviderSessionId?: string;
    lastRunAt?: number;
    lastRunError?: string;
    lastRunStatus?: ScheduledTaskRunStatus;
    lastSessionId?: string;
    missedRunCount: number;
    nextRunAt: number | null;
    pendingRetry?: ScheduledTaskPendingRetry;
    runCount: number;
    runHistory: ScheduledTaskRunHistoryEntry[];
    updatedAt: number;
  };

export type ScheduledTaskRunStartedEvent = {
  at: number;
  cwd: string;
  session: {
    createdAt: number;
    cwd: string;
    id: string;
    projectPath: string | null;
    providerId: string;
    title: string;
    workspaceId: string;
  };
  sessionId: string;
  task: ScheduledTask;
  taskId: string;
  type: "run_started";
};

export type ScheduledTaskRunFinishedEvent = {
  at: number;
  canceled?: boolean;
  error?: string;
  providerSessionId?: string;
  sessionId: string;
  success: boolean;
  task?: ScheduledTask;
  taskId: string;
  type: "run_finished";
};

export type ScheduledTaskTasksUpdatedEvent = {
  at: number;
  tasks: ScheduledTask[];
  type: "tasks_updated";
};

export type ScheduledTaskEvent =
  ScheduledTaskRunFinishedEvent | ScheduledTaskRunStartedEvent | ScheduledTaskTasksUpdatedEvent;

export type ScheduledTaskRunResult = {
  sessionId: string;
};

export type ScheduledTaskServiceOptions = {
  broadcast(channel: string, payload: unknown): void;
  defaultWorkspace(): string;
  log?: Pick<Console, "warn">;
  privateSessionDirectory(sessionId: string, createdAt: number): string;
  run(input: RunInput, sender: AspEventSender): Promise<RunResult>;
  storage: AppStorage;
};

const CHECK_INTERVAL_MS = 30_000;
const DEFAULT_APPROVAL_MODE: ApprovalMode = "auto-edit";
const DEFAULT_RETRY_POLICY: ScheduledTaskRetryPolicy = { backoffMinutes: 5, maxRetries: 1 };
const DEFAULT_WORKSPACE_ID = "default";
const LEGACY_STORAGE_KEY = "agui-scheduled-tasks";
const LEGACY_STORAGE_NAMESPACE = "renderer";
const MAX_RETRY_BACKOFF_MINUTES = 7 * 24 * 60;
const MAX_RETRY_ATTEMPTS = 5;
const RUN_HISTORY_LIMIT = 20;
const STORAGE_KEY = "scheduled-tasks";
const STORAGE_NAMESPACE = "runtime";

export const SCHEDULED_TASK_SENDER_ID = "agui-schedule";

type PersistedScheduledTaskState = {
  tasks: ScheduledTask[];
  version: 1;
};

export class ScheduledTaskService {
  private readonly broadcastEvent: (channel: string, payload: unknown) => void;
  private readonly defaultWorkspace: () => string;
  private readonly log: Pick<Console, "warn">;
  private readonly privateSessionDirectory: (sessionId: string, createdAt: number) => string;
  private readonly run: (input: RunInput, sender: AspEventSender) => Promise<RunResult>;
  private readonly runningTaskIds = new Set<string>();
  private readonly storage: AppStorage;
  private operation: Promise<unknown> = Promise.resolve();
  private ready: Promise<ScheduledTask[]> | undefined;
  private stopped = false;
  private tasks: ScheduledTask[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(options: ScheduledTaskServiceOptions) {
    this.broadcastEvent = options.broadcast;
    this.defaultWorkspace = options.defaultWorkspace;
    this.log = options.log ?? console;
    this.privateSessionDirectory = options.privateSessionDirectory;
    this.run = options.run;
    this.storage = options.storage;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    void this.ensureReady()
      .then(() => {
        if (this.stopped) return;
        void this.tick();
        this.timer = setInterval(() => void this.tick(), CHECK_INTERVAL_MS);
      })
      .catch((error) => {
        if (this.stopped) return;
        this.log.warn(`Scheduled task startup failed: ${formatError(error)}`);
      });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.runningTaskIds.clear();
  }

  async listTasks(): Promise<ScheduledTask[]> {
    await this.ensureReady();
    return cloneTasks(this.tasks);
  }

  async addTask(input: ScheduledTaskInput): Promise<ScheduledTask> {
    return this.queue(async () => {
      await this.ensureReady();
      const now = Date.now();
      const normalized = normalizeTaskInput(input);
      const task: ScheduledTask = {
        ...normalized,
        createdAt: now,
        failureCount: 0,
        id: scheduledTaskId(),
        missedRunCount: 0,
        nextRunAt: normalized.enabled ? computeNextRunAt(normalized.schedule, now) : null,
        runCount: 0,
        runHistory: [],
        updatedAt: now,
      };
      validateTask(task);
      await this.setTasks([task, ...this.tasks]);
      return cloneTask(task);
    });
  }

  async updateTask(id: string, input: ScheduledTaskInput): Promise<ScheduledTask> {
    return this.queue(async () => {
      await this.ensureReady();
      const taskId = normalizeId(id);
      const now = Date.now();
      let updated: ScheduledTask | undefined;
      const tasks = this.tasks.map((task) => {
        if (task.id !== taskId) return task;
        const normalized = normalizeTaskInput(input);
        updated = {
          ...task,
          ...normalized,
          lastRunError: task.lastRunError,
          lastRunStatus: task.lastRunStatus,
          pendingRetry: undefined,
          nextRunAt: normalized.enabled ? computeNextRunAt(normalized.schedule, now) : null,
          updatedAt: now,
        };
        validateTask(updated);
        return updated;
      });
      if (!updated) throw new Error(`Scheduled task not found: ${taskId}`);
      await this.setTasks(tasks);
      return cloneTask(updated);
    });
  }

  async removeTask(id: string): Promise<boolean> {
    return this.queue(async () => {
      await this.ensureReady();
      const taskId = normalizeId(id);
      const tasks = this.tasks.filter((task) => task.id !== taskId);
      if (tasks.length === this.tasks.length) return false;
      await this.setTasks(tasks);
      return true;
    });
  }

  async setTaskEnabled(id: string, enabled: boolean): Promise<ScheduledTask> {
    return this.queue(async () => {
      await this.ensureReady();
      const taskId = normalizeId(id);
      const now = Date.now();
      let updated: ScheduledTask | undefined;
      const tasks = this.tasks.map((task) => {
        if (task.id !== taskId) return task;
        updated = {
          ...task,
          enabled,
          pendingRetry: undefined,
          nextRunAt: enabled ? computeNextRunAt(task.schedule, now) : null,
          updatedAt: now,
        };
        return updated;
      });
      if (!updated) throw new Error(`Scheduled task not found: ${taskId}`);
      await this.setTasks(tasks);
      return cloneTask(updated);
    });
  }

  async runTaskNow(id: string): Promise<ScheduledTaskRunResult> {
    await this.ensureReady();
    const taskId = normalizeId(id);
    const task = this.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error(`Scheduled task not found: ${taskId}`);
    return this.startTaskRun(task, { advanceSchedule: false, reason: "manual" });
  }

  private async tick(): Promise<void> {
    try {
      await this.ensureReady();
      const now = Date.now();
      const dueTasks = this.tasks.filter(
        (task) =>
          task.enabled &&
          task.nextRunAt != null &&
          task.nextRunAt <= now &&
          !this.runningTaskIds.has(task.id),
      );
      for (const task of dueTasks) {
        const scheduledFor = task.nextRunAt ?? now;
        const pendingRetry = task.pendingRetry;
        const missedRunCount =
          pendingRetry || scheduledFor > now
            ? 0
            : countMissedScheduledRuns(task.schedule, scheduledFor, now);
        this.startTaskRun(task, {
          advanceSchedule: !pendingRetry,
          attempt: pendingRetry?.attempt ?? 0,
          missedRunCount,
          reason: pendingRetry ? "retry" : missedRunCount > 0 ? "catch_up" : "scheduled",
          scheduledFor: pendingRetry?.scheduledFor ?? scheduledFor,
        }).catch((error) => {
          this.log.warn(`Scheduled task failed to start: ${formatError(error)}`);
        });
      }
    } catch (error) {
      this.log.warn(`Scheduled task tick failed: ${formatError(error)}`);
    }
  }

  private async startTaskRun(
    task: ScheduledTask,
    options: {
      advanceSchedule: boolean;
      attempt?: number;
      missedRunCount?: number;
      reason: ScheduledTaskRunReason;
      scheduledFor?: number;
    },
  ): Promise<ScheduledTaskRunResult> {
    if (this.runningTaskIds.has(task.id))
      throw new Error(`Scheduled task is already running: ${task.id}`);
    const startedAt = Date.now();
    const sessionId = scheduledSessionId(task.id, startedAt);
    const cwd = this.resolveTaskCwd(task, sessionId, startedAt);
    this.runningTaskIds.add(task.id);
    const startedTask = await this.recordRunStarted(task.id, sessionId, startedAt, {
      advanceSchedule: options.advanceSchedule,
      attempt: options.attempt ?? 0,
      missedRunCount: options.missedRunCount ?? 0,
      reason: options.reason,
      scheduledFor: options.scheduledFor,
    });
    const session = {
      createdAt: startedAt,
      cwd,
      id: sessionId,
      projectPath: task.projectPath,
      providerId: task.providerId,
      title: task.title || "Scheduled task",
      workspaceId: task.workspaceId,
    };
    this.broadcastScheduleEvent({
      at: startedAt,
      cwd,
      session,
      sessionId,
      task: startedTask ?? task,
      taskId: task.id,
      type: "run_started",
    });

    const input: RunInput = {
      approvalMode: task.approvalMode,
      cwd,
      effort: task.effort,
      model: task.model,
      prompt: task.prompt,
      providerId: task.providerId,
      speed: task.speed,
      uiSessionId: sessionId,
    };
    void this.run(input, this.schedulerClient())
      .then((result) => this.recordRunFinished(task.id, sessionId, result))
      .catch((error) => this.recordRunFailed(task.id, sessionId, error))
      .finally(() => {
        this.runningTaskIds.delete(task.id);
      });
    return { sessionId };
  }

  private schedulerClient(): AspEventSender {
    return {
      id: SCHEDULED_TASK_SENDER_ID,
      isDestroyed: () => false,
      send: (channel, payload) => this.broadcastEvent(channel, payload),
    };
  }

  private resolveTaskCwd(task: ScheduledTask, sessionId: string, startedAt: number): string {
    const explicitCwd = task.cwd?.trim();
    if (explicitCwd) return explicitCwd;
    const projectPath = task.projectPath?.trim();
    if (projectPath) return projectPath;
    return this.privateSessionDirectory(sessionId, startedAt) || this.defaultWorkspace();
  }

  private async recordRunStarted(
    id: string,
    sessionId: string,
    startedAt: number,
    options: {
      advanceSchedule: boolean;
      attempt: number;
      missedRunCount: number;
      reason: ScheduledTaskRunReason;
      scheduledFor?: number;
    },
  ): Promise<ScheduledTask | undefined> {
    return this.queue(async () => {
      await this.ensureReady();
      let updated: ScheduledTask | undefined;
      const tasks = this.tasks.map((task) => {
        if (task.id !== id) return task;
        const nextRunAt = options.advanceSchedule
          ? computeNextRunAt(task.schedule, startedAt)
          : task.nextRunAt;
        const runEntry: ScheduledTaskRunHistoryEntry = {
          attempt: options.attempt,
          id: scheduledRunId(),
          reason: options.reason,
          scheduledFor: options.scheduledFor,
          sessionId,
          startedAt,
          status: "running",
        };
        updated = {
          ...task,
          lastRunAt: startedAt,
          lastRunError: undefined,
          lastRunStatus: "running",
          lastSessionId: sessionId,
          missedRunCount: task.missedRunCount + options.missedRunCount,
          nextRunAt,
          pendingRetry: options.reason === "retry" ? task.pendingRetry : undefined,
          runCount: task.runCount + 1,
          runHistory: appendRunHistory(task.runHistory, runEntry),
          updatedAt: startedAt,
        };
        return updated;
      });
      if (updated) await this.setTasks(tasks);
      return updated ? cloneTask(updated) : undefined;
    });
  }

  private async recordRunFinished(id: string, sessionId: string, result: RunResult): Promise<void> {
    const finishedAt = Date.now();
    let updated: ScheduledTask | undefined;
    await this.queue(async () => {
      await this.ensureReady();
      const tasks = this.tasks.map((task) => {
        if (task.id !== id) return task;
        const status: ScheduledTaskRunStatus = result.canceled
          ? "canceled"
          : result.success
            ? "success"
            : "failed";
        const error = status === "failed" ? "Scheduled task run failed." : undefined;
        const completion = completeRun(task, sessionId, {
          error,
          finishedAt,
          providerSessionId: result.providerSessionId,
          status,
        });
        updated = {
          ...completion,
          lastProviderSessionId: result.providerSessionId,
          lastRunError: error,
          lastRunStatus: status,
          updatedAt: finishedAt,
        };
        return updated;
      });
      if (updated) await this.setTasks(tasks);
    });
    this.broadcastScheduleEvent({
      at: finishedAt,
      canceled: result.canceled,
      providerSessionId: result.providerSessionId,
      sessionId,
      success: Boolean(result.success && !result.canceled),
      task: updated ? cloneTask(updated) : undefined,
      taskId: id,
      type: "run_finished",
    });
  }

  private async recordRunFailed(id: string, sessionId: string, error: unknown): Promise<void> {
    const finishedAt = Date.now();
    const message = formatError(error);
    let updated: ScheduledTask | undefined;
    await this.queue(async () => {
      await this.ensureReady();
      const tasks = this.tasks.map((task) => {
        if (task.id !== id) return task;
        const completion = completeRun(task, sessionId, {
          error: message,
          finishedAt,
          status: "failed",
        });
        updated = {
          ...completion,
          lastRunError: message,
          lastRunStatus: "failed",
          updatedAt: finishedAt,
        };
        return updated;
      });
      if (updated) await this.setTasks(tasks);
    });
    this.broadcastScheduleEvent({
      at: finishedAt,
      error: message,
      sessionId,
      success: false,
      task: updated ? cloneTask(updated) : undefined,
      taskId: id,
      type: "run_finished",
    });
  }

  private async ensureReady(): Promise<ScheduledTask[]> {
    this.ready ??= this.loadTasks();
    return this.ready;
  }

  private async loadTasks(): Promise<ScheduledTask[]> {
    const saved = await this.storage.get({ key: STORAGE_KEY, namespace: STORAGE_NAMESPACE });
    if (saved) {
      this.tasks = normalizePersistedTasks(JSON.parse(saved));
      return this.tasks;
    }
    const legacy = await this.storage.get({
      key: LEGACY_STORAGE_KEY,
      namespace: LEGACY_STORAGE_NAMESPACE,
    });
    this.tasks = legacy ? normalizeLegacyTasks(JSON.parse(legacy)) : [];
    if (legacy) await this.writeTasks(this.tasks);
    return this.tasks;
  }

  private async setTasks(tasks: ScheduledTask[]): Promise<void> {
    this.tasks = tasks.map(normalizePersistedTask);
    await this.writeTasks(this.tasks);
    this.broadcastScheduleEvent({
      at: Date.now(),
      tasks: cloneTasks(this.tasks),
      type: "tasks_updated",
    });
  }

  private async writeTasks(tasks: ScheduledTask[]): Promise<void> {
    const state: PersistedScheduledTaskState = {
      tasks,
      version: 1,
    };
    await this.storage.set({
      key: STORAGE_KEY,
      namespace: STORAGE_NAMESPACE,
      value: JSON.stringify(state),
    });
  }

  private broadcastScheduleEvent(event: ScheduledTaskEvent): void {
    this.broadcastEvent("agui:schedule:event", event);
  }

  private queue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operation.catch(() => undefined).then(operation);
    this.operation = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export function computeNextRunAt(
  schedule: ScheduledTaskSchedule,
  from = Date.now(),
): number | null {
  switch (schedule.type) {
    case "once": {
      const timestamp = localDateTimeToTimestamp(schedule.date, schedule.time);
      return timestamp && timestamp > from ? timestamp : null;
    }
    case "daily": {
      const time = parseTime(schedule.time);
      if (!time) return null;
      const candidate = withLocalTime(new Date(from), time.hours, time.minutes);
      if (candidate.getTime() <= from) candidate.setDate(candidate.getDate() + 1);
      return candidate.getTime();
    }
    case "weekly": {
      const time = parseTime(schedule.time);
      if (!time || schedule.weekdays.length === 0) return null;
      const weekdays = new Set(schedule.weekdays);
      for (let offset = 0; offset <= 7; offset += 1) {
        const candidate = withLocalTime(new Date(from), time.hours, time.minutes);
        candidate.setDate(candidate.getDate() + offset);
        if (weekdays.has(candidate.getDay()) && candidate.getTime() > from) {
          return candidate.getTime();
        }
      }
      return null;
    }
    case "interval": {
      const minutes = Math.max(1, Math.floor(schedule.intervalMinutes || 0));
      return from + minutes * 60_000;
    }
  }
}

function normalizeTaskInput(
  input: ScheduledTaskInput,
): ScheduledTaskInput &
  Required<Pick<ScheduledTaskInput, "approvalMode" | "retryPolicy" | "workspaceId">> {
  return {
    approvalMode: normalizeApprovalMode(input.approvalMode),
    cwd: normalizeOptionalPath(input.cwd),
    effort: normalizeEffort(input.effort),
    enabled: Boolean(input.enabled),
    model: normalizeOptionalString(input.model),
    projectPath: normalizeOptionalPath(input.projectPath),
    prompt: String(input.prompt ?? "").trim(),
    providerId: String(input.providerId ?? "").trim(),
    schedule: normalizeSchedule(input.schedule),
    speed: normalizeSpeed(input.speed),
    retryPolicy: normalizeRetryPolicy(input.retryPolicy),
    title: String(input.title ?? "").trim(),
    workspaceId: normalizeOptionalString(input.workspaceId) || DEFAULT_WORKSPACE_ID,
  };
}

function normalizePersistedTasks(value: unknown): ScheduledTask[] {
  const source = record(value);
  const tasks = Array.isArray(source.tasks) ? source.tasks : [];
  return tasks.map(normalizePersistedTask).filter((task) => task.prompt && task.providerId);
}

function normalizeLegacyTasks(value: unknown): ScheduledTask[] {
  const source = record(value);
  const state = record(source.state);
  const tasks = Array.isArray(state.tasks)
    ? state.tasks
    : Array.isArray(source.tasks)
      ? source.tasks
      : [];
  return tasks.map(normalizePersistedTask).filter((task) => task.prompt && task.providerId);
}

function normalizePersistedTask(value: unknown): ScheduledTask {
  const task = record(value);
  const schedule = normalizeSchedule(task.schedule);
  const enabled = Boolean(task.enabled);
  const createdAt = finiteNumber(task.createdAt) ?? Date.now();
  const history = normalizeRunHistory(task.runHistory);
  const lastRunStatus = normalizeRunStatus(task.lastRunStatus);
  const nextRunAt =
    task.nextRunAt === null
      ? null
      : (finiteNumber(task.nextRunAt) ?? (enabled ? computeNextRunAt(schedule, Date.now()) : null));
  return {
    approvalMode: normalizeApprovalMode(task.approvalMode),
    cwd: normalizeOptionalPath(task.cwd),
    effort: normalizeEffort(task.effort),
    enabled,
    failureCount: Math.max(0, Math.floor(finiteNumber(task.failureCount) ?? 0)),
    id: normalizeId(task.id) || scheduledTaskId(),
    createdAt,
    lastFinishedAt: finiteNumber(task.lastFinishedAt),
    lastProviderSessionId: normalizeOptionalString(task.lastProviderSessionId),
    lastRunAt: finiteNumber(task.lastRunAt),
    lastRunError:
      lastRunStatus === "running"
        ? "Scheduled task run was interrupted before completion."
        : normalizeOptionalString(task.lastRunError),
    lastRunStatus: lastRunStatus === "running" ? "failed" : lastRunStatus,
    lastSessionId: normalizeOptionalString(task.lastSessionId),
    missedRunCount: Math.max(0, Math.floor(finiteNumber(task.missedRunCount) ?? 0)),
    model: normalizeOptionalString(task.model),
    nextRunAt,
    pendingRetry: normalizePendingRetry(task.pendingRetry),
    projectPath: normalizeOptionalPath(task.projectPath),
    prompt: normalizeOptionalString(task.prompt),
    providerId: normalizeOptionalString(task.providerId) || "codex",
    retryPolicy: normalizeRetryPolicy(task.retryPolicy),
    runCount: Math.max(0, Math.floor(finiteNumber(task.runCount) ?? 0)),
    runHistory: history,
    schedule,
    speed: normalizeSpeed(task.speed),
    title: normalizeOptionalString(task.title) || "Scheduled task",
    updatedAt: finiteNumber(task.updatedAt) ?? createdAt,
    workspaceId: normalizeOptionalString(task.workspaceId) || DEFAULT_WORKSPACE_ID,
  };
}

function validateTask(task: ScheduledTask): void {
  if (!task.title) throw new Error("Scheduled task title is required.");
  if (!task.prompt) throw new Error("Scheduled task prompt is required.");
  if (!task.providerId) throw new Error("Scheduled task provider is required.");
  if (!isValidSchedule(task.schedule)) throw new Error("Scheduled task schedule is incomplete.");
  if (task.enabled && task.nextRunAt == null) {
    throw new Error("Scheduled task next run must be in the future.");
  }
}

function completeRun(
  task: ScheduledTask,
  sessionId: string,
  result: {
    error?: string;
    finishedAt: number;
    providerSessionId?: string;
    status: ScheduledTaskRunStatus;
  },
): ScheduledTask {
  const entry = task.runHistory.find((item) => item.sessionId === sessionId);
  const failed = result.status === "failed";
  const shouldRetry = Boolean(
    entry && failed && entry.reason !== "manual" && entry.attempt < task.retryPolicy.maxRetries,
  );
  const nextRetryAt = shouldRetry
    ? result.finishedAt + scheduledRetryDelayMs(task.retryPolicy, (entry?.attempt ?? 0) + 1)
    : undefined;
  const pendingRetry =
    shouldRetry && entry
      ? {
          attempt: entry.attempt + 1,
          reason: task.pendingRetry?.reason ?? scheduledRetryReason(entry.reason),
          resumeNextRunAt: task.pendingRetry?.resumeNextRunAt ?? task.nextRunAt,
          scheduledFor: task.pendingRetry?.scheduledFor ?? entry.scheduledFor,
        }
      : undefined;
  const originalReason =
    task.pendingRetry?.reason ??
    (entry && entry.reason !== "manual" ? scheduledRetryReason(entry.reason) : undefined);
  const oneShotScheduledRun = task.schedule.type === "once" && originalReason !== undefined;
  const nextRunAt = shouldRetry
    ? (nextRetryAt ?? task.nextRunAt)
    : task.pendingRetry
      ? restoreScheduledRunAt(task, result.finishedAt)
      : oneShotScheduledRun
        ? null
        : task.nextRunAt;
  const enabled = shouldRetry ? true : oneShotScheduledRun ? false : task.enabled;
  return {
    ...task,
    enabled,
    failureCount: failed
      ? task.failureCount + 1
      : result.status === "success"
        ? 0
        : task.failureCount,
    lastFinishedAt: result.finishedAt,
    nextRunAt,
    pendingRetry,
    runHistory: updateRunHistory(task.runHistory, sessionId, {
      error: result.error,
      finishedAt: result.finishedAt,
      nextRetryAt,
      providerSessionId: result.providerSessionId,
      status: result.status,
    }),
  };
}

function restoreScheduledRunAt(task: ScheduledTask, from: number): number | null {
  if (task.schedule.type === "once") return null;
  const resume = task.pendingRetry?.resumeNextRunAt ?? task.nextRunAt;
  if (resume != null && resume > from) return resume;
  return task.enabled ? computeNextRunAt(task.schedule, from) : null;
}

function scheduledRetryReason(
  reason: ScheduledTaskRunReason,
): Exclude<ScheduledTaskRunReason, "manual" | "retry"> {
  return reason === "catch_up" ? "catch_up" : "scheduled";
}

export function scheduledRetryDelayMs(policy: ScheduledTaskRetryPolicy, attempt: number): number {
  const normalized = normalizeRetryPolicy(policy);
  const multiplier = Math.max(1, Math.floor(attempt));
  return normalized.backoffMinutes * multiplier * 60_000;
}

export function countMissedScheduledRuns(
  schedule: ScheduledTaskSchedule,
  scheduledFor: number,
  now: number,
): number {
  if (!Number.isFinite(scheduledFor) || !Number.isFinite(now) || scheduledFor >= now) return 0;
  if (schedule.type === "once") return 0;
  if (schedule.type === "interval") {
    const intervalMs = Math.max(1, Math.floor(schedule.intervalMinutes || 0)) * 60_000;
    return Math.max(0, Math.floor((now - scheduledFor) / intervalMs));
  }
  let count = 0;
  let cursor = scheduledFor;
  for (let index = 0; index < 1_000; index += 1) {
    const next = computeNextRunAt(schedule, cursor);
    if (next == null || next > now) break;
    count += 1;
    cursor = next;
  }
  return count;
}

function normalizeSchedule(value: unknown): ScheduledTaskSchedule {
  const schedule = record(value);
  switch (schedule.type) {
    case "once":
      return {
        type: "once",
        date: normalizeOptionalString(schedule.date),
        time: normalizeOptionalString(schedule.time),
      };
    case "weekly":
      return {
        type: "weekly",
        time: normalizeOptionalString(schedule.time),
        weekdays: uniqueWeekdays(schedule.weekdays),
      };
    case "interval":
      return {
        type: "interval",
        intervalMinutes: Math.max(1, Math.floor(finiteNumber(schedule.intervalMinutes) ?? 1)),
      };
    case "daily":
    default:
      return {
        type: "daily",
        time: normalizeOptionalString(schedule.time),
      };
  }
}

function normalizeRetryPolicy(value: unknown): ScheduledTaskRetryPolicy {
  const policy = record(value);
  return {
    backoffMinutes: clampInteger(
      finiteNumber(policy.backoffMinutes) ?? DEFAULT_RETRY_POLICY.backoffMinutes,
      1,
      MAX_RETRY_BACKOFF_MINUTES,
    ),
    maxRetries: clampInteger(
      finiteNumber(policy.maxRetries) ?? DEFAULT_RETRY_POLICY.maxRetries,
      0,
      MAX_RETRY_ATTEMPTS,
    ),
  };
}

function normalizePendingRetry(value: unknown): ScheduledTaskPendingRetry | undefined {
  const retry = record(value);
  const attempt = Math.floor(finiteNumber(retry.attempt) ?? 0);
  if (attempt <= 0 || attempt > MAX_RETRY_ATTEMPTS) return undefined;
  const reason = retry.reason === "catch_up" ? "catch_up" : "scheduled";
  const resumeNextRunAt =
    retry.resumeNextRunAt === null ? null : (finiteNumber(retry.resumeNextRunAt) ?? null);
  return {
    attempt,
    reason,
    resumeNextRunAt,
    scheduledFor: finiteNumber(retry.scheduledFor),
  };
}

function normalizeRunHistory(value: unknown): ScheduledTaskRunHistoryEntry[] {
  const source = Array.isArray(value) ? value : [];
  return source
    .map((item): ScheduledTaskRunHistoryEntry | null => {
      const entry = record(item);
      const sessionId = normalizeId(entry.sessionId);
      const startedAt = finiteNumber(entry.startedAt);
      if (!sessionId || startedAt === undefined) return null;
      const status = normalizeRunStatus(entry.status);
      const interrupted = status === "running";
      return {
        attempt: Math.max(0, Math.floor(finiteNumber(entry.attempt) ?? 0)),
        error: interrupted
          ? "Scheduled task run was interrupted before completion."
          : normalizeOptionalString(entry.error),
        finishedAt: finiteNumber(entry.finishedAt),
        id: normalizeId(entry.id) || scheduledRunId(),
        nextRetryAt: finiteNumber(entry.nextRetryAt),
        providerSessionId: normalizeOptionalString(entry.providerSessionId),
        reason: normalizeRunReason(entry.reason),
        scheduledFor: finiteNumber(entry.scheduledFor),
        sessionId,
        startedAt,
        status: interrupted ? "failed" : (status ?? "failed"),
      } satisfies ScheduledTaskRunHistoryEntry;
    })
    .filter((item): item is ScheduledTaskRunHistoryEntry => Boolean(item))
    .sort((left, right) => right.startedAt - left.startedAt)
    .slice(0, RUN_HISTORY_LIMIT);
}

function appendRunHistory(
  history: ScheduledTaskRunHistoryEntry[],
  entry: ScheduledTaskRunHistoryEntry,
): ScheduledTaskRunHistoryEntry[] {
  return [entry, ...history.filter((item) => item.sessionId !== entry.sessionId)].slice(
    0,
    RUN_HISTORY_LIMIT,
  );
}

function updateRunHistory(
  history: ScheduledTaskRunHistoryEntry[],
  sessionId: string,
  updates: Partial<ScheduledTaskRunHistoryEntry>,
): ScheduledTaskRunHistoryEntry[] {
  return history
    .map((entry) => (entry.sessionId === sessionId ? { ...entry, ...updates } : entry))
    .slice(0, RUN_HISTORY_LIMIT);
}

function isValidSchedule(schedule: ScheduledTaskSchedule): boolean {
  switch (schedule.type) {
    case "once":
      return Boolean(localDateTimeToTimestamp(schedule.date, schedule.time));
    case "daily":
      return Boolean(parseTime(schedule.time));
    case "weekly":
      return schedule.weekdays.length > 0 && Boolean(parseTime(schedule.time));
    case "interval":
      return Number.isFinite(schedule.intervalMinutes) && schedule.intervalMinutes >= 1;
  }
}

function localDateTimeToTimestamp(date: string, time: string): number | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const parsedTime = parseTime(time);
  if (!dateMatch || !parsedTime) return null;
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const value = new Date(year, month - 1, day, parsedTime.hours, parsedTime.minutes, 0, 0);
  if (
    Number.isNaN(value.getTime()) ||
    value.getFullYear() !== year ||
    value.getMonth() !== month - 1 ||
    value.getDate() !== day
  ) {
    return null;
  }
  return value.getTime();
}

function parseTime(time: string): { hours: number; minutes: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return { hours, minutes };
}

function withLocalTime(date: Date, hours: number, minutes: number): Date {
  const candidate = new Date(date);
  candidate.setHours(hours, minutes, 0, 0);
  return candidate;
}

function uniqueWeekdays(value: unknown): number[] {
  const source = Array.isArray(value) ? value : [];
  return [...new Set(source.map((item) => Math.floor(Number(item))))]
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort((left, right) => left - right);
}

function normalizeApprovalMode(value: unknown): ApprovalMode {
  return value === "suggest" || value === "auto-edit" || value === "full-auto"
    ? value
    : DEFAULT_APPROVAL_MODE;
}

function normalizeEffort(value: unknown): AspReasoningEffort | undefined {
  return value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
    ? value
    : undefined;
}

function normalizeSpeed(value: unknown): AspRunSpeed | undefined {
  return value === "default" || value === "fast" ? value : undefined;
}

function normalizeRunStatus(value: unknown): ScheduledTask["lastRunStatus"] {
  return value === "running" || value === "success" || value === "failed" || value === "canceled"
    ? value
    : undefined;
}

function normalizeRunReason(value: unknown): ScheduledTaskRunReason {
  return value === "manual" || value === "retry" || value === "catch_up" ? value : "scheduled";
}

function normalizeOptionalPath(value: unknown): string | null {
  const text = normalizeOptionalString(value);
  if (!text) return null;
  return path.resolve(text);
}

function normalizeOptionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeId(value: unknown): string {
  return typeof value === "string"
    ? value
        .trim()
        .replace(/[^\w.:-]/g, "-")
        .slice(0, 200)
    : "";
}

function finiteNumber(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function cloneTask(task: ScheduledTask): ScheduledTask {
  return {
    ...task,
    pendingRetry: task.pendingRetry ? { ...task.pendingRetry } : undefined,
    retryPolicy: { ...task.retryPolicy },
    runHistory: task.runHistory.map((entry) => ({ ...entry })),
    schedule:
      task.schedule.type === "weekly"
        ? { ...task.schedule, weekdays: [...task.schedule.weekdays] }
        : { ...task.schedule },
  };
}

function cloneTasks(tasks: ScheduledTask[]): ScheduledTask[] {
  return tasks.map(cloneTask);
}

function scheduledTaskId(): string {
  return `schedule:${randomUUID()}`;
}

function scheduledRunId(): string {
  return `run:${randomUUID()}`;
}

function scheduledSessionId(taskId: string, startedAt: number): string {
  return `schedule:${normalizeId(taskId) || "task"}:${startedAt}:${randomUUID().slice(0, 8)}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ensureDirectory(filePath: string): string {
  fs.mkdirSync(filePath, { recursive: true });
  return filePath;
}
