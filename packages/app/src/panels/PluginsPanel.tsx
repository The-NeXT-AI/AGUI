import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  Download,
  FolderInput,
  History,
  Loader2,
  PackageCheck,
  Search,
  ShieldAlert,
  ShieldCheck,
  Settings2,
  Trash2,
} from "lucide-react";
import {
  desktopApi,
  type AppExtensionPermission,
  type AppExtensionRecord,
  type ExtensionAuditRecord,
  type ExtensionMarketplaceItem,
} from "@/asp/desktop-api";
import { cn } from "@/ui/cn";
import { confirmDialog } from "@/ui/confirm-dialog";
import { toast } from "@/ui/toast";
import { useExtensionStore } from "@/extensions/extension-store";
import {
  localizedConfigurationProperty,
  localizedConfigurationTitle,
  localizedManifestDescription,
  localizedManifestDisplayName,
} from "@/extensions/extension-localization";
import { resolveExtensionIcon } from "@/extensions/extension-icons";
import { ExtensionSlot } from "@/extensions/ExtensionSlot";
import { useI18nStore, useT, type TranslateFn } from "@/lib/i18n";
import { useWorkspaceStore } from "@/workspaces/workspace-store";

const PERMISSION_DETAIL_KEYS = {
  "runtime.fullTrust": "extensions.permission.runtime.fullTrust",
  "ui.render.declarative": "extensions.permission.ui.render.declarative",
  "ui.sessionTree": "extensions.permission.ui.sessionTree",
  "ui.sidebar": "extensions.permission.ui.sidebar",
  "ui.detailPanel": "extensions.permission.ui.detailPanel",
  "ui.composer": "extensions.permission.ui.composer",
  "ui.header": "extensions.permission.ui.header",
  "ui.floatingWidget": "extensions.permission.ui.floatingWidget",
  "ui.chatRenderer": "extensions.permission.ui.chatRenderer",
  "ui.webComponent.trusted": "extensions.permission.ui.webComponent.trusted",
  "ui.webview": "extensions.permission.ui.webview",
  "ui.styles": "extensions.permission.ui.styles",
  "ui.overrideBuiltins": "extensions.permission.ui.overrideBuiltins",
  theme: "extensions.permission.theme",
  commands: "extensions.permission.commands",
  "agent.skills": "extensions.permission.agent.skills",
  "agent.mcp": "extensions.permission.agent.mcp",
  "agent.prompts": "extensions.permission.agent.prompts",
  "agent.sessionContext": "extensions.permission.agent.sessionContext",
  "workspace.read": "extensions.permission.workspace.read",
  "workspace.write": "extensions.permission.workspace.write",
  network: "extensions.permission.network",
  "process.spawn": "extensions.permission.process.spawn",
  secrets: "extensions.permission.secrets",
} satisfies Record<AppExtensionPermission, string>;
const HIDDEN_EXTENSION_IDS = new Set(["agui.core"]);

function permissionDetail(permission: AppExtensionPermission, t: TranslateFn): string {
  return t(PERMISSION_DETAIL_KEYS[permission]);
}

export type PluginsPanelHandle = {
  install: () => Promise<void>;
};

type PluginsPanelProps = {
  settings?: boolean;
  showHeading?: boolean;
  showDescription?: boolean;
  showInstallButton?: boolean;
  onInstallBusyChange?: (busy: boolean) => void;
};

export const PluginsPanel = forwardRef<PluginsPanelHandle, PluginsPanelProps>(function PluginsPanel(
  {
    settings = false,
    showHeading = settings,
    showDescription = true,
    showInstallButton = true,
    onInstallBusyChange,
  },
  ref,
) {
  const t = useT();
  const lang = useI18nStore((state) => state.lang);
  const records = useExtensionStore((state) => state.records);
  const visibleRecords = records.filter((record) => !HIDDEN_EXTENSION_IDS.has(record.id));
  const loading = useExtensionStore((state) => state.loading);
  const error = useExtensionStore((state) => state.error);
  const refreshRevision = useExtensionStore((state) => state.refreshRevision);
  const chooseAndInstall = useExtensionStore((state) => state.chooseAndInstall);
  const chooseAndUpdate = useExtensionStore((state) => state.chooseAndUpdate);
  const grant = useExtensionStore((state) => state.grant);
  const setEnabled = useExtensionStore((state) => state.setEnabled);
  const update = useExtensionStore((state) => state.update);
  const uninstall = useExtensionStore((state) => state.uninstall);
  const workspacePath = useExtensionStore((state) => state.workspacePath);
  const workspaceId = useExtensionStore((state) => state.workspaceId);
  const workspaceTrusted = useExtensionStore((state) => state.workspaceTrusted);
  const setWorkspaceTrust = useExtensionStore((state) => state.setWorkspaceTrust);
  const refresh = useExtensionStore((state) => state.refresh);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const activeWorkspaceName = useWorkspaceStore(
    (state) =>
      state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId)?.name ??
      state.activeWorkspaceId,
  );
  const [busyId, setBusyId] = useState("");
  const [status, setStatus] = useState("");
  const [marketplaceQuery, setMarketplaceQuery] = useState("");
  const [marketplaceItems, setMarketplaceItems] = useState<ExtensionMarketplaceItem[]>([]);
  const [marketplaceWarnings, setMarketplaceWarnings] = useState<string[]>([]);
  const [marketplaceLoading, setMarketplaceLoading] = useState(false);
  const [auditRecords, setAuditRecords] = useState<ExtensionAuditRecord[]>([]);
  const actionBusy = loading || Boolean(busyId);
  const workspaceTrustSatisfied = !workspacePath || workspaceTrusted;
  const installedIds = useMemo(
    () => new Set(visibleRecords.map((record) => record.id)),
    [visibleRecords],
  );

  const loadAuditRecords = useCallback(async () => {
    const api = desktopApi()?.extensions;
    if (!api) return;
    try {
      setAuditRecords(
        await api.audit({
          limit: 6,
          workspacePath,
          workspaceId,
        }),
      );
    } catch {
      setAuditRecords([]);
    }
  }, [workspaceId, workspacePath]);

  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusyId(id);
    setStatus("");
    try {
      await action();
      await loadAuditRecords();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setStatus(message);
      toast.error(message);
    } finally {
      setBusyId("");
    }
  };
  const install = () =>
    run("install", async () => {
      if (activeWorkspaceId) await refresh({ workspacePath, workspaceId: activeWorkspaceId });
      await chooseAndInstall();
    });

  const installMarketplaceItem = (item: ExtensionMarketplaceItem) =>
    run(`marketplace:${item.id}`, async () => {
      const api = desktopApi()?.extensions;
      if (!api) throw new Error(t("extensions.desktopRequired"));
      await api.install({
        expectedSha256: item.sha256,
        sourceUrl: item.sourceUrl,
        updateUrl: item.updateUrl,
        workspacePath,
        workspaceId,
      });
      await refresh({ workspacePath, workspaceId });
      toast.success(t("extensions.installed"));
    });

  useImperativeHandle(ref, () => ({ install }));

  useEffect(() => {
    void refresh(workspacePath);
  }, [refresh, workspacePath]);

  useEffect(() => {
    let canceled = false;
    const api = desktopApi()?.extensions;
    if (!api) return;
    setMarketplaceLoading(true);
    void api
      .marketplace({
        query: marketplaceQuery,
        workspacePath,
        workspaceId,
      })
      .then((result) => {
        if (canceled) return;
        setMarketplaceItems(result.items);
        setMarketplaceWarnings(result.warnings);
      })
      .catch((cause) => {
        if (canceled) return;
        setMarketplaceItems([]);
        setMarketplaceWarnings([cause instanceof Error ? cause.message : String(cause)]);
      })
      .finally(() => {
        if (!canceled) setMarketplaceLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [marketplaceQuery, workspaceId, workspacePath]);

  useEffect(() => {
    void loadAuditRecords();
  }, [loadAuditRecords, refreshRevision]);

  useEffect(() => {
    onInstallBusyChange?.(actionBusy);
  }, [actionBusy, onInstallBusyChange]);

  const toggle = async (record: AppExtensionRecord) => {
    const requested = record.manifest.permissions ?? [];
    const missing = requested.filter(
      (permission) => !record.grantedPermissions.includes(permission),
    );
    if (missing.length) {
      const permissions = missing
        .map((permission) => `• ${permission}\n  ${permissionDetail(permission, t)}`)
        .join("\n\n");
      const accepted = await confirmDialog({
        title: t("extensions.permissionsTitle"),
        description: t("extensions.confirmPermissions", {
          name: localizedManifestDisplayName(record.manifest, lang) || record.id,
          permissions,
        }),
        confirmLabel: t("common.continue"),
      });
      if (!accepted) return;
      await grant(record.id, requested);
    }
    if (record.enabled && record.state !== "blocked") {
      await setEnabled(record.id, false);
      return;
    }
    await setEnabled(record.id, true);
  };
  const showToolbar = showHeading || showDescription || showInstallButton;

  return (
    <div className={settings ? "flex flex-col gap-5" : "h-full overflow-auto px-2 pb-3"}>
      {showToolbar ? (
        <div className={cn("flex items-start justify-between gap-3", !settings && "px-2 py-2")}>
          <div>
            {settings && showHeading ? (
              <h2 className="text-fg text-[18px] font-semibold">
                {t("settings.section.extensions")}
              </h2>
            ) : null}
            {showDescription ? (
              <p className="text-muted text-[12px]">{t("extensions.description")}</p>
            ) : null}
          </div>
          {showInstallButton ? (
            <button
              type="button"
              disabled={actionBusy}
              onClick={() => void install()}
              className="ui-button shrink-0 text-[12px]"
            >
              {busyId === "install" ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <FolderInput size={13} />
              )}
              {t("common.install")}
            </button>
          ) : null}
        </div>
      ) : null}

      {activeWorkspaceId ? (
        <div
          className={cn(
            "ui-soft-card flex items-center gap-3 rounded-[8px] px-4 py-3",
            !settings && "mx-2 mb-2",
          )}
        >
          <ShieldCheck
            size={16}
            className={workspaceTrustSatisfied ? "text-success" : "text-warning"}
          />
          <div className="min-w-0 flex-1">
            <div className="text-fg text-[12.5px] font-medium">{t("extensions.workspace")}</div>
            <div className="text-subtle truncate text-[11px]">{activeWorkspaceName}</div>
          </div>
          {workspacePath ? (
            <button
              type="button"
              onClick={() =>
                void run("workspace-trust", () => setWorkspaceTrust(!workspaceTrusted))
              }
              className="ui-button min-h-7 px-2.5 py-1 text-[11px]"
            >
              {workspaceTrusted ? t("common.trusted") : t("common.trust")}
            </button>
          ) : null}
        </div>
      ) : null}

      <MarketplaceSection
        busyId={busyId}
        installedIds={installedIds}
        items={marketplaceItems}
        loading={marketplaceLoading}
        query={marketplaceQuery}
        settings={settings}
        warnings={marketplaceWarnings}
        onInstall={installMarketplaceItem}
        onQueryChange={setMarketplaceQuery}
      />

      <ExtensionAuditStrip auditRecords={auditRecords} lang={lang} settings={settings} />

      {error || status ? (
        <div
          className={cn(
            "text-danger flex items-start gap-2 text-[12px]",
            settings
              ? "border-danger border-l-2 pl-3"
              : "border-danger/30 bg-danger/5 rounded-lg border p-2.5",
            !settings && "mx-2",
          )}
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          {error || status}
        </div>
      ) : null}

      <div className={cn("flex flex-col gap-2", !settings && "px-2")}>
        {visibleRecords.map((record) => {
          const toggleBusy = busyId === record.id;
          const onlineUpdateBusy = busyId === `${record.id}:update-online`;
          const localUpdateBusy = busyId === `${record.id}:update-local`;
          const recordBusy = toggleBusy || onlineUpdateBusy || localUpdateBusy;
          const requested = record.manifest.permissions ?? [];
          const displayName = localizedManifestDisplayName(record.manifest, lang) || record.id;
          const description = localizedManifestDescription(record.manifest, lang) || record.id;
          const ExtensionIcon = resolveExtensionIcon(record.id, record.manifest.icon);
          const metadata = extensionMetadata(record, t);
          const trustDescription = untrustedWorkspaceDescription(record, t);
          const canConfigure =
            record.enabled &&
            record.state !== "blocked" &&
            record.source !== "builtin" &&
            Boolean(record.manifest.contributes?.configuration);
          return (
            <article
              key={record.id}
              data-extension-id={record.id}
              data-extension-source={record.source}
              data-extension-state={record.state}
              className={cn(
                "ui-soft-card ui-soft-card-interactive rounded-[8px] px-4 py-3 transition-colors",
                !settings && "p-3",
              )}
            >
              <div className="flex items-start gap-3.5">
                <div className="border-border-subtle bg-surface-hover/70 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border">
                  <ExtensionIcon size={16} className="text-muted" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-fg min-w-0 truncate text-[14px] leading-5 font-medium">
                      {displayName}
                    </span>
                    <span className="text-subtle text-[10.5px] leading-5">
                      v{record.manifest.version}
                    </span>
                    {requested.map((permission) => (
                      <span
                        key={permission}
                        title={permissionDetail(permission, t)}
                        className="ui-badge max-w-full truncate text-[9.5px]"
                      >
                        {permission}
                      </span>
                    ))}
                  </div>
                  <p className="text-muted mt-1 line-clamp-2 text-[12.5px] leading-5">
                    {description}
                  </p>
                  {metadata.length ? (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {metadata.map((item) => (
                        <span
                          key={`${item.label}:${item.value}`}
                          title={`${item.label}: ${item.value}`}
                          className="bg-surface-hover text-subtle max-w-full truncate rounded-[6px] px-1.5 py-0.5 text-[10px]"
                        >
                          {item.label}: {item.value}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {record.security?.riskReasons.length ? (
                    <div
                      className={cn(
                        "mt-1.5 flex items-start gap-1.5 rounded-[6px] px-2 py-1.5 text-[11px] leading-4",
                        record.security.riskLevel === "high"
                          ? "bg-danger/10 text-danger"
                          : record.security.riskLevel === "medium"
                            ? "bg-warning/10 text-warning"
                            : "bg-surface-hover text-subtle",
                      )}
                    >
                      <ShieldAlert size={12} className="mt-0.5 shrink-0" />
                      <span className="min-w-0">
                        {t("extensions.security.summary", {
                          level: t(`extensions.risk.${record.security.riskLevel}`),
                          reasons: record.security.riskReasons.slice(0, 2).join(" "),
                        })}
                      </span>
                    </div>
                  ) : null}
                  {trustDescription ? (
                    <p className="text-warning mt-1.5 text-[11px] leading-4">{trustDescription}</p>
                  ) : null}
                  {record.statusMessage ? (
                    <p className="text-warning mt-1 text-[11px]">{record.statusMessage}</p>
                  ) : null}
                </div>
                <button
                  type="button"
                  disabled={record.source === "builtin" || recordBusy}
                  onClick={() => void run(record.id, () => toggle(record))}
                  data-checked={record.enabled && record.state !== "blocked" ? "true" : undefined}
                  className="ui-switch"
                  aria-label={record.enabled ? t("extensions.disable") : t("extensions.enable")}
                >
                  <span className="ui-switch-thumb">
                    {toggleBusy ? (
                      <Loader2 size={9} className="animate-spin" />
                    ) : record.enabled ? (
                      <Check size={9} />
                    ) : null}
                  </span>
                </button>
              </div>
              {record.source === "user" ? (
                <div className="mt-2 flex flex-wrap justify-end gap-2">
                  <button
                    type="button"
                    disabled={actionBusy || !record.updateUrl || !record.updateSha256}
                    title={
                      record.updateUrl
                        ? record.updateSha256
                          ? record.updateUrl
                          : t("extensions.noUpdateIntegrity")
                        : t("extensions.noUpdateUrl")
                    }
                    onClick={() =>
                      void run(`${record.id}:update-online`, async () => {
                        if (activeWorkspaceId)
                          await refresh({ workspacePath, workspaceId: activeWorkspaceId });
                        if (!record.updateSha256)
                          throw new Error(t("extensions.noUpdateIntegrity"));
                        await update(record.id, { expectedSha256: record.updateSha256 });
                        toast.success(t("extensions.updated"));
                      })
                    }
                    className="ui-button min-h-7 px-2 py-1 text-[11px]"
                  >
                    {onlineUpdateBusy ? (
                      <Loader2 size={11} className="animate-spin" />
                    ) : (
                      <Download size={11} />
                    )}
                    {t("extensions.updateOnline")}
                  </button>
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={() =>
                      void run(`${record.id}:update-local`, async () => {
                        if (activeWorkspaceId)
                          await refresh({ workspacePath, workspaceId: activeWorkspaceId });
                        const updated = await chooseAndUpdate(record.id);
                        if (updated) toast.success(t("extensions.updated"));
                      })
                    }
                    className="ui-button min-h-7 px-2 py-1 text-[11px]"
                  >
                    {localUpdateBusy ? (
                      <Loader2 size={11} className="animate-spin" />
                    ) : (
                      <FolderInput size={11} />
                    )}
                    {t("extensions.updateFromFile")}
                  </button>
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={() => {
                      void (async () => {
                        const confirmed = await confirmDialog({
                          title: t("extensions.uninstallTitle"),
                          description: t("extensions.uninstallConfirm", {
                            name: displayName,
                          }),
                          confirmLabel: t("common.uninstall"),
                          tone: "danger",
                        });
                        if (!confirmed) return;
                        void run(record.id, async () => {
                          if (activeWorkspaceId)
                            await refresh({ workspacePath, workspaceId: activeWorkspaceId });
                          await uninstall(record.id);
                        });
                      })();
                    }}
                    className="ui-button ui-button-danger min-h-7 px-2 py-1 text-[11px]"
                  >
                    <Trash2 size={11} /> {t("common.uninstall")}
                  </button>
                </div>
              ) : null}
              {canConfigure ? <ExtensionConfigurationEditor record={record} /> : null}
            </article>
          );
        })}
      </div>
    </div>
  );
});

function MarketplaceSection({
  busyId,
  installedIds,
  items,
  loading,
  query,
  settings,
  warnings,
  onInstall,
  onQueryChange,
}: {
  busyId: string;
  installedIds: Set<string>;
  items: ExtensionMarketplaceItem[];
  loading: boolean;
  query: string;
  settings: boolean;
  warnings: string[];
  onInstall: (item: ExtensionMarketplaceItem) => void;
  onQueryChange: (query: string) => void;
}) {
  const t = useT();
  return (
    <section className={cn("flex flex-col gap-2", !settings && "mx-2")}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <PackageCheck size={14} className="text-info shrink-0" />
          <span className="text-fg text-[12.5px] font-medium">
            {t("extensions.marketplace.title")}
          </span>
        </div>
        {loading ? <Loader2 size={13} className="text-muted shrink-0 animate-spin" /> : null}
      </div>
      <label className="relative block">
        <Search
          size={13}
          className="text-subtle pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2"
        />
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t("extensions.marketplace.search")}
          className="ui-field h-8 pl-8 text-[12px]"
        />
      </label>
      {warnings.length ? (
        <div className="text-warning flex flex-col gap-1 text-[11px]">
          {warnings.slice(0, 3).map((warning) => (
            <span key={warning}>{warning}</span>
          ))}
        </div>
      ) : null}
      {items.length ? (
        <div className="grid gap-2">
          {items.slice(0, 6).map((item) => {
            const installed = installedIds.has(item.id);
            const busy = busyId === `marketplace:${item.id}`;
            return (
              <article
                key={item.id}
                className="border-border-subtle bg-surface/35 rounded-[8px] border px-3 py-2.5"
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span className="text-fg truncate text-[12.5px] font-medium">
                        {item.displayName}
                      </span>
                      <span className="text-subtle text-[10.5px]">v{item.version}</span>
                      {item.verifiedPublisher ? (
                        <span className="bg-success/10 text-success rounded-full px-1.5 py-0.5 text-[9.5px]">
                          {t("extensions.marketplace.verified")}
                        </span>
                      ) : null}
                      {item.releaseChannel && item.releaseChannel !== "stable" ? (
                        <span className="bg-warning/10 text-warning rounded-full px-1.5 py-0.5 text-[9.5px]">
                          {item.releaseChannel}
                        </span>
                      ) : null}
                    </div>
                    {item.description ? (
                      <p className="text-muted mt-1 line-clamp-2 text-[11.5px] leading-4">
                        {item.description}
                      </p>
                    ) : null}
                    <div className="text-subtle mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[10.5px]">
                      <span>{item.id}</span>
                      <span>{t("extensions.marketplace.integrity")}</span>
                      {item.permissions?.length ? (
                        <span>
                          {t("extensions.marketplace.permissions", {
                            count: item.permissions.length,
                          })}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={installed || busy}
                    onClick={() => onInstall(item)}
                    className="ui-button min-h-7 shrink-0 px-2 py-1 text-[11px]"
                  >
                    {busy ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
                    {installed ? t("extensions.marketplace.installed") : t("common.install")}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : loading ? null : (
        <div className="text-subtle bg-surface/35 rounded-[8px] px-3 py-2 text-[11.5px]">
          {query ? t("extensions.marketplace.empty") : t("extensions.marketplace.noSources")}
        </div>
      )}
    </section>
  );
}

function ExtensionAuditStrip({
  auditRecords,
  lang,
  settings,
}: {
  auditRecords: ExtensionAuditRecord[];
  lang: "en" | "zh";
  settings: boolean;
}) {
  const t = useT();
  return (
    <section className={cn("flex flex-col gap-2", !settings && "mx-2")}>
      <div className="flex items-center gap-2">
        <History size={14} className="text-muted" />
        <span className="text-fg text-[12.5px] font-medium">{t("extensions.audit.title")}</span>
      </div>
      {auditRecords.length ? (
        <div className="border-border-subtle divide-border-subtle bg-surface/35 divide-y rounded-[8px] border">
          {auditRecords.slice(0, 4).map((record) => (
            <div key={record.id} className="flex items-start gap-2 px-3 py-2">
              <span
                className={cn(
                  "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
                  record.outcome === "success" ? "bg-success" : "bg-danger",
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="text-fg truncate text-[11.5px]">
                  {t(`extensions.audit.action.${record.action}`)}{" "}
                  {record.extensionId ? (
                    <span className="text-subtle">{record.extensionId}</span>
                  ) : null}
                </div>
                <div className="text-subtle text-[10.5px]">
                  {formatPanelTimestamp(record.at, lang)}
                  {record.message ? ` · ${record.message}` : ""}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-subtle bg-surface/35 rounded-[8px] px-3 py-2 text-[11.5px]">
          {t("extensions.audit.empty")}
        </div>
      )}
    </section>
  );
}

function ExtensionConfigurationEditor({ record }: { record: AppExtensionRecord }) {
  const t = useT();
  const lang = useI18nStore((state) => state.lang);
  const refreshExtensions = useExtensionStore((state) => state.refresh);
  const workspacePath = useExtensionStore((state) => state.workspacePath);
  const workspaceId = useExtensionStore((state) => state.workspaceId);
  const configuration = record.manifest.contributes?.configuration;
  const properties = useMemo(() => configuration?.properties ?? {}, [configuration?.properties]);
  const restrictedKeys = useMemo(() => restrictedConfigurationKeys(record), [record]);
  const visibleProperties = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(properties).filter(
          ([key, property]) => !property.restricted && !restrictedKeys.has(key),
        ),
      ),
    [properties, restrictedKeys],
  );
  const hasVisibleProperties = Object.keys(visibleProperties).length > 0;
  const configurationTitle = localizedConfigurationTitle(record.manifest, lang);
  const configurationView = configuration?.view;
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [configuredSecrets, setConfiguredSecrets] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    let canceled = false;
    void desktopApi()
      ?.extensions.getConfiguration({ extensionId: record.id, workspacePath, workspaceId })
      .then((rawResult) => {
        if (canceled) return;
        const result = filterRestrictedConfigurationResult(rawResult, restrictedKeys);
        const initial: Record<string, unknown> = { ...result.values };
        for (const [key, property] of Object.entries(visibleProperties)) {
          if (property.secret) initial[key] = "";
          else if (
            (property.type === "array" || property.type === "object") &&
            initial[key] !== undefined
          ) {
            initial[key] = JSON.stringify(initial[key], null, 2);
          }
        }
        setValues(initial);
        setConfiguredSecrets(result.configuredSecrets);
      })
      .catch((error) => toast.error(error instanceof Error ? error.message : String(error)));
    return () => {
      canceled = true;
    };
  }, [open, record.id, restrictedKeys, visibleProperties, workspaceId, workspacePath]);

  if (!hasVisibleProperties && !configurationView) return null;
  const executeConfigurationCommand = async (command: string, args: unknown[]) => {
    const api = desktopApi()?.extensions;
    if (!api) throw new Error(t("extensions.desktopRequired"));
    if (command === "agui.configuration.get") {
      const result = filterRestrictedConfigurationResult(
        await api.getConfiguration({
          extensionId: record.id,
          workspacePath,
          workspaceId,
        }),
        restrictedKeys,
      );
      setValues((current) => ({ ...current, ...result.values }));
      setConfiguredSecrets(result.configuredSecrets);
      return result;
    }
    if (command === "agui.configuration.update") {
      const nextValues = configurationCommandRecord(args[0]);
      assertNoRestrictedConfigurationUpdates(nextValues, restrictedKeys);
      const result = filterRestrictedConfigurationResult(
        await api.updateConfiguration({
          extensionId: record.id,
          values: nextValues,
          workspacePath,
          workspaceId,
        }),
        restrictedKeys,
      );
      const visibleNextValues = Object.fromEntries(
        Object.entries(nextValues).filter(
          ([key]) => properties[key]?.secret !== true && !restrictedKeys.has(key),
        ),
      );
      setValues((current) => ({ ...current, ...visibleNextValues }));
      setConfiguredSecrets(result.configuredSecrets);
      return result;
    }
    if (command === "agui.extensions.refresh") {
      await refreshExtensions();
      return true;
    }
    if (command === "agui.host.openExternal") {
      const url = safeConfigurationUrl(args[0]);
      if (!url) throw new Error("Only https URLs can be opened from extension configuration.");
      const opened = await desktopApi()?.window?.openExternal?.(url);
      if (opened) return true;
      window.open(url, "_blank", "noopener,noreferrer");
      return true;
    }
    if (command.startsWith(`${record.id}.`) || command.startsWith(`${record.id}/`)) {
      return api.executeCommand({
        extensionId: record.id,
        command,
        args,
        workspacePath,
        workspaceId,
      });
    }
    throw new Error("Configuration views can only call host configuration APIs or this extension.");
  };
  const save = async () => {
    setSaving(true);
    try {
      const updates: Record<string, unknown> = {};
      for (const [key, property] of Object.entries(visibleProperties)) {
        const value = values[key];
        if (property.secret && value === "") continue;
        if (property.type === "number") updates[key] = Number(value);
        else if (property.type === "array" || property.type === "object")
          updates[key] = typeof value === "string" ? JSON.parse(value) : value;
        else updates[key] = value;
      }
      const result = await desktopApi()?.extensions.updateConfiguration({
        extensionId: record.id,
        values: updates,
        workspacePath,
        workspaceId,
      });
      if (!result) throw new Error(t("extensions.desktopRequired"));
      setConfiguredSecrets(result.configuredSecrets);
      setValues((current) =>
        Object.fromEntries(
          Object.entries(current).map(([key, value]) => [
            key,
            visibleProperties[key]?.secret ? "" : value,
          ]),
        ),
      );
      toast.success(t("common.saved"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-border-subtle mt-2 border-t pt-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="ui-button min-h-7 px-2 py-1 text-[11px]"
      >
        <Settings2 size={11} /> {open ? t("common.hideConfiguration") : t("common.configure")}
      </button>
      {open ? (
        <div className="border-border-subtle bg-surface/35 mt-2 flex flex-col gap-2 rounded-[8px] border p-2.5">
          {configurationTitle ? (
            <div className="text-fg text-[12px] font-medium">{configurationTitle}</div>
          ) : null}
          {restrictedKeys.size ? (
            <div className="border-warning/30 bg-warning/5 text-warning rounded-[6px] border px-2 py-1.5 text-[11px]">
              {t("extensions.restrictedConfiguration", {
                keys: [...restrictedKeys].join(", "),
              })}
            </div>
          ) : null}
          {configurationView ? (
            <ExtensionSlot
              record={record}
              contribution={{
                id: configurationView.id,
                name: configurationView.name || configurationTitle || record.id,
                viewType: configurationView.viewType,
                entry: configurationView.entry,
                activationEvent: configurationView.activationEvent,
              }}
              data={{
                configuredSecrets,
                language: lang,
                restrictedConfigurations: [...restrictedKeys],
                values: filterRestrictedValues(values, restrictedKeys),
                workspaceTrusted: record.workspaceTrusted,
              }}
              surface="configuration"
              className="min-h-0"
              executeCommand={executeConfigurationCommand}
            />
          ) : null}
          {hasVisibleProperties ? (
            <>
              {Object.entries(visibleProperties).map(([key, property]) => {
                const localized = localizedConfigurationProperty(
                  record.manifest,
                  lang,
                  key,
                  property,
                );
                return (
                  <label key={key} className="text-muted flex flex-col gap-1 text-[11px]">
                    <span className="text-fg font-medium">{localized.title}</span>
                    {localized.description ? (
                      <span className="text-subtle text-[10px]">{localized.description}</span>
                    ) : null}
                    {property.type === "boolean" ? (
                      <input
                        type="checkbox"
                        checked={Boolean(values[key])}
                        onChange={(event) =>
                          setValues((current) => ({ ...current, [key]: event.target.checked }))
                        }
                        className="h-4 w-4"
                      />
                    ) : property.enum?.length ? (
                      <select
                        value={String(values[key] ?? "")}
                        onChange={(event) =>
                          setValues((current) => ({ ...current, [key]: event.target.value }))
                        }
                        className="ui-field py-1.5 text-[11px]"
                      >
                        {property.enum.map((item) => (
                          <option key={String(item)} value={String(item)}>
                            {localized.enumLabel(item)}
                          </option>
                        ))}
                      </select>
                    ) : property.type === "array" || property.type === "object" ? (
                      <textarea
                        value={String(values[key] ?? "")}
                        onChange={(event) =>
                          setValues((current) => ({ ...current, [key]: event.target.value }))
                        }
                        rows={4}
                        className="ui-field resize-y py-1.5 font-mono text-[11px]"
                      />
                    ) : (
                      <input
                        type={
                          property.secret
                            ? "password"
                            : property.type === "number"
                              ? "number"
                              : "text"
                        }
                        value={String(values[key] ?? "")}
                        placeholder={
                          property.secret && configuredSecrets.includes(key)
                            ? t("extensions.configuredSecretPlaceholder")
                            : undefined
                        }
                        onChange={(event) =>
                          setValues((current) => ({ ...current, [key]: event.target.value }))
                        }
                        className="ui-field py-1.5 text-[11px]"
                      />
                    )}
                  </label>
                );
              })}
              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void save()}
                  className="ui-button ui-button-primary min-h-7 px-2 py-1 text-[11px]"
                >
                  {saving ? t("common.saving") : t("common.save")}
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function extensionMetadata(
  record: AppExtensionRecord,
  t: TranslateFn,
): Array<{ label: string; value: string }> {
  const manifest = record.manifest;
  return [
    manifest.license ? { label: t("extensions.meta.license"), value: manifest.license } : undefined,
    manifest.extensionKind?.length
      ? { label: t("extensions.meta.kind"), value: manifest.extensionKind.join(", ") }
      : undefined,
    manifest.browser ? { label: t("extensions.meta.browser"), value: manifest.browser } : undefined,
    manifest.activationEvents?.length
      ? {
          label: t("extensions.meta.activation"),
          value: manifest.activationEvents.slice(0, 4).join(", "),
        }
      : undefined,
    record.security
      ? {
          label: t("extensions.meta.risk"),
          value: t(`extensions.risk.${record.security.riskLevel}`),
        }
      : undefined,
    record.security?.verifiedIdentity
      ? { label: t("extensions.meta.identity"), value: t("common.verified") }
      : undefined,
    manifest.capabilities?.untrustedWorkspaces?.supported !== undefined
      ? {
          label: t("extensions.meta.untrusted"),
          value: String(manifest.capabilities.untrustedWorkspaces.supported),
        }
      : undefined,
  ].filter((item): item is { label: string; value: string } => Boolean(item));
}

function untrustedWorkspaceDescription(record: AppExtensionRecord, t: TranslateFn): string {
  if (record.source !== "workspace" || record.workspaceTrusted) return "";
  const support = record.manifest.capabilities?.untrustedWorkspaces;
  if (!support || support.supported === false) return "";
  const description = support.description?.trim();
  const restricted = support.restrictedConfigurations?.filter(Boolean) ?? [];
  const prefix =
    description ||
    (support.supported === "limited"
      ? t("extensions.untrustedLimited")
      : t("extensions.untrustedSupported"));
  return restricted.length
    ? `${prefix} ${t("extensions.untrustedRestrictedConfigurations", {
        keys: restricted.join(", "),
      })}`
    : prefix;
}

function restrictedConfigurationKeys(record: AppExtensionRecord): Set<string> {
  if (record.source !== "workspace" || record.workspaceTrusted) return new Set();
  return new Set(
    (record.manifest.capabilities?.untrustedWorkspaces?.restrictedConfigurations ?? [])
      .map((key) => key.trim())
      .filter(Boolean),
  );
}

function filterRestrictedConfigurationResult<
  T extends { values: Record<string, unknown>; configuredSecrets: string[] },
>(result: T, restrictedKeys: Set<string>): T {
  if (!restrictedKeys.size) return result;
  return {
    ...result,
    values: filterRestrictedValues(result.values, restrictedKeys),
    configuredSecrets: result.configuredSecrets.filter((key) => !restrictedKeys.has(key)),
  };
}

function filterRestrictedValues(
  values: Record<string, unknown>,
  restrictedKeys: Set<string>,
): Record<string, unknown> {
  if (!restrictedKeys.size) return values;
  return Object.fromEntries(Object.entries(values).filter(([key]) => !restrictedKeys.has(key)));
}

function assertNoRestrictedConfigurationUpdates(
  values: Record<string, unknown>,
  restrictedKeys: Set<string>,
): void {
  const blocked = Object.keys(values).filter((key) => restrictedKeys.has(key));
  if (blocked.length) {
    throw new Error(
      `Extension configuration is restricted in untrusted workspaces: ${blocked.join(", ")}`,
    );
  }
}

function configurationCommandRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeConfigurationUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function formatPanelTimestamp(timestamp: number, lang: "en" | "zh"): string {
  return new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}
