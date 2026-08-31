import { desktopApi, type ScheduledTaskEvent } from "@/asp/desktop-api";
import { useChatStore } from "@/chat/chat-store";
import { useScheduledTaskStore } from "./scheduled-task-store";

export function installScheduledTaskBridge(): () => void {
  const api = desktopApi();
  if (!api) return () => undefined;
  void useScheduledTaskStore
    .getState()
    .refresh()
    .catch(() => undefined);
  return api.onScheduledTaskEvent((event) => {
    handleScheduledTaskEvent(event);
  });
}

function handleScheduledTaskEvent(event: ScheduledTaskEvent): void {
  const schedule = useScheduledTaskStore.getState();
  switch (event.type) {
    case "tasks_updated":
      schedule.replaceTasks(event.tasks);
      return;
    case "run_started":
      useChatStore.getState().ensureScheduledTaskSession({
        createdAt: event.session.createdAt,
        cwd: event.session.cwd,
        projectPath: event.session.projectPath,
        providerId: event.session.providerId,
        sessionId: event.session.id,
        title: event.session.title,
        workspaceId: event.session.workspaceId,
      });
      schedule.upsertTask(event.task);
      return;
    case "run_finished":
      if (event.task) schedule.upsertTask(event.task);
      return;
  }
}
