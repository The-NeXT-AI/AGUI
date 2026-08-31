import { ChevronRight, LoaderCircle } from "lucide-react";
import { AgentLogo } from "@/asp/AgentLogo";
import { cn } from "@/ui/cn";
import { useT } from "@/lib/i18n";
import { ProjectSessionItems } from "./ProjectSessionItems";
import type { ImportAgentGroup, ImportableProviderSession } from "./session-panel-model";

export function ImportAgentSection({
  group,
  onImport,
  onToggle,
  open,
}: {
  group: ImportAgentGroup;
  onImport: (session: ImportableProviderSession) => void;
  onToggle: () => void;
  open: boolean;
}) {
  const t = useT();
  const sessionCount = group.sessions.length;
  return (
    <div className="border-border-subtle bg-surface/40 rounded-md border">
      <button
        type="button"
        onClick={onToggle}
        className="hover:bg-surface-hover flex w-full items-center gap-2 px-3 py-2 text-left transition-colors"
      >
        <ChevronRight
          size={14}
          className={cn("text-subtle shrink-0 transition-transform", open && "rotate-90")}
        />
        <AgentLogo provider={group.provider} compact className="border-border-strong h-4 w-4" />
        <span className="text-fg min-w-0 flex-1 truncate text-[13.5px] font-medium">
          {group.provider.name}
        </span>
        {group.loading ? (
          <LoaderCircle size={13} className="text-info shrink-0 animate-spin" />
        ) : (
          <span className="text-subtle shrink-0 text-[12px]">
            {group.error
              ? t("common.unavailable")
              : t("sessions.import.agentSessions", { count: sessionCount })}
          </span>
        )}
      </button>
      <ProjectSessionItems collapsed={!open}>
        <div className="border-border-subtle border-t px-3 py-2">
          {group.loading ? (
            <div className="text-muted flex items-center gap-2 py-2 text-[13px]">
              <LoaderCircle size={13} className="text-info animate-spin" />
              {t("common.loadingSessions")}
            </div>
          ) : group.error ? (
            <div className="text-muted py-2 text-[13px] leading-5">{group.error}</div>
          ) : group.sessions.length === 0 ? (
            <div className="text-muted py-2 text-[13px]">{t("sessions.import.noSessions")}</div>
          ) : (
            <div className="flex flex-col gap-1">
              {group.sessions.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => onImport(session)}
                  className="hover:bg-surface-hover flex w-full items-center rounded-md px-2 py-2 text-left transition-colors"
                >
                  <span className="text-fg min-w-0 flex-1 truncate text-[13.5px] font-medium">
                    {session.title || session.id}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </ProjectSessionItems>
    </div>
  );
}
