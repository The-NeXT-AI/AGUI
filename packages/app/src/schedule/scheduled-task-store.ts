import { create } from "zustand";
import {
  desktopApi,
  type ScheduledTask,
  type ScheduledTaskFrequency,
  type ScheduledTaskInput,
  type ScheduledTaskRetryPolicy,
  type ScheduledTaskRunHistoryEntry,
  type ScheduledTaskRunReason,
  type ScheduledTaskRunResult,
  type ScheduledTaskRunStatus,
  type ScheduledTaskSchedule,
} from "@/asp/desktop-api";

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

export type {
  ScheduledTask,
  ScheduledTaskFrequency,
  ScheduledTaskInput,
  ScheduledTaskRetryPolicy,
  ScheduledTaskRunHistoryEntry,
  ScheduledTaskRunReason,
  ScheduledTaskRunResult,
  ScheduledTaskRunStatus,
  ScheduledTaskSchedule,
};

interface ScheduledTaskStore {
  error: string;
  initialized: boolean;
  loading: boolean;
  tasks: ScheduledTask[];
  addTask: (input: ScheduledTaskInput) => Promise<ScheduledTask>;
  refresh: () => Promise<ScheduledTask[]>;
  removeTask: (id: string) => Promise<boolean>;
  replaceTasks: (tasks: ScheduledTask[]) => void;
  runTaskNow: (id: string) => Promise<ScheduledTaskRunResult>;
  setTaskEnabled: (id: string, enabled: boolean) => Promise<ScheduledTask>;
  updateTask: (id: string, input: ScheduledTaskInput) => Promise<ScheduledTask>;
  upsertTask: (task: ScheduledTask) => void;
}

export const useScheduledTaskStore = create<ScheduledTaskStore>()((set, get) => ({
  error: "",
  initialized: false,
  loading: false,
  tasks: [],

  addTask: async (input) => {
    const task = await scheduleApi().add(input);
    set((state) => ({
      error: "",
      initialized: true,
      tasks: [task, ...state.tasks.filter((item) => item.id !== task.id)],
    }));
    return task;
  },

  refresh: async () => {
    set({ loading: true });
    try {
      const tasks = await scheduleApi().list();
      set({ error: "", initialized: true, loading: false, tasks });
      return tasks;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message, initialized: true, loading: false });
      throw error;
    }
  },

  removeTask: async (id) => {
    const removed = await scheduleApi().remove({ id });
    if (removed) {
      set((state) => ({
        error: "",
        initialized: true,
        tasks: state.tasks.filter((task) => task.id !== id),
      }));
    }
    return removed;
  },

  replaceTasks: (tasks) => set({ error: "", initialized: true, tasks }),

  runTaskNow: (id) => scheduleApi().runNow({ id }),

  setTaskEnabled: async (id, enabled) => {
    const task = await scheduleApi().setEnabled({ enabled, id });
    get().upsertTask(task);
    return task;
  },

  updateTask: async (id, input) => {
    const task = await scheduleApi().update({ id, task: input });
    get().upsertTask(task);
    return task;
  },

  upsertTask: (task) =>
    set((state) => {
      const exists = state.tasks.some((item) => item.id === task.id);
      return {
        error: "",
        initialized: true,
        tasks: exists
          ? state.tasks.map((item) => (item.id === task.id ? task : item))
          : [task, ...state.tasks],
      };
    }),
}));

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

export function validateScheduledTaskInput(
  input: ScheduledTaskInput,
  t: TranslateFn,
): string | null {
  if (!input.title.trim()) return t("schedule.validation.titleRequired");
  if (!input.prompt.trim()) return t("schedule.validation.promptRequired");
  if (!input.providerId) return t("schedule.validation.agentRequired");
  if (!isValidSchedule(input.schedule)) return t("schedule.validation.incomplete");
  if (input.enabled && computeNextRunAt(input.schedule, Date.now()) == null) {
    return t("schedule.validation.future");
  }
  return null;
}

export function formatDateInput(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatTimeInput(date = new Date()): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

export function formatSchedule(schedule: ScheduledTaskSchedule, t: TranslateFn): string {
  switch (schedule.type) {
    case "once":
      return `${schedule.date} ${schedule.time}`;
    case "daily":
      return t("schedule.format.daily", { time: schedule.time });
    case "weekly":
      return t("schedule.format.weekly", {
        days: schedule.weekdays.map((day) => t(weekdayLabelKey(day))).join(", "),
        time: schedule.time,
      });
    case "interval":
      return t("schedule.format.interval", { minutes: schedule.intervalMinutes });
  }
}

export const WEEKDAY_LABEL_KEYS = [
  "schedule.weekday.sun",
  "schedule.weekday.mon",
  "schedule.weekday.tue",
  "schedule.weekday.wed",
  "schedule.weekday.thu",
  "schedule.weekday.fri",
  "schedule.weekday.sat",
] as const;

function scheduleApi() {
  const api = desktopApi()?.scheduledTasks;
  if (!api) throw new Error("Scheduled tasks require an AGUI runtime connection.");
  return api;
}

function weekdayLabelKey(day: number): string {
  return WEEKDAY_LABEL_KEYS[day] ?? WEEKDAY_LABEL_KEYS[0];
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
