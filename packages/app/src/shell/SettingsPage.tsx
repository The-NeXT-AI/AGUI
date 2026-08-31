import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronDown, Eye, EyeOff, Monitor, Moon, Palette, Sun } from "lucide-react";
import { useAspStore } from "@/asp/asp-store";
import { desktopApi, type RuntimeRpcSettings } from "@/asp/desktop-api";
import { useUIStore } from "@/ui/ui-store";
import { cn } from "@/ui/cn";
import { toast } from "@/ui/toast";
import { useChatStore } from "@/chat/chat-store";
import type { ApprovalMode, Session } from "@/chat/types";
import { selectedEffort, selectedModel, selectedSpeed } from "@/chat/chat-run-helpers";
import {
  APPROVAL_MODES,
  approvalModeHintKeyForAgent,
  approvalModeLabelKeyForAgent,
} from "@/asp/agent-approval-modes";
import { useExtensionStore } from "@/extensions/extension-store";
import { canUseGlobalExtensionContribution } from "@/extensions/extension-broker";
import { LANGUAGES, type Lang, useI18nStore, useT } from "@/lib/i18n";
import { useProductConfig } from "@/product/product-config";
import { UIRegion } from "@/product/UIRegion";
import { AgentsSection } from "./AgentsSection";
import { McpGatewaySection } from "./McpGatewaySection";
import { Field, TextInput } from "./settings-fields";

const SECTIONS = [
  { id: "general", labelKey: "settings.section.general" },
  { id: "remote-access", labelKey: "settings.section.remoteAccess" },
  { id: "agents", labelKey: "settings.section.agents" },
  { id: "mcp-gateway", labelKey: "settings.section.mcpGateway" },
  { id: "about", labelKey: "settings.section.about" },
] as const;

const MODES: ApprovalMode[] = APPROVAL_MODES;
export function SettingsPage() {
  const t = useT();
  const close = useUIStore((state) => state.closeSettings);
  const section = useUIStore((state) => state.settingsSection);
  const setSection = useUIStore((state) => state.setSettingsSection);

  return (
    <div className="bg-canvas flex h-full flex-col">
      <header className="app-titlebar macos-window-controls-inset electron-drag-region border-border-subtle flex h-[var(--titlebar-height)] shrink-0 items-center gap-2 border-b px-3">
        <button
          type="button"
          onClick={close}
          title={t("common.back")}
          aria-label={t("common.back")}
          className="ui-icon-button h-10 w-10 sm:h-8 sm:w-8"
        >
          <ArrowLeft size={18} />
        </button>
        <h1 className="text-fg text-[14px] font-semibold">{t("common.settings")}</h1>
      </header>

      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <UIRegion id="settings.nav" data={{ section }}>
          <nav
            aria-label={t("common.settings")}
            className="no-scrollbar border-border-subtle flex w-full shrink-0 gap-1 overflow-x-auto border-b p-2 sm:block sm:w-44 sm:overflow-auto sm:border-r sm:border-b-0 lg:w-52"
          >
            {SECTIONS.map((item) => (
              <UIRegion
                key={item.id}
                id={`settings.nav.${item.id}`}
                data={{ active: section === item.id }}
              >
                <button
                  type="button"
                  onClick={() => setSection(item.id)}
                  aria-current={section === item.id ? "page" : undefined}
                  className="ui-nav-row shrink-0 px-3 py-2 text-left whitespace-nowrap sm:w-full sm:py-1.5"
                >
                  {t(item.labelKey)}
                </button>
              </UIRegion>
            ))}
          </nav>
        </UIRegion>

        <div className="min-w-0 flex-1 overflow-auto">
          <div className="mx-auto max-w-3xl px-4 py-5 sm:px-8 sm:py-8">
            {section === "general" ? (
              <UIRegion id="settings.section.general">
                <GeneralSection />
              </UIRegion>
            ) : null}
            {section === "remote-access" ? (
              <UIRegion id="settings.section.remoteAccess">
                <RuntimeRpcSection />
              </UIRegion>
            ) : null}
            {section === "agents" ? (
              <UIRegion id="settings.section.agents">
                <AgentsSection />
              </UIRegion>
            ) : null}
            {section === "mcp-gateway" ? (
              <UIRegion id="settings.section.mcpGateway">
                <McpGatewaySection />
              </UIRegion>
            ) : null}
            {section === "about" ? (
              <UIRegion id="settings.section.about">
                <AboutSection />
              </UIRegion>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function GeneralSection() {
  const t = useT();
  const providers = useAspStore((state) => state.providers);
  const activeProviderId = useAspStore((state) => state.activeProviderId);
  const setActiveProvider = useAspStore((state) => state.setActiveProvider);
  const theme = useUIStore((state) => state.theme);
  const setTheme = useUIStore((state) => state.setTheme);
  const font = useUIStore((state) => state.font);
  const setFont = useUIStore((state) => state.setFont);
  const codeFont = useUIStore((state) => state.codeFont);
  const setCodeFont = useUIStore((state) => state.setCodeFont);
  const model = useUIStore((state) => state.model);
  const setModel = useUIStore((state) => state.setModel);
  const effort = useUIStore((state) => state.effort);
  const setEffort = useUIStore((state) => state.setEffort);
  const speed = useUIStore((state) => state.speed);
  const setSpeed = useUIStore((state) => state.setSpeed);
  const approvalMode = useUIStore((state) => state.approvalMode);
  const setApprovalMode = useUIStore((state) => state.setApprovalMode);
  const records = useExtensionStore((state) => state.records);
  const lang = useI18nStore((state) => state.lang);
  const setLang = useI18nStore((state) => state.setLang);
  const enabledProviders = providers.filter((provider) => provider.enabled);
  const activeAgent = providers.find((agent) => agent.id === activeProviderId);
  const activeAgentModels = (activeAgent?.models ?? []).filter((item) => !item.hidden);
  const defaultModel =
    activeAgentModels.find((item) => item.model === model) ??
    activeAgentModels.find((item) => item.isDefault) ??
    activeAgentModels[0];
  const selectedMode = MODES.find((mode) => mode === approvalMode) ?? MODES[0];
  const themes = [
    { id: "system", label: "System", type: "system" as const },
    { id: "dark", label: "Dark", type: "dark" as const },
    { id: "light", label: "Light", type: "light" as const },
    ...records.flatMap((record) =>
      record.enabled && record.state !== "blocked" && canUseGlobalExtensionContribution(record)
        ? (record.manifest.contributes?.themes ?? []).map((item) => ({
            id: item.id,
            label: item.label,
            type: item.type,
          }))
        : [],
    ),
  ];
  const selectedTheme = themes.find((item) => item.id === theme) ?? themes[0];
  const updateDefaultModel = (modelId: string, provider = activeAgent) => {
    if (!provider || !modelId) return;
    setModel(modelId);
    const nextEffort = selectedEffort(provider.models, provider.capabilities, modelId, effort);
    setEffort(nextEffort ?? "");
    setSpeed(selectedSpeed(provider.models, provider.capabilities, modelId, speed));
  };
  const updateDefaultAgent = (providerId: string) => {
    const previousProviderId = useAspStore.getState().activeProviderId;
    const nextProvider = providers.find((provider) => provider.id === providerId);
    setActiveProvider(providerId);
    updateDefaultableCurrentAgent(providerId, previousProviderId);
    const nextModel = selectedModel(nextProvider?.models, model);
    if (nextModel && nextModel !== model) updateDefaultModel(nextModel, nextProvider);
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-fg text-[18px] font-semibold">{t("settings.section.general")}</h2>
        <p className="text-muted mt-1 text-[13px] leading-5">{t("settings.general.description")}</p>
      </div>

      <Field label={t("settings.general.defaultAgent")}>
        <div className="relative">
          <select
            aria-label={t("settings.general.defaultAgent")}
            value={
              enabledProviders.some((provider) => provider.id === activeProviderId)
                ? activeProviderId
                : ""
            }
            disabled={enabledProviders.length === 0}
            onChange={(event) => updateDefaultAgent(event.target.value)}
            className="ui-field appearance-none pr-8 text-[13.5px] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {enabledProviders.length === 0 ? (
              <option value="">{t("settings.agents.noAgents")}</option>
            ) : null}
            {enabledProviders.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
          <ChevronDown
            size={15}
            className="text-subtle pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2"
          />
        </div>
      </Field>

      <Field label={t("settings.general.defaultModel")}>
        <div className="relative">
          <select
            aria-label={t("settings.general.defaultModel")}
            value={defaultModel?.model ?? ""}
            disabled={activeAgentModels.length === 0}
            onChange={(event) => updateDefaultModel(event.target.value)}
            className="ui-field appearance-none pr-8 text-[13.5px] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {activeAgentModels.length === 0 ? (
              <option value="">{t("runSettings.noModelsAvailable")}</option>
            ) : null}
            {activeAgentModels.map((item) => (
              <option key={item.id || item.model} value={item.model}>
                {modelDisplayName(item)}
              </option>
            ))}
          </select>
          <ChevronDown
            size={15}
            className="text-subtle pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2"
          />
        </div>
      </Field>

      <Field label={t("settings.general.language")}>
        <div className="relative">
          <select
            aria-label={t("settings.general.language")}
            value={lang}
            onChange={(event) => setLang(event.target.value as Lang)}
            className="ui-field appearance-none pr-8 text-[13.5px]"
          >
            {LANGUAGES.map((language) => (
              <option key={language.id} value={language.id}>
                {language.nativeLabel}
              </option>
            ))}
          </select>
          <ChevronDown
            size={15}
            className="text-subtle pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2"
          />
        </div>
      </Field>

      <Field label={t("settings.appearance.theme")}>
        <div className="relative">
          <span className="text-subtle pointer-events-none absolute top-1/2 left-3 flex h-4 w-4 -translate-y-1/2 items-center justify-center">
            {themeIcon(selectedTheme)}
          </span>
          <select
            aria-label={t("settings.appearance.theme")}
            value={themes.some((item) => item.id === theme) ? theme : selectedTheme.id}
            onChange={(event) => setTheme(event.target.value)}
            className="ui-field appearance-none pr-8 pl-9 text-[13.5px]"
          >
            {themes.map((item) => (
              <option key={item.id} value={item.id}>
                {themeLabel(item, t)}
              </option>
            ))}
          </select>
          <ChevronDown
            size={15}
            className="text-subtle pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2"
          />
        </div>
      </Field>

      <Field label={t("settings.appearance.font")}>
        <input
          aria-label={t("settings.appearance.font")}
          value={font}
          placeholder={t("settings.font.placeholder")}
          onChange={(event) => setFont(event.target.value)}
          className="ui-field text-[13.5px]"
        />
        <p className="text-subtle mt-1 text-[12px]">{t("settings.font.hint")}</p>
      </Field>

      <Field label={t("settings.appearance.codeFont")}>
        <input
          aria-label={t("settings.appearance.codeFont")}
          value={codeFont}
          placeholder={t("settings.codeFont.placeholder")}
          onChange={(event) => setCodeFont(event.target.value)}
          className="ui-field font-mono text-[13px]"
        />
        <p className="text-subtle mt-1 text-[12px]">{t("settings.codeFont.hint")}</p>
      </Field>

      <Field label={t("settings.general.permissions")}>
        <div className="relative">
          <select
            aria-label={t("settings.general.permissions")}
            value={approvalMode}
            onChange={(event) => setApprovalMode(event.target.value as ApprovalMode)}
            className="ui-field appearance-none pr-8 text-[13.5px]"
          >
            {MODES.map((mode) => (
              <option key={mode} value={mode}>
                {t(approvalModeLabelKeyForAgent(mode, activeAgent))}
              </option>
            ))}
          </select>
          <ChevronDown
            size={15}
            className="text-subtle pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2"
          />
        </div>
        <p className="text-subtle mt-1 text-[12px]">
          {t(approvalModeHintKeyForAgent(selectedMode, activeAgent))}
        </p>
      </Field>
    </div>
  );
}

function modelDisplayName(model: { displayName?: string; model: string }): string {
  return model.displayName || model.model;
}

function updateDefaultableCurrentAgent(providerId: string, previousProviderId: string): void {
  if (!providerId || providerId === previousProviderId) return;
  const chat = useChatStore.getState();
  if (!chat.activeSessionId) {
    if (chat.draftSession?.providerId === previousProviderId) {
      chat.setDraftProvider(providerId);
    }
    return;
  }
  const session = chat.sessions.find((item) => item.id === chat.activeSessionId);
  if (sessionCanFollowDefaultAgent(session, previousProviderId)) {
    chat.setSessionProvider(session.id, providerId);
  }
}

function sessionCanFollowDefaultAgent(
  session: Session | undefined,
  previousProviderId: string,
): session is Session {
  if (!session || session.providerId !== previousProviderId) return false;
  if (
    session.status === "streaming" ||
    session.activeRunId ||
    session.activeRunProviderId ||
    session.providerSessionId ||
    session.transcriptLoading
  ) {
    return false;
  }
  const agentRouteUsed = Object.values(session.agentSessions ?? {}).some(
    (route) =>
      Boolean(route.providerSessionId) ||
      (route.status !== undefined && route.status !== "never_used"),
  );
  if (agentRouteUsed) return false;
  return session.blocks.every(
    (block) =>
      block.kind === "assistant" &&
      block.metadata?.extensionSessionContext === true &&
      !block.agentProviderId &&
      !block.agentProviderSessionId,
  );
}

type RuntimeRpcForm = {
  enabled: boolean;
  host: string;
  port: string;
  token: string;
};

function RuntimeRpcSection() {
  const t = useT();
  const [settings, setSettings] = useState<RuntimeRpcSettings | null>(null);
  const [form, setForm] = useState<RuntimeRpcForm>(() => defaultRuntimeRpcForm());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [showToken, setShowToken] = useState(false);

  const load = async () => {
    const api = desktopApi();
    if (!api?.runtimeRpc) {
      setStatus(t("settings.remoteAccess.desktopOnly"));
      return;
    }
    setLoading(true);
    try {
      const next = await api.runtimeRpc.getSettings();
      setSettings(next);
      setForm(runtimeRpcFormFromSettings(next));
      setStatus("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // Load once when opening the section; further reloads are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    const api = desktopApi();
    if (!api?.runtimeRpc) return;
    const port = Number(form.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      setStatus(t("settings.remoteAccess.invalidPort"));
      return;
    }
    setSaving(true);
    try {
      const next = await api.runtimeRpc.saveSettings({
        enabled: form.enabled,
        host: form.host.trim() || "127.0.0.1",
        port,
        token: form.token.trim(),
      });
      setSettings(next);
      setForm(runtimeRpcFormFromSettings(next));
      if (next.error) {
        setStatus(next.error);
        toast.error(next.error);
      } else {
        const message = next.running
          ? t("settings.remoteAccess.running")
          : t("settings.remoteAccess.saved");
        setStatus(next.running ? message : "");
        toast.success(message);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const disabledByEnvironment = settings?.disabledByEnvironment === true;
  const enabledChanged = settings ? form.enabled !== settings.enabled : false;
  const showSaveButton = form.enabled || enabledChanged;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-fg text-[18px] font-semibold">
            {t("settings.section.remoteAccess")}
          </h2>
          <p className="text-muted mt-1 text-[13px]">{t("settings.remoteAccess.description")}</p>
        </div>
        <button
          type="button"
          onClick={() => setForm((current) => ({ ...current, enabled: !current.enabled }))}
          className="mt-1 shrink-0"
          aria-label={t("settings.remoteAccess.serviceName")}
          aria-pressed={form.enabled}
        >
          <span data-checked={form.enabled ? "true" : undefined} className="ui-switch">
            <span className="ui-switch-thumb" />
          </span>
        </button>
      </div>

      {form.enabled ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <TextInput
            label={t("settings.remoteAccess.bindAddress")}
            value={form.host}
            onChange={(value) => setForm((current) => ({ ...current, host: value }))}
          />
          <TextInput
            label={t("settings.remoteAccess.port")}
            type="number"
            value={form.port}
            onChange={(value) => setForm((current) => ({ ...current, port: value }))}
          />
          <div className="sm:col-span-2">
            <label className="text-subtle mb-1.5 block text-[11px] font-semibold tracking-wide uppercase">
              {t("settings.remoteAccess.accessToken")}
            </label>
            <div className="flex gap-2">
              <div className="relative min-w-0 flex-1">
                <input
                  type={showToken ? "text" : "password"}
                  value={form.token}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, token: event.target.value }))
                  }
                  className="ui-field pr-10 font-mono text-[12.5px]"
                />
                <button
                  type="button"
                  onClick={() => setShowToken((current) => !current)}
                  className="ui-icon-button absolute top-1/2 right-1 h-7 w-7 -translate-y-1/2 rounded-md"
                  title={
                    showToken
                      ? t("settings.remoteAccess.hideToken")
                      : t("settings.remoteAccess.showToken")
                  }
                  aria-label={
                    showToken
                      ? t("settings.remoteAccess.hideToken")
                      : t("settings.remoteAccess.showToken")
                  }
                >
                  {showToken ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              <button
                type="button"
                onClick={() =>
                  setForm((current) => ({ ...current, token: generateRuntimeRpcToken() }))
                }
                className="ui-button"
              >
                {t("common.generate")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {form.enabled ? (
        <>
          {disabledByEnvironment ? (
            <p className="text-danger text-[12px]">{t("settings.remoteAccess.disabledByEnv")}</p>
          ) : null}
          {form.host === "0.0.0.0" ? (
            <p className="text-warning text-[12px]">{t("settings.remoteAccess.openHostWarning")}</p>
          ) : null}
        </>
      ) : null}
      {status ? (
        <p
          className={cn(
            "text-[12px]",
            status.toLowerCase().includes("error") ? "text-danger" : "text-subtle",
          )}
        >
          {status}
        </p>
      ) : null}

      {showSaveButton ? (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || loading}
            className="ui-button ui-button-primary"
          >
            {saving ? t("common.saving") : t("common.save")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function AboutSection() {
  const t = useT();
  const productConfig = useProductConfig();
  const available = useAspStore((state) => state.available);
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-fg text-[18px] font-semibold">{t("settings.section.about")}</h2>
      <div className="border-border-subtle border-y py-4">
        <div className="text-fg text-[15px] font-semibold">{productConfig.app.displayName}</div>
        <div className="text-muted mt-0.5 text-[13px]">{t("settings.about.version")}</div>
        <p className="text-muted mt-2 text-[13px]">{t("settings.about.description")}</p>
        <div className="text-subtle mt-3 text-[12px]">
          {t("settings.about.bridge", {
            status: available ? t("common.connected") : t("common.notAvailable"),
          })}
        </div>
      </div>
    </div>
  );
}

function themeLabel(item: { id: string; label: string }, t: ReturnType<typeof useT>): string {
  if (item.id === "system") return t("settings.appearance.system");
  if (item.id === "dark") return t("settings.appearance.dark");
  if (item.id === "light") return t("settings.appearance.light");
  return item.label;
}

function themeIcon(item: { id: string }): ReactNode {
  if (item.id === "system") return <Monitor size={14} />;
  if (item.id === "light") return <Sun size={14} />;
  if (item.id === "dark") return <Moon size={14} />;
  return <Palette size={14} />;
}

function defaultRuntimeRpcForm(): RuntimeRpcForm {
  return {
    enabled: false,
    host: "127.0.0.1",
    port: "17371",
    token: "",
  };
}

function runtimeRpcFormFromSettings(settings: RuntimeRpcSettings): RuntimeRpcForm {
  return {
    enabled: settings.enabled,
    host: settings.host || "127.0.0.1",
    port: String(settings.port || 17371),
    token: settings.token || "",
  };
}

function generateRuntimeRpcToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  const raw = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
