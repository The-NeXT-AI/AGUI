import { useEffect, useMemo, useRef, useState } from "react";
import {
  FileJson,
  Import as ImportIcon,
  Loader2,
  Pencil,
  Plus,
  TestTube2,
  Trash2,
} from "lucide-react";
import { AgentLogo } from "@/asp/AgentLogo";
import { useAspStore } from "@/asp/asp-store";
import {
  desktopApi,
  type AspModel,
  type AspProvider,
  type AspProviderCapabilities,
  type DetectedAgentCli,
  type ProviderTestResult,
} from "@/asp/desktop-api";
import { cn } from "@/ui/cn";
import { confirmDialog } from "@/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { toast } from "@/ui/toast";
import { Tip } from "@/ui/tooltip";
import { t as translateText, useT } from "@/lib/i18n";
import { TextInput } from "./settings-fields";
import { isPlainRecord, parseJsonArray, parseJsonObject, stringFromUnknown } from "./settings-json";

const AGENT_CLI_MODES = ["manual", "agui"] as const;
type AgentCliManagement = (typeof AGENT_CLI_MODES)[number];
type EnvironmentVariableRow = {
  id: string;
  key: string;
  value: string;
};

let environmentVariableRowSequence = 0;

type AgentTemplate = {
  args?: string[];
  capabilities?: AspProviderCapabilities;
  command: string;
  description?: string;
  descriptionKey?: string;
  id: string;
  installCommand?: string;
  label: string;
  models?: AspModel[];
  nameKey?: string;
};

const REASONING_EFFORTS: NonNullable<AspProviderCapabilities["reasoningEfforts"]> = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const NATIVE_CONTENT_PARTS: NonNullable<AspProviderCapabilities["contentParts"]> = [
  "text",
  "tool",
  "reasoning",
  "status",
  "resource",
  "artifact",
  "diff",
  "raw",
];

const ADVANCED_CONTENT_PARTS: NonNullable<AspProviderCapabilities["contentParts"]> = [
  "text",
  "tool",
  "reasoning",
  "plan",
  "status",
  "resource",
  "artifact",
  "diff",
  "raw",
];

const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: "custom",
    label: "Custom ASP",
    nameKey: "settings.agents.customAgent",
    command: "",
    capabilities: genericAspCapabilities(),
  },
  {
    id: "codex",
    label: "Codex",
    command: "codex",
    descriptionKey: "settings.agents.template.codexDescription",
    description:
      "Runs Codex as a native Agent Server Protocol provider backed by codex app-server.",
    installCommand: "npm install -g @openai/codex@latest",
    capabilities: {
      approvalModes: ["request", "auto", "full"],
      approvalScopes: ["command", "filesystem", "network", "tool"],
      contentParts: NATIVE_CONTENT_PARTS,
      deleteSession: true,
      diffs: true,
      humanInput: true,
      models: true,
      reasoningEfforts: REASONING_EFFORTS,
      resumeSession: true,
      runtimeAdapter: "codex-app-server",
      sessionHistory: true,
      sessions: true,
      toolEvents: true,
      transports: ["stdio"],
      wireProtocol: "codex-app-server",
      workspace: true,
    },
    models: [
      {
        id: "gpt-5-codex",
        model: "gpt-5-codex",
        displayName: "GPT-5",
        isDefault: true,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: REASONING_EFFORTS,
        supportedSpeeds: ["default", "fast"],
      },
    ],
  },
  {
    id: "claude-code",
    label: "Claude Code",
    command: "claude",
    descriptionKey: "settings.agents.template.claudeCodeDescription",
    description:
      "Runs Claude Code as a native Agent Server Protocol provider backed by its stream-json SDK protocol.",
    installCommand: "npm install -g @anthropic-ai/claude-code@latest",
    capabilities: {
      approvalModes: ["request", "auto", "full"],
      approvalScopes: ["command", "filesystem", "network", "tool"],
      contentParts: NATIVE_CONTENT_PARTS,
      deleteSession: true,
      diffs: true,
      humanInput: true,
      models: true,
      reasoningEfforts: REASONING_EFFORTS,
      resumeSession: true,
      runtimeAdapter: "claude-code-stream-json",
      sessionHistory: true,
      sessions: true,
      toolEvents: true,
      transports: ["stdio"],
      wireProtocol: "claude-code-stream-json",
      workspace: true,
    },
  },
  {
    id: "opencode",
    label: "OpenCode",
    command: "opencode",
    descriptionKey: "settings.agents.template.opencodeDescription",
    description:
      "Runs OpenCode as a native Agent Server Protocol provider backed by opencode serve.",
    installCommand: "npm install -g opencode-ai@latest",
    capabilities: {
      approvalModes: ["request", "auto", "full"],
      approvalScopes: ["command", "filesystem", "network", "tool"],
      contentParts: ADVANCED_CONTENT_PARTS,
      diffs: true,
      humanInput: true,
      models: true,
      resumeSession: true,
      runtimeAdapter: "opencode-server",
      sessionHistory: true,
      sessions: true,
      toolEvents: true,
      transports: ["stdio"],
      wireProtocol: "opencode-http-sse",
      workspace: true,
    },
  },
  {
    id: "pi",
    label: "Pi",
    command: "pi",
    descriptionKey: "settings.agents.template.piDescription",
    description: "Runs Pi as a native Agent Server Protocol provider backed by pi rpc mode.",
    capabilities: {
      approvalModes: ["request", "auto", "full"],
      approvalScopes: ["command", "filesystem", "network", "tool"],
      contentParts: ["text", "tool", "reasoning", "status", "raw"],
      humanInput: true,
      models: true,
      reasoningEfforts: REASONING_EFFORTS,
      runtimeAdapter: "pi-rpc",
      sessionHistory: false,
      sessions: false,
      toolEvents: true,
      transports: ["stdio"],
      wireProtocol: "pi-rpc-jsonl",
      workspace: true,
    },
  },
  {
    id: "kimi",
    label: "Kimi",
    command: "kimi",
    descriptionKey: "settings.agents.template.kimiDescription",
    description: "Runs Kimi through its native headless CLI stream.",
    capabilities: headlessCliCapabilities("kimi-cli", "kimi-stream-json"),
  },
  {
    id: "kilo",
    label: "Kilo",
    command: "kilo",
    descriptionKey: "settings.agents.template.kiloDescription",
    description: "Runs Kilo as an ASP stdio provider.",
    capabilities: genericAspCapabilities(),
  },
  {
    id: "grok",
    label: "Grok",
    command: "grok",
    descriptionKey: "settings.agents.template.grokDescription",
    description: "Runs Grok through its native headless CLI stream.",
    capabilities: headlessCliCapabilities("grok-cli", "grok-streaming-messages-json"),
  },
];

export function AgentsSection() {
  const t = useT();
  const providers = useAspStore((state) => state.providers);
  const refreshProviders = useAspStore((state) => state.refreshProviders);
  const saveProvider = useAspStore((state) => state.saveProvider);
  const removeProvider = useAspStore((state) => state.removeProvider);
  const cliFileInputRef = useRef<HTMLInputElement>(null);
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AspProvider>(() => emptyProvider());
  const [selectedTemplateId, setSelectedTemplateId] = useState("custom");
  const [cliManagement, setCliManagement] = useState<AgentCliManagement>("manual");
  const [environmentRows, setEnvironmentRows] = useState<EnvironmentVariableRow[]>(() =>
    environmentRowsFromRecord(draft.env),
  );
  const [capabilitiesText, setCapabilitiesText] = useState(() =>
    JSON.stringify(draft.capabilities ?? {}, null, 2),
  );
  const [modelsText, setModelsText] = useState(() => JSON.stringify(draft.models ?? [], null, 2));
  const [dialogStatus, setDialogStatus] = useState("");
  const [detectingAgents, setDetectingAgents] = useState(false);
  const [testing, setTesting] = useState(false);

  const parsedEnvironment = useMemo(() => environmentFromRows(environmentRows), [environmentRows]);
  const parsedCapabilities = useMemo(
    () => parseProviderCapabilities(capabilitiesText),
    [capabilitiesText],
  );
  const parsedModels = useMemo(() => parseProviderModels(modelsText), [modelsText]);
  const validationMessage = useMemo(
    () =>
      validateAgentDraft(
        draft,
        parsedEnvironment,
        parsedCapabilities,
        parsedModels,
        cliManagement,
        t,
      ),
    [draft, parsedEnvironment, parsedCapabilities, parsedModels, cliManagement, t],
  );
  const dialogOpen = editingProviderId !== null;
  const editingExisting = editingProviderId !== "new";
  const canRemoveDraft = dialogOpen && editingExisting;
  const cliPathSelectable =
    (draft.transport === "stdio" || draft.transport === "persistent-stdio") &&
    cliManagement === "manual" &&
    Boolean(window.agentDesktop);

  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  const setDraftFields = (next: AspProvider) => {
    setDraft(next);
    setEnvironmentRows(environmentRowsFromRecord(next.env));
    setCapabilitiesText(JSON.stringify(next.capabilities ?? {}, null, 2));
    setModelsText(JSON.stringify(next.models ?? [], null, 2));
  };

  const openAgentDialog = (provider?: AspProvider) => {
    const next = provider ?? emptyProvider();
    const nextTemplateId = agentTemplateIdForProvider(next);
    const nextCliManagement = agentCliManagementForProvider(next);
    setEditingProviderId(provider ? provider.id : "new");
    setSelectedTemplateId(nextTemplateId);
    setCliManagement(nextCliManagement);
    setDraftFields(next);
    setDialogStatus("");
    setTesting(false);
  };

  const closeAgentDialog = () => {
    setEditingProviderId(null);
    setDialogStatus("");
    setTesting(false);
  };

  const applyAgentTemplate = (templateId: string) => {
    const template = agentTemplateById(templateId);
    const next = providerFromAgentTemplate(template, cliManagement, {
      enabled: draft.enabled,
      id: editingExisting ? draft.id : uniqueAgentId(template.id, providers),
    });
    setSelectedTemplateId(template.id);
    setDraftFields(next);
  };

  const chooseCliPath = () => {
    if (!cliPathSelectable) return;
    cliFileInputRef.current?.click();
  };

  const applyChosenCliFile = (file: File | undefined) => {
    const path = file ? desktopApi()?.files.getPath(file) : "";
    if (!path) return;
    setCliManagement("manual");
    setDraft((current) => ({ ...current, command: path, installCommand: undefined }));
    if (cliFileInputRef.current) cliFileInputRef.current.value = "";
  };

  const importDetectedAgents = async () => {
    const api = desktopApi();
    if (!api) {
      toast.error(t("settings.agents.detect.desktopOnly"));
      return;
    }
    setDetectingAgents(true);
    try {
      const detected = await api.providers.detect();
      if (!detected.length) {
        toast.info(t("settings.agents.detect.none"));
        return;
      }

      const available = detected.filter((item) => !item.error && item.path.trim());
      if (!available.length) {
        const unavailable = detected[0]!;
        toast.error(
          t("settings.agents.detect.unavailable", { name: unavailable.name }),
          unavailable.error,
        );
        return;
      }

      let nextProviders = [...providers];
      let importedCount = 0;
      for (const detectedAgent of available) {
        if (
          nextProviders.some((provider) => providerMatchesDetectedAgent(provider, detectedAgent))
        ) {
          continue;
        }
        const template = agentTemplateById(detectedAgent.id);
        const saved = await saveProvider({
          ...providerFromAgentTemplate(template, "manual", {
            enabled: true,
            id: uniqueAgentId(template.id, nextProviders),
          }),
          command: detectedAgent.path,
          installCommand: undefined,
        });
        nextProviders = [...nextProviders, saved];
        importedCount += 1;
      }

      if (importedCount > 0) {
        toast.success(t("settings.agents.detect.imported", { count: importedCount }));
      } else {
        toast.info(t("settings.agents.detect.alreadyImported"));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setDetectingAgents(false);
    }
  };

  const save = async () => {
    if (validationMessage) {
      setDialogStatus(validationMessage);
      return;
    }
    if (parsedEnvironment instanceof Error) {
      setDialogStatus(parsedEnvironment.message);
      return;
    }
    if (parsedCapabilities instanceof Error) {
      setDialogStatus(parsedCapabilities.message);
      return;
    }
    if (parsedModels instanceof Error) {
      setDialogStatus(parsedModels.message);
      return;
    }
    try {
      const saved = await saveProvider(
        providerFromAgentDraft(draft, parsedEnvironment, parsedCapabilities, parsedModels),
      );
      closeAgentDialog();
      toast.success(t("settings.agents.saved", { name: saved.name }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const test = async () => {
    if (validationMessage) {
      setDialogStatus(validationMessage);
      return;
    }
    if (parsedEnvironment instanceof Error) {
      setDialogStatus(parsedEnvironment.message);
      return;
    }
    if (parsedCapabilities instanceof Error) {
      setDialogStatus(parsedCapabilities.message);
      return;
    }
    if (parsedModels instanceof Error) {
      setDialogStatus(parsedModels.message);
      return;
    }
    const api = desktopApi();
    if (!api) {
      toast.error(t("settings.agents.test.desktopOnly"));
      return;
    }
    setTesting(true);
    setDialogStatus("");
    toast.info(t("settings.agents.test.querying"), draft.name);
    try {
      const result: ProviderTestResult = await api.providers.test({
        ...providerFromAgentDraft(draft, parsedEnvironment, parsedCapabilities, parsedModels),
      });
      if (result.ok) {
        setCapabilitiesText(JSON.stringify(result.capabilities, null, 2));
        if (result.models.length) {
          setModelsText(JSON.stringify(result.models, null, 2));
        }
        toast.success(
          t("settings.agents.test.connected", {
            count: result.models.length,
            name: draft.name,
            version: result.protocolVersion,
          }),
        );
      } else {
        toast.error(result.error || t("common.unavailable"));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  };

  const remove = async (provider: AspProvider) => {
    const confirmed = await confirmDialog({
      title: t("settings.agents.removeTitle"),
      description: t("settings.agents.removeConfirm", { name: provider.name }),
      confirmLabel: t("common.remove"),
      tone: "danger",
    });
    if (!confirmed) return;
    try {
      await removeProvider(provider.id);
      if (editingProviderId === provider.id) closeAgentDialog();
      toast.success(t("settings.agents.removed", { name: provider.name }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-fg text-[18px] font-semibold">{t("settings.section.agents")}</h2>
          <p className="text-muted mt-1 text-[13px]">{t("settings.agents.description")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => openAgentDialog()}
            className="ui-icon-button border-border h-8 w-8 border"
            title={t("settings.agents.add")}
            aria-label={t("settings.agents.add")}
          >
            <Plus size={14} />
          </button>
          <Tip label={t("settings.agents.detect.importLocal")} closeOnClick={false}>
            <button
              type="button"
              onClick={() => void importDetectedAgents()}
              disabled={detectingAgents}
              className="ui-icon-button border-border h-8 w-8 border disabled:cursor-not-allowed disabled:opacity-50"
              aria-label={
                detectingAgents
                  ? t("settings.agents.detect.detecting")
                  : t("settings.agents.detect.importLocal")
              }
              aria-busy={detectingAgents}
            >
              {detectingAgents ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <ImportIcon size={14} />
              )}
            </button>
          </Tip>
        </div>
      </div>

      {providers.length ? (
        <div className="ui-soft-card overflow-hidden rounded-[8px]">
          {providers.map((provider) => {
            const commandLine = providerStartupCommand(provider);
            const description = localizedProviderDescription(provider);
            return (
              <div
                key={provider.id}
                className="border-border-subtle hover:bg-surface-hover/45 flex items-center gap-3 border-b px-3 py-3 transition-colors last:border-b-0"
              >
                <AgentLogo provider={provider} className="h-7 w-7" />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="text-fg truncate text-[13.5px] font-medium">
                      {provider.name}
                    </span>
                    <span className="ui-badge shrink-0 uppercase">
                      {provider.installCommand
                        ? t("settings.agents.cliAguiManaged")
                        : t("settings.agents.cliManual")}
                    </span>
                    {provider.enabled ? null : (
                      <span className="ui-badge uppercase">{t("common.disabled")}</span>
                    )}
                  </div>
                  {description ? (
                    <div className="text-muted mt-1 truncate text-[12px]">{description}</div>
                  ) : null}
                  {commandLine ? (
                    <div
                      className="text-subtle mt-1 truncate font-mono text-[11px]"
                      title={commandLine}
                    >
                      {commandLine}
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => openAgentDialog(provider)}
                    className="ui-icon-button"
                    title={t("settings.agents.editTitle", { name: provider.name })}
                    aria-label={t("settings.agents.editTitle", { name: provider.name })}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(provider)}
                    className="ui-icon-button text-danger hover:bg-danger/10 hover:text-danger"
                    title={t("settings.agents.removeConfirm", { name: provider.name })}
                    aria-label={t("settings.agents.removeConfirm", { name: provider.name })}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="ui-soft-card text-muted rounded-[8px] px-3 py-4 text-[13px]">
          {t("settings.agents.noAgents")}
        </div>
      )}

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) closeAgentDialog();
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <DialogTitle>
                  {editingExisting
                    ? t("settings.agents.editTitle", {
                        name: draft.name || t("settings.agents.editFallback"),
                      })
                    : t("settings.agents.add")}
                </DialogTitle>
                <DialogDescription className="mt-1.5">
                  {t("settings.agents.dialogDescription")}
                </DialogDescription>
              </div>
              <AgentEnabledSwitch
                checked={draft.enabled}
                label={t("common.enabled")}
                onChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
              />
            </div>
          </DialogHeader>

          <div className="mt-4 grid max-h-[min(34rem,65vh)] gap-4 overflow-y-auto pr-1 sm:grid-cols-2">
            <label>
              <span className="text-subtle mb-1.5 block text-[11px] font-semibold tracking-wide uppercase">
                {t("settings.agents.template")}
              </span>
              <Select value={selectedTemplateId} onValueChange={applyAgentTemplate}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AGENT_TEMPLATES.map((template) => (
                    <SelectItem key={template.id} value={template.id}>
                      {agentTemplateLabel(template)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <TextInput
              label={t("settings.field.displayName")}
              value={draft.name}
              onChange={(value) => setDraft((current) => ({ ...current, name: value }))}
            />
            <label>
              <span className="text-subtle mb-1.5 block text-[11px] font-semibold tracking-wide uppercase">
                {t("settings.field.transport")}
              </span>
              <Select
                value={draft.transport}
                onValueChange={(value) =>
                  setDraft((current) => ({
                    ...current,
                    transport: value as AspProvider["transport"],
                  }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stdio">{t("settings.transport.stdio")}</SelectItem>
                  <SelectItem value="persistent-stdio">
                    {t("settings.transport.persistentStdio")}
                  </SelectItem>
                  <SelectItem value="websocket">{t("settings.transport.websocket")}</SelectItem>
                  <SelectItem value="ssh">{t("settings.transport.ssh")}</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <TextInput
              label={t("settings.field.timeoutMs")}
              value={draft.timeoutMs ? String(draft.timeoutMs) : ""}
              onChange={(value) =>
                setDraft((current) => ({
                  ...current,
                  timeoutMs: Number(value) > 0 ? Number(value) : undefined,
                }))
              }
            />
            {draft.transport === "websocket" || draft.transport === "ssh" ? (
              <div className="sm:col-span-2">
                <TextInput
                  label={
                    draft.transport === "ssh"
                      ? t("settings.field.sshUrl")
                      : t("settings.field.websocketUrl")
                  }
                  value={draft.url ?? ""}
                  onChange={(value) => setDraft((current) => ({ ...current, url: value }))}
                />
              </div>
            ) : null}
            <div className="sm:col-span-2">
              <label className="text-subtle mb-1.5 block text-[11px] font-semibold tracking-wide uppercase">
                {draft.transport === "ssh"
                  ? t("settings.field.remoteCommand")
                  : t("settings.field.command")}
              </label>
              <div className="flex gap-2">
                <input
                  value={draft.command}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, command: event.target.value }))
                  }
                  className="ui-field min-w-0 flex-1 text-[13px]"
                />
                <input
                  ref={cliFileInputRef}
                  type="file"
                  className="hidden"
                  onChange={(event) => applyChosenCliFile(event.target.files?.[0])}
                />
                {draft.transport === "stdio" || draft.transport === "persistent-stdio" ? (
                  <button
                    type="button"
                    onClick={chooseCliPath}
                    disabled={!cliPathSelectable}
                    className="ui-button shrink-0"
                    title={t("settings.agents.chooseCliPath")}
                    aria-label={t("settings.agents.chooseCliPath")}
                  >
                    <FileJson size={14} />
                    {t("common.choose")}
                  </button>
                ) : null}
              </div>
              <p className="text-subtle mt-1 text-[11px]">
                {cliManagement === "agui"
                  ? t("settings.agents.cliAguiHint")
                  : t("settings.agents.cliManualHint")}
              </p>
            </div>
            {cliManagement === "agui" ? (
              <div className="sm:col-span-2">
                <label className="text-subtle mb-1.5 block text-[11px] font-semibold tracking-wide uppercase">
                  {t("settings.field.installCommand")}
                </label>
                <textarea
                  rows={2}
                  value={draft.installCommand ?? ""}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      installCommand: event.target.value,
                    }))
                  }
                  className="ui-field resize-y font-mono text-[12.5px]"
                />
                <p className="text-subtle mt-1 text-[11px]">
                  {t("settings.agents.installCommandHint")}
                </p>
              </div>
            ) : null}
            <div className="sm:col-span-2">
              <label className="text-subtle mb-1.5 block text-[11px] font-semibold tracking-wide uppercase">
                {t("settings.field.argumentsOnePerLine")}
              </label>
              <textarea
                rows={4}
                value={draft.args.join("\n")}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    args: event.target.value.split("\n").filter((value) => value.length > 0),
                  }))
                }
                className="ui-field resize-y font-mono text-[12.5px]"
              />
            </div>
            <EnvironmentVariablesEditor
              rows={environmentRows}
              error={parsedEnvironment instanceof Error ? parsedEnvironment : null}
              onChange={setEnvironmentRows}
            />
            <div className="sm:col-span-2">
              <label className="text-subtle mb-1.5 block text-[11px] font-semibold tracking-wide uppercase">
                {t("settings.field.capabilitiesJson")}
              </label>
              <textarea
                rows={7}
                value={capabilitiesText}
                onChange={(event) => setCapabilitiesText(event.target.value)}
                className={cn(
                  "ui-field resize-y font-mono text-[12.5px]",
                  parsedCapabilities instanceof Error
                    ? "border-danger focus:border-danger focus:shadow-[0_0_0_1px_var(--color-danger)]"
                    : "",
                )}
              />
              <p className="text-subtle mt-1 text-[11px]">{t("settings.field.capabilitiesHint")}</p>
            </div>
            <div className="sm:col-span-2">
              <label className="text-subtle mb-1.5 block text-[11px] font-semibold tracking-wide uppercase">
                {t("settings.field.modelsJson")}
              </label>
              <textarea
                rows={7}
                value={modelsText}
                onChange={(event) => setModelsText(event.target.value)}
                className={cn(
                  "ui-field resize-y font-mono text-[12.5px]",
                  parsedModels instanceof Error
                    ? "border-danger focus:border-danger focus:shadow-[0_0_0_1px_var(--color-danger)]"
                    : "",
                )}
              />
              <p className="text-subtle mt-1 text-[11px]">{t("settings.field.modelsHint")}</p>
            </div>
          </div>

          {dialogStatus || validationMessage ? (
            <div
              aria-live="polite"
              className={cn(
                "mt-4 border-l-2 pl-3 text-[12.5px]",
                validationMessage && !dialogStatus
                  ? "border-danger text-danger"
                  : "border-border-subtle text-muted",
              )}
            >
              {dialogStatus || validationMessage}
            </div>
          ) : null}

          <DialogFooter className="items-center justify-between">
            <div>
              {canRemoveDraft ? (
                <button
                  type="button"
                  onClick={() => void remove(draft)}
                  className="ui-button ui-button-danger"
                  title={t("settings.agents.removeConfirm", { name: draft.name })}
                  aria-label={t("settings.agents.removeConfirm", { name: draft.name })}
                >
                  <Trash2 size={14} />
                  {t("common.remove")}
                </button>
              ) : null}
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={closeAgentDialog} className="ui-button">
                {t("common.cancel")}
              </button>
              <button
                type="button"
                disabled={testing || Boolean(validationMessage)}
                onClick={() => void test()}
                className="ui-button"
              >
                <TestTube2 size={14} />
                {t("common.test")}
              </button>
              <button
                type="button"
                disabled={Boolean(validationMessage)}
                onClick={() => void save()}
                className="ui-button ui-button-primary"
              >
                {t("common.save")}
              </button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EnvironmentVariablesEditor({
  error,
  onChange,
  rows,
}: {
  error: Error | null;
  onChange: (rows: EnvironmentVariableRow[]) => void;
  rows: EnvironmentVariableRow[];
}) {
  const t = useT();

  const addRow = () => {
    onChange([
      ...rows,
      {
        id: environmentVariableRowId(),
        key: nextEnvironmentVariableName(rows),
        value: "",
      },
    ]);
  };
  const updateRow = (id: string, patch: Partial<Pick<EnvironmentVariableRow, "key" | "value">>) => {
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };
  const removeRow = (id: string) => {
    onChange(rows.filter((row) => row.id !== id));
  };

  return (
    <div className="sm:col-span-2">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <div className="text-subtle text-[11px] font-semibold tracking-wide uppercase">
            {t("settings.field.environment")}
          </div>
          <p className="text-subtle mt-1 text-[11px]">{t("settings.field.environmentHint")}</p>
        </div>
        <button type="button" onClick={addRow} className="ui-button shrink-0">
          <Plus size={14} />
          {t("settings.agents.environment.add")}
        </button>
      </div>
      {rows.length ? (
        <div className="flex flex-col gap-2">
          {rows.map((row) => (
            <div
              key={row.id}
              className="grid gap-2 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)_2rem]"
            >
              <input
                value={row.key}
                onChange={(event) => updateRow(row.id, { key: event.target.value })}
                placeholder={t("settings.agents.environment.namePlaceholder")}
                aria-label={t("settings.agents.environment.namePlaceholder")}
                className="ui-field font-mono text-[12.5px]"
              />
              <input
                value={row.value}
                onChange={(event) => updateRow(row.id, { value: event.target.value })}
                placeholder={t("settings.agents.environment.valuePlaceholder")}
                aria-label={t("settings.agents.environment.valuePlaceholder")}
                className="ui-field font-mono text-[12.5px]"
              />
              <button
                type="button"
                onClick={() => removeRow(row.id)}
                className="ui-icon-button text-danger hover:bg-danger/10 hover:text-danger sm:h-9 sm:w-8"
                title={t("settings.agents.environment.remove")}
                aria-label={t("settings.agents.environment.remove")}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <button
          type="button"
          onClick={addRow}
          className="text-subtle hover:border-border-strong hover:bg-surface-hover/40 border-border-subtle flex min-h-16 w-full items-center justify-center rounded-[8px] border border-dashed px-3 text-[12.5px] transition-colors"
        >
          {t("settings.agents.environment.empty")}
        </button>
      )}
      {error ? <p className="text-danger mt-2 text-[12px]">{error.message}</p> : null}
    </div>
  );
}

function AgentEnabledSwitch({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-checked={checked ? "true" : undefined}
      onClick={() => onChange(!checked)}
      className="text-muted hover:bg-surface-hover hover:text-fg mt-0.5 flex shrink-0 items-center gap-2 rounded-[8px] px-2 py-1 text-[12px]"
    >
      <span>{label}</span>
      <span data-checked={checked ? "true" : undefined} className="ui-switch">
        <span className="ui-switch-thumb" />
      </span>
    </button>
  );
}

function genericAspCapabilities(): AspProviderCapabilities {
  return {
    approvalModes: ["request", "auto", "full"],
    approvalScopes: ["command", "filesystem", "network", "tool"],
    contentParts: [...ADVANCED_CONTENT_PARTS, "citation"],
    humanInput: true,
    models: true,
    protocolVersions: ["1"],
    toolEvents: true,
    transports: ["stdio"],
    wireProtocol: "agent-server-protocol",
    workspace: true,
  };
}

function headlessCliCapabilities(
  runtimeAdapter: string,
  wireProtocol: string,
): AspProviderCapabilities {
  return {
    approvalModes: ["request", "auto", "full"],
    approvalScopes: ["command", "filesystem", "network", "tool"],
    contentParts: ADVANCED_CONTENT_PARTS,
    humanInput: true,
    models: true,
    reasoningEfforts: REASONING_EFFORTS,
    resumeSession: true,
    runtimeAdapter,
    sessionHistory: true,
    sessions: true,
    toolEvents: true,
    transports: ["stdio"],
    wireProtocol,
    workspace: true,
  };
}

function emptyProvider(): AspProvider {
  return {
    id: `agent-${Date.now().toString(36)}`,
    name: translateText("settings.agents.customAgent"),
    command: "",
    args: [],
    env: {},
    enabled: true,
    transport: "stdio",
  };
}

function environmentRowsFromRecord(
  environment: Record<string, string> | undefined,
): EnvironmentVariableRow[] {
  return Object.entries(environment ?? {}).map(([key, value]) => ({
    id: environmentVariableRowId(),
    key,
    value: String(value),
  }));
}

function environmentFromRows(rows: EnvironmentVariableRow[]): Record<string, string> | Error {
  const environment: Record<string, string> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) {
      return new Error(translateText("settings.agents.validation.environmentNameRequired"));
    }
    if (key.includes("=")) {
      return new Error(translateText("settings.agents.validation.environmentNameInvalid"));
    }
    if (seen.has(key)) {
      return new Error(
        translateText("settings.agents.validation.environmentNameDuplicate", { name: key }),
      );
    }
    seen.add(key);
    environment[key] = row.value;
  }
  return environment;
}

function environmentVariableRowId(): string {
  environmentVariableRowSequence += 1;
  return `env-${Date.now().toString(36)}-${environmentVariableRowSequence.toString(36)}`;
}

function nextEnvironmentVariableName(rows: EnvironmentVariableRow[]): string {
  const existing = new Set(rows.map((row) => row.key.trim()).filter(Boolean));
  const base = "ENV_VAR";
  if (!existing.has(base)) return base;
  for (let index = 2; index < 1_000; index += 1) {
    const candidate = `${base}_${index}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base}_${Date.now().toString(36).toUpperCase()}`;
}

function agentTemplateById(id: string): AgentTemplate {
  return AGENT_TEMPLATES.find((template) => template.id === id) ?? AGENT_TEMPLATES[0]!;
}

function agentTemplateLabel(template: AgentTemplate): string {
  return template.nameKey ? translateText(template.nameKey) : template.label;
}

function agentTemplateDescription(template: AgentTemplate): string | undefined {
  return template.descriptionKey ? translateText(template.descriptionKey) : template.description;
}

function localizedProviderDescription(provider: AspProvider): string | undefined {
  const template = AGENT_TEMPLATES.find((item) => item.id === agentTemplateIdForProvider(provider));
  return template ? agentTemplateDescription(template) : provider.description;
}

function agentTemplateIdForProvider(provider: AspProvider): string {
  const adapter = String(provider.capabilities?.runtimeAdapter ?? "").toLowerCase();
  const exact = AGENT_TEMPLATES.find((template) => template.id === provider.id);
  if (exact) return exact.id;
  const byAdapter = AGENT_TEMPLATES.find(
    (template) =>
      adapter && String(template.capabilities?.runtimeAdapter ?? "").toLowerCase() === adapter,
  );
  return byAdapter?.id ?? "custom";
}

function agentCliManagementForProvider(provider: AspProvider): AgentCliManagement {
  return provider.installCommand ? "agui" : "manual";
}

function providerFromAgentTemplate(
  template: AgentTemplate,
  cliManagement: AgentCliManagement,
  options: { enabled: boolean; id: string },
): AspProvider {
  return {
    id: options.id,
    name: template.nameKey ? translateText(template.nameKey) : template.label,
    description: agentTemplateDescription(template),
    command: template.command,
    args: [...(template.args ?? [])],
    env: {},
    enabled: options.enabled,
    transport: "stdio",
    installCommand: cliManagement === "agui" ? template.installCommand || undefined : undefined,
    capabilities: template.capabilities ? { ...template.capabilities } : undefined,
    models: template.models?.map((model) => ({ ...model })),
  };
}

function uniqueAgentId(baseId: string, providers: AspProvider[]): string {
  const fallback = baseId === "custom" ? `agent-${Date.now().toString(36)}` : baseId;
  const existing = new Set(providers.map((provider) => provider.id));
  if (!existing.has(fallback)) return fallback;
  for (let index = 2; index < 1_000; index += 1) {
    const candidate = `${fallback}-${index}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${fallback}-${Date.now().toString(36)}`;
}

function providerMatchesDetectedAgent(provider: AspProvider, detected: DetectedAgentCli): boolean {
  const command = provider.command.trim();
  return command === detected.path || command === detected.command;
}

function validateAgentDraft(
  provider: AspProvider,
  environment: Record<string, string> | Error,
  capabilities: AspProviderCapabilities | Error,
  models: AspModel[] | Error,
  cliManagement: AgentCliManagement,
  t: ReturnType<typeof useT>,
): string | null {
  if (!provider.name.trim()) return t("settings.agents.validation.nameRequired");
  if (environment instanceof Error) return environment.message;
  if (capabilities instanceof Error) return capabilities.message;
  if (models instanceof Error) return models.message;
  if (
    (provider.transport === "websocket" || provider.transport === "ssh") &&
    !provider.url?.trim()
  ) {
    return t("settings.agents.validation.urlRequired");
  }
  if (provider.transport !== "websocket" && !provider.command.trim()) {
    return t("settings.agents.validation.commandRequired");
  }
  if (
    cliManagement === "agui" &&
    (provider.transport === "stdio" || provider.transport === "persistent-stdio") &&
    !provider.installCommand?.trim()
  ) {
    return t("settings.agents.validation.installCommandRequired");
  }
  return null;
}

function providerFromAgentDraft(
  draft: AspProvider,
  environment: Record<string, string>,
  capabilities: AspProviderCapabilities,
  models: AspModel[],
): AspProvider {
  return {
    ...draft,
    installCommand: draft.installCommand?.trim() || undefined,
    env: environment,
    capabilities: Object.keys(capabilities).length ? capabilities : undefined,
    models: models.length ? models : undefined,
  };
}

function providerStartupCommand(provider: AspProvider): string {
  return [provider.command, ...provider.args].filter(Boolean).join(" ");
}

function parseProviderCapabilities(value: string): AspProviderCapabilities | Error {
  const parsed = parseJsonObject(value, translateText("settings.field.capabilities"));
  if (parsed instanceof Error) return parsed;
  return parsed as AspProviderCapabilities;
}

function parseProviderModels(value: string): AspModel[] | Error {
  const parsed = parseJsonArray(value, translateText("settings.field.models"));
  if (parsed instanceof Error) return parsed;
  for (const item of parsed) {
    if (!isPlainRecord(item) || !stringFromUnknown(item.id) || !stringFromUnknown(item.model)) {
      return new Error(translateText("settings.agents.validation.modelsInvalid"));
    }
  }
  return parsed as AspModel[];
}
