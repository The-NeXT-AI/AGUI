import { useEffect, useState } from "react";
import { useMemo } from "react";
import {
  AlertTriangle,
  FileCode2,
  Loader2,
  MessageSquareText,
  Server,
  TerminalSquare,
} from "lucide-react";
import { desktopApi, type ResolvedAgentContributions } from "@/asp/desktop-api";
import { useAspStore } from "@/asp/asp-store";
import { useExtensionStore } from "@/extensions/extension-store";
import { cn } from "@/ui/cn";
import { useT } from "@/lib/i18n";

const EMPTY: ResolvedAgentContributions = {
  extensionIds: [],
  mcpServers: [],
  skills: [],
  prompts: [],
  warnings: [],
};

export function McpPanel({ settings = false }: { settings?: boolean }) {
  const t = useT();
  const workspacePath = useAspStore((state) => state.workspacePath);
  const records = useExtensionStore((state) => state.records);
  const extensionWorkspaceId = useExtensionStore((state) => state.workspaceId);
  const disabledMcpServers = useExtensionStore((state) => state.disabledMcpServers);
  const disabledSkills = useExtensionStore((state) => state.disabledSkills);
  const disabledPrompts = useExtensionStore((state) => state.disabledPrompts);
  const selectedPrompts = useExtensionStore((state) => state.selectedPrompts);
  const setMcpServerEnabled = useExtensionStore((state) => state.setMcpServerEnabled);
  const setSkillEnabled = useExtensionStore((state) => state.setSkillEnabled);
  const setPromptEnabled = useExtensionStore((state) => state.setPromptEnabled);
  const setPromptSelected = useExtensionStore((state) => state.setPromptSelected);
  const [resources, setResources] = useState(EMPTY);
  const [loading, setLoading] = useState(false);
  const resourceKey = useMemo(
    () =>
      JSON.stringify(
        records.map((record) => ({
          id: record.id,
          version: record.manifest.version,
          enabled: record.enabled,
          blocked: record.state === "blocked",
          grants: record.grantedPermissions,
          skills: record.manifest.contributes?.skills,
          mcpServers: record.manifest.contributes?.mcpServers,
          prompts: record.manifest.contributes?.prompts,
        })),
      ),
    [records],
  );
  useEffect(() => {
    let canceled = false;
    const api = desktopApi()?.extensions;
    if (!api || !workspacePath) {
      setResources(EMPTY);
      return undefined;
    }
    setLoading(true);
    void api
      .resolveAgentContributions({
        workspacePath,
        workspaceId: extensionWorkspaceId,
      })
      .then(
        (value) => {
          if (!canceled) setResources(value);
        },
        (cause) => {
          if (!canceled)
            setResources({
              ...EMPTY,
              warnings: [cause instanceof Error ? cause.message : String(cause)],
            });
        },
      )
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [extensionWorkspaceId, resourceKey, workspacePath]);

  return (
    <div className={settings ? "flex flex-col gap-5" : "h-full overflow-auto px-3 pb-3"}>
      <div className={cn(!settings && "py-2")}>
        {settings ? (
          <h2 className="text-fg text-[18px] font-semibold">{t("agentTools.title")}</h2>
        ) : null}
        <p className="text-muted text-[12px]">{t("agentTools.description")}</p>
      </div>

      {loading ? (
        <div className="text-subtle flex items-center gap-2 text-[12px]">
          <Loader2 size={13} className="animate-spin" /> {t("agentTools.resolving")}
        </div>
      ) : null}
      {!workspacePath ? (
        <p
          className={
            settings
              ? "border-border-subtle text-subtle border-y py-3 text-[12px]"
              : "bg-surface text-subtle rounded-lg p-3 text-[12px]"
          }
        >
          {t("agentTools.selectProject")}
        </p>
      ) : null}

      {resources.warnings.map((warning) => (
        <div
          key={warning}
          className={cn(
            "text-warning flex items-start gap-2 text-[11px]",
            settings
              ? "border-warning border-l-2 pl-3"
              : "border-warning/30 bg-warning/5 rounded-lg border p-2.5",
          )}
        >
          <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {warning}
        </div>
      ))}

      <ResourceGroup
        title={t("agentTools.mcpServers")}
        empty={t("agentTools.noMcpServers")}
        settings={settings}
      >
        {resources.mcpServers.map((server) => {
          const enabled = !disabledMcpServers.includes(server.id);
          return (
            <ResourceRow
              key={server.id}
              resourceId={server.id}
              resourceType="mcp"
              icon={server.command ? TerminalSquare : Server}
              title={server.name}
              subtitle={
                server.command
                  ? [server.command, ...(server.args ?? [])].join(" ")
                  : server.url || server.id
              }
              source={server.extensionId}
              enabled={enabled}
              settings={settings}
              onToggle={() => setMcpServerEnabled(server.id, !enabled)}
            />
          );
        })}
      </ResourceGroup>

      <ResourceGroup
        title={t("agentTools.skills")}
        empty={t("agentTools.noSkills")}
        settings={settings}
      >
        {resources.skills.map((skill) => {
          const enabled = !disabledSkills.includes(skill.id);
          return (
            <ResourceRow
              key={skill.id}
              resourceId={skill.id}
              resourceType="skill"
              icon={FileCode2}
              title={skill.name}
              subtitle={skill.description || skill.manifestPath}
              source={skill.extensionId}
              enabled={enabled}
              settings={settings}
              onToggle={() => setSkillEnabled(skill.id, !enabled)}
            />
          );
        })}
      </ResourceGroup>

      <ResourceGroup
        title={t("agentTools.prompts")}
        empty={t("agentTools.noPrompts")}
        settings={settings}
      >
        {resources.prompts.map((prompt) => {
          const enabled = prompt.autoInclude
            ? !disabledPrompts.includes(prompt.id)
            : selectedPrompts.includes(prompt.id);
          return (
            <ResourceRow
              key={prompt.id}
              resourceId={prompt.id}
              resourceType="prompt"
              icon={MessageSquareText}
              title={prompt.title}
              subtitle={
                prompt.description ||
                (prompt.autoInclude
                  ? t("agentTools.autoPrompt")
                  : enabled
                    ? t("agentTools.selectedPrompt")
                    : t("agentTools.availablePrompt"))
              }
              source={prompt.extensionId}
              enabled={enabled}
              settings={settings}
              onToggle={() =>
                prompt.autoInclude
                  ? setPromptEnabled(prompt.id, !enabled)
                  : setPromptSelected(prompt.id, !enabled)
              }
            />
          );
        })}
      </ResourceGroup>
    </div>
  );
}

function ResourceGroup({
  title,
  empty,
  settings,
  children,
}: {
  title: string;
  empty: string;
  settings: boolean;
  children: React.ReactNode;
}) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <section>
      <h3 className="text-subtle mb-1.5 text-[11px] font-semibold tracking-wide uppercase">
        {title}
      </h3>
      <div
        className={
          settings
            ? "divide-border-subtle border-border-subtle divide-y border-y"
            : "flex flex-col gap-1.5"
        }
      >
        {hasChildren ? (
          children
        ) : (
          <p
            className={
              settings
                ? "text-subtle py-3 text-[12px]"
                : "bg-surface/60 text-subtle rounded-lg p-3 text-[12px]"
            }
          >
            {empty}
          </p>
        )}
      </div>
    </section>
  );
}

function ResourceRow({
  resourceId,
  resourceType,
  icon: Icon,
  title,
  subtitle,
  source,
  enabled,
  settings,
  onToggle,
}: {
  resourceId: string;
  resourceType: "mcp" | "skill" | "prompt";
  icon: typeof Server;
  title: string;
  subtitle: string;
  source: string;
  enabled: boolean;
  settings: boolean;
  onToggle(): void;
}) {
  const t = useT();
  return (
    <div
      data-agent-resource-id={resourceId}
      data-agent-resource-type={resourceType}
      data-agent-resource-enabled={enabled ? "true" : "false"}
      className={
        settings
          ? "flex items-start gap-2.5 py-2.5"
          : "border-border-subtle bg-surface/50 flex items-start gap-2.5 rounded-lg border p-2.5"
      }
    >
      <Icon size={14} className={enabled ? "text-success mt-0.5" : "text-subtle mt-0.5"} />
      <div className="min-w-0 flex-1">
        <div className="text-fg text-[12px] font-medium">{title}</div>
        <div className="text-subtle truncate font-mono text-[10px]" title={subtitle}>
          {subtitle}
        </div>
        <div className="text-subtle mt-0.5 text-[9px]">{source}</div>
      </div>
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "mt-0.5 h-5 w-9 rounded-full border p-0.5 transition-colors",
          enabled ? "border-success/50 bg-success/25" : "border-border bg-surface-hover",
        )}
        aria-label={
          enabled ? t("agentTools.disable", { title }) : t("agentTools.enable", { title })
        }
      >
        <span
          className={cn(
            "bg-fg block h-3.5 w-3.5 rounded-full transition-transform",
            enabled && "translate-x-3.5",
          )}
        />
      </button>
    </div>
  );
}
