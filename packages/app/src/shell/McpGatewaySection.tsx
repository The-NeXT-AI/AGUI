import { useCallback, useEffect, useMemo, useState } from "react";
import { FileJson, Pencil, Plus, RefreshCw, ServerCog, Settings2, Trash2 } from "lucide-react";
import {
  desktopApi,
  type McpGatewayLlmSettings,
  type McpGatewayManagedServer,
  type McpGatewayServerConfig,
  type McpGatewaySettings,
} from "@/asp/desktop-api";
import { useAspStore } from "@/asp/asp-store";
import { extensionScopeWorkspaceId } from "@/extensions/extension-store";
import { confirmDialog } from "@/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { toast } from "@/ui/toast";
import { useT } from "@/lib/i18n";
import { useWorkspaceStore } from "@/workspaces/workspace-store";
import {
  defaultMcpGatewayLlmForm,
  emptyMcpGatewayForm,
  mcpGatewayConfigFromManagedServer,
  mcpGatewayConfigsFromImportJson,
  mcpGatewayFormFromServer,
  mcpGatewayServerFromForm,
  normalizeMcpGatewayLlmForm,
  type McpGatewayServerForm,
} from "./mcp-gateway-settings";
import { StatusDot, TextAreaField, TextInput } from "./settings-fields";

export function McpGatewaySection() {
  const t = useT();
  const fallbackWorkspacePath = useAspStore((state) => state.workspacePath);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const activeWorkspaceProjectPath = useWorkspaceStore(
    (state) => state.activeWorkspace().projectPath,
  );
  const gatewayScope = useMemo(
    () => ({
      workspacePath: activeWorkspaceProjectPath || fallbackWorkspacePath,
      workspaceId: extensionScopeWorkspaceId(activeWorkspaceId),
    }),
    [activeWorkspaceId, activeWorkspaceProjectPath, fallbackWorkspacePath],
  );
  const [settings, setSettings] = useState<McpGatewaySettings | null>(null);
  const [form, setForm] = useState<McpGatewayServerForm>(() => emptyMcpGatewayForm());
  const [llmForm, setLlmForm] = useState<McpGatewayLlmSettings>(() => defaultMcpGatewayLlmForm());
  const [dialogMode, setDialogMode] = useState<"add" | "edit" | null>(null);
  const [llmDialogOpen, setLlmDialogOpen] = useState(false);
  const [status, setStatus] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [llmDialogError, setLlmDialogError] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [llmSaving, setLlmSaving] = useState(false);

  const load = useCallback(async () => {
    const api = desktopApi();
    if (!api) {
      setStatus(t("settings.mcpGateway.desktopOnly"));
      return;
    }
    setLoading(true);
    try {
      const next = await api.mcpGateway.getSettings(gatewayScope);
      setSettings(next);
      setLlmForm(normalizeMcpGatewayLlmForm(next.llm));
      setStatus("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [gatewayScope, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const setEnabled = async (enabled: boolean) => {
    const api = desktopApi();
    if (!api) return;
    setLoading(true);
    try {
      const next = await api.mcpGateway.setEnabled({ enabled, ...gatewayScope });
      setSettings(next);
      setLlmForm(normalizeMcpGatewayLlmForm(next.llm));
      setStatus("");
      toast.success(
        enabled ? t("settings.mcpGateway.enabledStatus") : t("settings.mcpGateway.disabledStatus"),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (enabled && message.includes("Resolve model")) {
        editResolveModel(message);
      } else {
        setStatus(message);
      }
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const refresh = async () => {
    const api = desktopApi();
    if (!api) return;
    setLoading(true);
    try {
      const next = await api.mcpGateway.refresh(gatewayScope);
      setSettings(next);
      setLlmForm(normalizeMcpGatewayLlmForm(next.llm));
      setStatus("");
      toast.success(t("settings.mcpGateway.refreshed"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const saveDialog = async () => {
    const api = desktopApi();
    if (!api) return;
    const parsed = mcpGatewayServerFromForm(form);
    if (parsed instanceof Error) {
      setDialogError(parsed.message);
      return;
    }
    setSaving(true);
    setDialogError("");
    try {
      const next = await api.mcpGateway.saveServer({ ...parsed, ...gatewayScope });
      setSettings(next);
      setLlmForm(normalizeMcpGatewayLlmForm(next.llm));
      toast.success(t("settings.mcpGateway.savedServer", { id: parsed.id }));
      setDialogMode(null);
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const importServers = async (serversToImport: McpGatewayServerConfig[]) => {
    const api = desktopApi();
    if (!api) return;
    setSaving(true);
    setDialogError("");
    try {
      let next: McpGatewaySettings | null = null;
      for (const server of serversToImport) {
        next = await api.mcpGateway.saveServer({ ...server, ...gatewayScope });
      }
      if (next) setSettings(next);
      if (next) setLlmForm(normalizeMcpGatewayLlmForm(next.llm));
      toast.success(t("settings.mcpGateway.imported", { count: serversToImport.length }));
      setDialogMode(null);
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const toggleServer = async (server: McpGatewayManagedServer, enabled: boolean) => {
    const api = desktopApi();
    if (!api) return;
    if (server.readOnly) return;
    let payload: McpGatewayServerConfig;
    try {
      payload = mcpGatewayConfigFromManagedServer(server, { enabled });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      return;
    }
    setLoading(true);
    try {
      const next = await api.mcpGateway.saveServer({ ...payload, ...gatewayScope });
      setSettings(next);
      setLlmForm(normalizeMcpGatewayLlmForm(next.llm));
      setStatus("");
      toast.success(
        t(enabled ? "settings.mcpGateway.serverEnabled" : "settings.mcpGateway.serverDisabled", {
          name: server.label || server.id,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const remove = async (server: McpGatewayManagedServer) => {
    const api = desktopApi();
    if (!api) return;
    if (server.readOnly) return;
    const confirmed = await confirmDialog({
      title: t("settings.mcpGateway.removeTitle"),
      description: t("settings.mcpGateway.removeConfirm", { name: server.label || server.id }),
      confirmLabel: t("common.remove"),
      tone: "danger",
    });
    if (!confirmed) return;
    setLoading(true);
    try {
      const next = await api.mcpGateway.removeServer({ id: server.id, ...gatewayScope });
      setSettings(next);
      setLlmForm(normalizeMcpGatewayLlmForm(next.llm));
      setStatus("");
      toast.success(t("settings.mcpGateway.removedServer", { id: server.id }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const addServer = () => {
    setForm(emptyMcpGatewayForm());
    setDialogError("");
    setStatus("");
    setDialogMode("add");
  };

  const editServer = (server: McpGatewayManagedServer) => {
    if (server.readOnly) return;
    setForm(mcpGatewayFormFromServer(server));
    setDialogError("");
    setStatus("");
    setDialogMode("edit");
  };

  const editResolveModel = (error = "") => {
    setLlmForm({
      ...normalizeMcpGatewayLlmForm(settings?.llm),
      enabled: true,
    });
    setLlmDialogError(error);
    setStatus("");
    setLlmDialogOpen(true);
  };

  const saveLlm = async () => {
    const api = desktopApi();
    if (!api) return;
    setLlmSaving(true);
    setLlmDialogError("");
    try {
      const next = await api.mcpGateway.setLlm({
        ...normalizeMcpGatewayLlmForm(llmForm),
        enabled: true,
        ...gatewayScope,
      });
      setSettings(next);
      setLlmForm(normalizeMcpGatewayLlmForm(next.llm));
      toast.success(t("settings.mcpGateway.savedResolve"));
      setLlmDialogOpen(false);
    } catch (error) {
      setLlmDialogError(error instanceof Error ? error.message : String(error));
    } finally {
      setLlmSaving(false);
    }
  };

  const servers = settings?.servers ?? [];
  const resolveModelReady = settings?.runtime?.resolveModelReady !== false;
  const resolveModelError = settings?.runtime?.error;
  const gatewayActive = settings?.enabled === true && !resolveModelError;
  const configurationIncomplete = Boolean(settings) && !resolveModelReady;
  const canToggleGateway =
    Boolean(settings) && !loading && (settings?.enabled || resolveModelReady);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-fg text-[18px] font-semibold">{t("settings.section.mcpGateway")}</h2>
          {resolveModelError ? (
            <p className="text-danger mt-1 max-w-xl text-[12px]">{resolveModelError}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {!configurationIncomplete && gatewayActive ? (
            <button
              type="button"
              onClick={addServer}
              className="ui-icon-button border-border h-8 w-8 shrink-0 border"
              title={t("settings.mcpGateway.addServer")}
              aria-label={t("settings.mcpGateway.addServer")}
            >
              <Plus size={14} />
            </button>
          ) : null}
          {!configurationIncomplete ? (
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              className="ui-icon-button border-border h-8 w-8 border"
              title={t("settings.mcpGateway.refresh")}
              aria-label={t("settings.mcpGateway.refresh")}
            >
              <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => editResolveModel()}
            disabled={!settings}
            className="ui-icon-button border-border h-8 w-8 border"
            title={
              resolveModelReady
                ? t("settings.mcpGateway.resolveSettings")
                : resolveModelError || t("settings.mcpGateway.resolveSettings")
            }
            aria-label={t("settings.mcpGateway.resolveSettings")}
          >
            <Settings2 size={15} />
          </button>
          {!configurationIncomplete ? (
            <button
              type="button"
              role="switch"
              aria-checked={gatewayActive}
              data-checked={gatewayActive ? "true" : undefined}
              onClick={() => void setEnabled(!settings?.enabled)}
              disabled={!canToggleGateway}
              className="ui-switch"
              title={
                settings?.enabled
                  ? t("settings.mcpGateway.disable")
                  : resolveModelReady
                    ? t("settings.mcpGateway.enable")
                    : t("settings.mcpGateway.configureBeforeEnable")
              }
              aria-label={
                settings?.enabled
                  ? t("settings.mcpGateway.disable")
                  : resolveModelReady
                    ? t("settings.mcpGateway.enable")
                    : t("settings.mcpGateway.configureBeforeEnable")
              }
            >
              <span className="ui-switch-thumb" />
            </button>
          ) : null}
        </div>
      </div>

      <section>
        {servers.length ? (
          <div className="divide-border-subtle divide-y">
            {servers.map((server) => {
              const readOnly = server.readOnly === true;
              const sourceLabel =
                server.source === "extension" ? t("settings.mcpGateway.source.extension") : "";
              const endpoint =
                server.type === "stdio"
                  ? [server.command, ...(server.args ?? [])].filter(Boolean).join(" ")
                  : server.url;
              const displayName = server.label || server.id;
              const showId = server.id.trim() !== displayName.trim();
              const toolCount = server.toolCount ?? server.tools?.length ?? 0;
              const serverStatusNote = !gatewayActive
                ? t("settings.mcpGateway.gatewayDisabledNote")
                : !server.enabled
                  ? t("settings.mcpGateway.serverDisabledNote")
                  : server.status === "unknown"
                    ? t("settings.mcpGateway.notChecked")
                    : server.status === "online" && toolCount === 0
                      ? t("settings.mcpGateway.noTools")
                      : "";
              return (
                <div
                  key={`${server.source ?? "settings"}:${server.id}:${server.extensionId ?? ""}`}
                  className="py-4"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <StatusDot
                      status={gatewayActive && server.enabled ? server.status : "offline"}
                    />
                    <ServerCog size={15} className="text-info mt-0.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-fg truncate text-[13.5px] font-medium">
                          {displayName}
                        </span>
                        {showId ? (
                          <span className="text-subtle font-mono text-[11px]">{server.id}</span>
                        ) : null}
                        <span className="text-subtle text-[11px] uppercase">{server.type}</span>
                        {sourceLabel ? (
                          <span className="ui-badge text-[10px] uppercase">{sourceLabel}</span>
                        ) : null}
                      </div>
                      <div
                        className="text-subtle mt-1 truncate font-mono text-[11.5px]"
                        title={endpoint || undefined}
                      >
                        {endpoint || t("settings.mcpGateway.noEndpoint")}
                      </div>
                      <div className="text-muted mt-1 text-[11.5px]">
                        {t("settings.mcpGateway.toolCount", { count: toolCount })}
                        {serverStatusNote ? ` · ${serverStatusNote}` : ""}
                      </div>
                    </div>
                    {readOnly ? null : (
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={() => void toggleServer(server, !server.enabled)}
                          disabled={loading || saving}
                          data-checked={server.enabled ? "true" : undefined}
                          className="ui-switch"
                          aria-label={
                            server.enabled
                              ? t("settings.mcpGateway.disableServer")
                              : t("settings.mcpGateway.enableServer")
                          }
                          title={
                            server.enabled
                              ? t("settings.mcpGateway.disableServer")
                              : t("settings.mcpGateway.enableServer")
                          }
                        >
                          <span className="ui-switch-thumb" />
                        </button>
                        <button
                          type="button"
                          onClick={() => editServer(server)}
                          className="ui-icon-button h-7 w-7 rounded-md"
                          title={t("settings.mcpGateway.editServer")}
                          aria-label={t("settings.mcpGateway.editServer")}
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          type="button"
                          onClick={() => void remove(server)}
                          disabled={loading || saving}
                          className="ui-icon-button text-danger hover:bg-danger/10 hover:text-danger h-7 w-7 rounded-md"
                          title={t("settings.mcpGateway.removeServer")}
                          aria-label={t("settings.mcpGateway.removeServer")}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    )}
                  </div>

                  {server.error ? (
                    <div className="border-danger text-danger mt-3 border-l-2 pl-3 text-[12px]">
                      {server.error}
                    </div>
                  ) : null}
                  {server.tools?.length ? (
                    <div className="mt-3 flex flex-wrap gap-1.5 pl-8">
                      {server.tools.slice(0, 8).map((tool) => (
                        <span
                          key={tool.toolName}
                          className="ui-badge max-w-full truncate font-mono"
                          title={tool.description || tool.toolName}
                        >
                          {tool.toolName}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="border-border-subtle text-subtle border-b py-8 text-center text-[12.5px]">
            {t("settings.mcpGateway.noServers")}
          </div>
        )}
      </section>

      {status ? (
        <div className="border-border-subtle text-muted border-l-2 pl-3 text-[12.5px]">
          {status}
        </div>
      ) : null}

      <McpGatewayServerDialog
        error={dialogError}
        form={form}
        loading={saving}
        mode={dialogMode}
        onChange={(next) => {
          setForm(next);
          if (dialogError) setDialogError("");
        }}
        onClose={() => {
          setDialogMode(null);
          setDialogError("");
        }}
        onError={setDialogError}
        onImport={importServers}
        onSave={saveDialog}
      />
      <McpGatewayLlmDialog
        error={llmDialogError}
        form={llmForm}
        loading={llmSaving}
        open={llmDialogOpen}
        onChange={(next) => {
          setLlmForm(next);
          if (llmDialogError) setLlmDialogError("");
        }}
        onClose={() => {
          setLlmDialogOpen(false);
          setLlmDialogError("");
          setLlmForm(normalizeMcpGatewayLlmForm(settings?.llm));
        }}
        onSave={saveLlm}
      />
    </div>
  );
}

function McpGatewayLlmDialog({
  error,
  form,
  loading,
  open,
  onChange,
  onClose,
  onSave,
}: {
  error: string;
  form: McpGatewayLlmSettings;
  loading: boolean;
  open: boolean;
  onChange: (form: McpGatewayLlmSettings) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const t = useT();
  const update = <Key extends keyof McpGatewayLlmSettings>(
    key: Key,
    value: McpGatewayLlmSettings[Key],
  ) => onChange({ ...form, [key]: value });

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("settings.mcpGateway.resolveTitle")}</DialogTitle>
          <DialogDescription>{t("settings.mcpGateway.resolveDescription")}</DialogDescription>
        </DialogHeader>

        <form
          className="mt-5 grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
        >
          <TextInput
            label={t("settings.field.model")}
            value={form.model ?? ""}
            onChange={(value) => update("model", value)}
          />
          <TextInput
            label={t("settings.field.baseUrl")}
            value={form.baseUrl ?? ""}
            onChange={(value) => update("baseUrl", value)}
          />
          <TextInput
            label={t("settings.field.apiKey")}
            type="password"
            value={form.apiKey ?? ""}
            onChange={(value) => update("apiKey", value)}
          />

          {error ? (
            <div className="border-danger text-danger border-l-2 pl-3 text-[12px]">{error}</div>
          ) : null}

          <DialogFooter>
            <button type="button" onClick={onClose} className="ui-button">
              {t("common.cancel")}
            </button>
            <button type="submit" disabled={loading} className="ui-button ui-button-primary">
              {t("common.save")}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function McpGatewayServerDialog({
  error,
  form,
  loading,
  mode,
  onChange,
  onClose,
  onError,
  onImport,
  onSave,
}: {
  error: string;
  form: McpGatewayServerForm;
  loading: boolean;
  mode: "add" | "edit" | null;
  onChange: (form: McpGatewayServerForm) => void;
  onClose: () => void;
  onError: (message: string) => void;
  onImport: (servers: McpGatewayServerConfig[]) => Promise<void>;
  onSave: () => void;
}) {
  const t = useT();
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const update = <Key extends keyof McpGatewayServerForm>(
    key: Key,
    value: McpGatewayServerForm[Key],
  ) => onChange({ ...form, [key]: value });

  useEffect(() => {
    if (!mode) {
      setImportOpen(false);
      setImportText("");
    }
  }, [mode]);

  const applyJsonImport = async () => {
    const imported = mcpGatewayConfigsFromImportJson(importText);
    if (imported instanceof Error) {
      onError(imported.message);
      return;
    }
    if (imported.length === 1) {
      onChange(mcpGatewayFormFromServer(imported[0]!));
      setImportOpen(false);
      setImportText("");
      return;
    }
    if (mode === "edit") {
      onError(t("settings.mcpGateway.importMultipleInEdit"));
      return;
    }
    await onImport(imported);
  };

  return (
    <Dialog
      open={Boolean(mode)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[calc(100vh-32px)] max-w-2xl overflow-auto">
        <DialogHeader>
          <DialogTitle>
            {mode === "edit"
              ? t("settings.mcpGateway.serverDialogEdit")
              : t("settings.mcpGateway.serverDialogAdd")}
          </DialogTitle>
          <DialogDescription>{t("settings.mcpGateway.serverDialogDescription")}</DialogDescription>
        </DialogHeader>

        <form
          className="mt-5 grid gap-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
        >
          <div className="border-border-subtle border-y py-3 sm:col-span-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-subtle text-[11px] font-semibold tracking-wide uppercase">
                  {t("settings.mcpGateway.jsonImport")}
                </div>
                <div className="text-muted mt-0.5 text-[12px]">
                  {t("settings.mcpGateway.jsonImportDescription")}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setImportOpen((value) => !value)}
                className="ui-button shrink-0"
              >
                <FileJson size={14} />
                {importOpen ? t("common.hide") : t("common.import")}
              </button>
            </div>
            {importOpen ? (
              <div className="mt-3 grid gap-2">
                <textarea
                  rows={7}
                  value={importText}
                  onChange={(event) => setImportText(event.target.value)}
                  placeholder={
                    '{"mcpServers":{"mcd-mcp":{"type":"streamablehttp","url":"https://mcp.mcd.cn","headers":{"Authorization":"Bearer xxx"}}}}'
                  }
                  className="ui-field resize-y font-mono text-[12px]"
                />
                <div className="flex justify-end">
                  <button
                    type="button"
                    disabled={loading || !importText.trim()}
                    onClick={() => void applyJsonImport()}
                    className="ui-button"
                  >
                    <FileJson size={14} />
                    {t("common.applyJson")}
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          <TextInput
            label={t("settings.field.id")}
            value={form.id}
            disabled={mode === "edit"}
            onChange={(value) => update("id", value)}
          />
          <TextInput
            label={t("settings.field.displayName")}
            value={form.label}
            onChange={(value) => update("label", value)}
          />
          <label>
            <span className="text-subtle mb-1.5 block text-[11px] font-semibold tracking-wide uppercase">
              {t("settings.field.transport")}
            </span>
            <select
              value={form.type}
              onChange={(event) =>
                update("type", event.target.value as McpGatewayServerForm["type"])
              }
              className="ui-field text-[13px]"
            >
              <option value="http">{t("settings.transport.http")}</option>
              <option value="sse">{t("settings.transport.sse")}</option>
              <option value="stdio">{t("settings.transport.stdio")}</option>
            </select>
          </label>
          <label className="text-muted flex items-end gap-2 pb-2 text-[13px]">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => update("enabled", event.target.checked)}
            />
            {t("common.enabled")}
          </label>

          {form.type === "stdio" ? (
            <>
              <div className="sm:col-span-2">
                <TextInput
                  label={t("settings.field.command")}
                  value={form.command}
                  onChange={(value) => update("command", value)}
                />
              </div>
              <TextAreaField
                label={t("settings.field.argumentsCommaOnePerLine")}
                rows={4}
                value={form.argsText}
                onChange={(value) => update("argsText", value)}
              />
              <TextAreaField
                label={t("settings.field.environmentJsonShort")}
                rows={4}
                value={form.envText}
                onChange={(value) => update("envText", value)}
              />
            </>
          ) : (
            <>
              <div className="sm:col-span-2">
                <TextInput
                  label={
                    form.type === "sse" ? t("settings.field.sseUrl") : t("settings.field.httpUrl")
                  }
                  value={form.url}
                  onChange={(value) => update("url", value)}
                />
              </div>
              <TextAreaField
                label={t("settings.field.headersJson")}
                rows={4}
                value={form.headersText}
                onChange={(value) => update("headersText", value)}
              />
              <label>
                <span className="text-subtle mb-1.5 block text-[11px] font-semibold tracking-wide uppercase">
                  {t("settings.field.authentication")}
                </span>
                <select
                  value={form.authType}
                  onChange={(event) =>
                    update("authType", event.target.value as McpGatewayServerForm["authType"])
                  }
                  className="ui-field text-[13px]"
                >
                  <option value="none">{t("settings.mcpGateway.auth.none")}</option>
                  <option value="bearer">{t("settings.mcpGateway.auth.bearer")}</option>
                  <option value="api-key">{t("settings.mcpGateway.auth.apiKey")}</option>
                  <option value="basic">{t("settings.mcpGateway.auth.basic")}</option>
                </select>
              </label>
              {form.authType === "bearer" ? (
                <TextInput
                  label={t("settings.field.token")}
                  value={form.authToken}
                  onChange={(value) => update("authToken", value)}
                />
              ) : null}
              {form.authType === "api-key" ? (
                <>
                  <TextInput
                    label={t("settings.field.headerName")}
                    value={form.authHeaderName}
                    onChange={(value) => update("authHeaderName", value)}
                  />
                  <TextInput
                    label={t("settings.field.headerValue")}
                    value={form.authValue}
                    onChange={(value) => update("authValue", value)}
                  />
                </>
              ) : null}
              {form.authType === "basic" ? (
                <>
                  <TextInput
                    label={t("settings.field.username")}
                    value={form.authUsername}
                    onChange={(value) => update("authUsername", value)}
                  />
                  <TextInput
                    label={t("settings.field.password")}
                    value={form.authPassword}
                    onChange={(value) => update("authPassword", value)}
                  />
                </>
              ) : null}
            </>
          )}

          {error ? (
            <div className="border-danger text-danger border-l-2 pl-3 text-[12px] sm:col-span-2">
              {error}
            </div>
          ) : null}

          <DialogFooter className="sm:col-span-2">
            <button type="button" onClick={onClose} className="ui-button">
              {t("common.cancel")}
            </button>
            <button type="submit" disabled={loading} className="ui-button ui-button-primary">
              {t("common.save")}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
