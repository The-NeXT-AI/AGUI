import { useEffect, useRef } from "react";
import { CalendarClock, Plus } from "lucide-react";
import {
  ScheduledTasksSection,
  type ScheduledTasksSectionHandle,
} from "@/schedule/ScheduledTasksSection";
import { useT } from "@/lib/i18n";
import { useUIStore } from "@/ui/ui-store";

export function SchedulePage() {
  const t = useT();
  const sectionRef = useRef<ScheduledTasksSectionHandle>(null);
  const draftRequest = useUIStore((state) => state.scheduleTaskDraftRequest);

  useEffect(() => {
    if (!draftRequest) return;
    sectionRef.current?.startCreate({
      providerId: draftRequest.providerId,
      projectPath: draftRequest.projectPath,
      prompt: draftRequest.prompt,
      title: draftRequest.title,
      workspaceId: draftRequest.workspaceId,
    });
  }, [draftRequest]);

  return (
    <div className="bg-canvas flex min-h-0 flex-1 flex-col">
      <header className="app-titlebar app-titlebar-right-drawer-inset electron-drag-region border-border-subtle flex h-[var(--titlebar-height)] shrink-0 items-center border-b pl-3 sm:pl-4">
        <div className="flex min-w-0 items-center gap-2">
          <CalendarClock size={16} className="text-muted shrink-0" />
          <h1 className="text-fg truncate text-[14px] leading-none font-semibold">
            {t("settings.section.schedule")}
          </h1>
        </div>
        <button
          type="button"
          onClick={() => sectionRef.current?.startCreate()}
          className="ui-button ml-auto h-10 shrink-0 sm:h-8"
        >
          <Plus size={14} />
          {t("schedule.newTask")}
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-3xl px-4 py-5 sm:px-8 sm:py-8">
          <ScheduledTasksSection ref={sectionRef} showHeading={false} showCreateButton={false} />
        </div>
      </div>
    </div>
  );
}
