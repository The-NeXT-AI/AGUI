import { type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileCode2,
  LoaderCircle,
  Terminal as TerminalIcon,
  Wrench,
} from "lucide-react";
import { useChatStore } from "@/chat/chat-store";
import type { ChatBlock, ToolStatus } from "@/chat/types";
import { useT } from "@/lib/i18n";
import { useDetailPanelProjectContext } from "@/shell/detail-panel-project-context";

const EMPTY: ChatBlock[] = [];
type ActivityBlock =
  | Extract<ChatBlock, { kind: "diff" }>
  | Extract<ChatBlock, { kind: "terminal" }>
  | Extract<ChatBlock, { kind: "tool" }>;

/**
 * Detail panel: a live ledger of the active session's work — file changes and
 * commands the agent has run. Mirrors the inline diff/terminal blocks but as a
 * compact, always-on overview docked beside the conversation.
 */
export function ActivityPanel() {
  const t = useT();
  const projectContext = useDetailPanelProjectContext();
  const activeSessionId = useChatStore((state) => state.activeSessionId);
  const sessionId = projectContext?.activeSessionId ?? activeSessionId;
  useChatStore((state) => activitySignature(state, sessionId));
  const blocks = selectActivityBlocks(sessionId);

  const changes = blocks.filter(
    (b): b is Extract<ChatBlock, { kind: "diff" }> => b.kind === "diff",
  );
  const commands = blocks.filter(
    (b): b is Extract<ChatBlock, { kind: "terminal" }> => b.kind === "terminal",
  );
  const tools = blocks.filter((b): b is Extract<ChatBlock, { kind: "tool" }> => b.kind === "tool");

  const isEmpty = changes.length === 0 && commands.length === 0 && tools.length === 0;

  return (
    <div className="px-2 pb-2">
      {isEmpty ? (
        <p className="text-subtle px-2 py-6 text-center text-[13px]">{t("activity.empty")}</p>
      ) : null}

      {changes.length > 0 ? (
        <Section title={t("activity.changes")} count={changes.length}>
          {changes.map((b) => (
            <div key={b.id} className="text-muted flex items-center gap-2.5 rounded-lg px-2 py-1.5">
              <FileCode2 size={14} className="text-info shrink-0" />
              <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{b.path}</span>
              <StatusDot status={b.status} />
            </div>
          ))}
        </Section>
      ) : null}

      {commands.length > 0 ? (
        <Section title={t("activity.commands")} count={commands.length}>
          {commands.map((b) => (
            <div key={b.id} className="text-muted flex items-center gap-2.5 rounded-lg px-2 py-1.5">
              <TerminalIcon size={14} className="text-info shrink-0" />
              <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{b.command}</span>
              <StatusDot status={b.status} />
            </div>
          ))}
        </Section>
      ) : null}

      {tools.length > 0 ? (
        <Section title={t("activity.tools")} count={tools.length}>
          {tools.map((block) => (
            <div
              key={block.id}
              className="text-muted flex items-center gap-2.5 rounded-lg px-2 py-1.5"
            >
              <Wrench size={14} className="text-info shrink-0" />
              <span className="min-w-0 flex-1 truncate text-[12px]">{block.title}</span>
              <StatusDot status={block.status} />
            </div>
          ))}
        </Section>
      ) : null}
    </div>
  );
}

function selectActivityBlocks(sessionId: string | null): ActivityBlock[] {
  const state = useChatStore.getState();
  const session = state.sessions.find((item) => item.id === sessionId);
  return (session?.blocks ?? EMPTY).filter(
    (block): block is ActivityBlock =>
      block.kind === "diff" || block.kind === "terminal" || block.kind === "tool",
  );
}

function activitySignature(
  state: ReturnType<typeof useChatStore.getState>,
  sessionId: string | null,
): string {
  const session = state.sessions.find((item) => item.id === sessionId);
  return JSON.stringify(
    (session?.blocks ?? EMPTY)
      .filter(
        (block) => block.kind === "diff" || block.kind === "terminal" || block.kind === "tool",
      )
      .map((block) => {
        if (block.kind === "diff")
          return [block.kind, block.id, block.path, block.status, block.review];
        if (block.kind === "terminal")
          return [block.kind, block.id, block.command, block.cwd, block.status];
        return [
          block.kind,
          block.id,
          block.title,
          block.toolKind,
          block.status,
          block.locations?.length ?? 0,
        ];
      }),
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <div className="mb-1">
      <div className="text-subtle flex items-center gap-2 px-2 py-1.5 text-[12px] font-medium">
        {title}
        <span className="text-[11px] opacity-70">{count}</span>
      </div>
      {children}
    </div>
  );
}

function StatusDot({ status }: { status: ToolStatus }) {
  if (status === "success") return <CheckCircle2 size={14} className="text-success shrink-0" />;
  if (status === "error") return <AlertTriangle size={13} className="text-danger shrink-0" />;
  return <LoaderCircle size={14} className="text-subtle shrink-0 animate-spin" />;
}
