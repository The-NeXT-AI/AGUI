import {
  desktopApi,
  type AgentTaskNotificationInput,
  type AgentTaskNotificationOpen,
} from "@/asp/desktop-api";
import { t } from "@/lib/i18n";

let browserNotificationPermission: Promise<NotificationPermission> | undefined;
const browserTaskOpeners = new Set<(sessionId: string) => void>();

export function notifyAgentTaskCompleted(input: AgentTaskNotificationInput): void {
  notifyAgentTask({
    sessionId: input.sessionId,
    title: t("notification.taskCompleted"),
    body: input.body || input.title,
  });
}

export function notifyAgentNeedsInput(input: AgentTaskNotificationInput): void {
  notifyAgentTask({
    sessionId: input.sessionId,
    title: input.title || t("question.title"),
    body: input.body,
  });
}

function notifyAgentTask(input: AgentTaskNotificationInput): void {
  const api = desktopApi();
  if (api?.transport === "electron" && api.notifications) {
    void api.notifications
      .taskCompleted({
        sessionId: input.sessionId,
        title: input.title,
        body: input.body,
      })
      .catch(() => undefined);
    return;
  }
  void showBrowserTaskNotification(input);
}

export function requestBrowserTaskNotificationPermission(): void {
  const api = desktopApi();
  if (api?.transport === "electron" || !supportsBrowserNotifications()) return;
  if (Notification.permission !== "default") return;
  browserNotificationPermission ??= Notification.requestPermission().finally(() => {
    browserNotificationPermission = undefined;
  });
}

export function installAgentTaskNotificationNavigation(
  openSession: (sessionId: string) => void,
): () => void {
  browserTaskOpeners.add(openSession);
  const api = desktopApi();
  const notifications = api?.notifications;
  if (api?.transport !== "electron" || !notifications) {
    return () => {
      browserTaskOpeners.delete(openSession);
    };
  }

  const open = (payload: AgentTaskNotificationOpen) => {
    if (isAgentTaskNotificationOpen(payload)) openSession(payload.sessionId);
  };
  const drain = () => {
    void notifications
      .consumeTaskOpens()
      .then((payloads) => payloads.forEach(open))
      .catch(() => undefined);
  };
  const removeListener = notifications.onTaskOpen(drain);
  drain();
  return () => {
    browserTaskOpeners.delete(openSession);
    removeListener();
  };
}

async function showBrowserTaskNotification(input: AgentTaskNotificationInput): Promise<void> {
  if (!supportsBrowserNotifications()) return;
  const permission = await browserNotificationPermissionState();
  if (permission !== "granted") return;

  const notification = new Notification(input.title || "Agent task", {
    body: input.body,
    tag: `agui-task-${input.sessionId}`,
  });
  notification.onclick = () => {
    window.focus();
    notification.close();
    for (const open of browserTaskOpeners) open(input.sessionId);
  };
}

async function browserNotificationPermissionState(): Promise<NotificationPermission> {
  if (!supportsBrowserNotifications()) return "denied";
  if (Notification.permission !== "default") return Notification.permission;
  browserNotificationPermission ??= Notification.requestPermission().finally(() => {
    browserNotificationPermission = undefined;
  });
  return browserNotificationPermission;
}

function supportsBrowserNotifications(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

function isAgentTaskNotificationOpen(value: unknown): value is AgentTaskNotificationOpen {
  if (!value || typeof value !== "object") return false;
  const sessionId = (value as { sessionId?: unknown }).sessionId;
  return typeof sessionId === "string" && sessionId.length > 0;
}
