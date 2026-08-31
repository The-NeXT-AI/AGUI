import { useRef, useState } from "react";
import { FolderInput, Loader2, Puzzle } from "lucide-react";
import { PluginsPanel, type PluginsPanelHandle } from "@/panels/PluginsPanel";
import { useT } from "@/lib/i18n";

export function ExtensionsPage() {
  const t = useT();
  const panelRef = useRef<PluginsPanelHandle>(null);
  const [installBusy, setInstallBusy] = useState(false);

  return (
    <div className="bg-canvas flex min-h-0 flex-1 flex-col">
      <header className="app-titlebar app-titlebar-right-drawer-inset electron-drag-region border-border-subtle flex h-[var(--titlebar-height)] shrink-0 items-center border-b pl-3 sm:pl-4">
        <div className="flex min-w-0 items-center gap-2">
          <Puzzle size={16} className="text-muted shrink-0" />
          <h1 className="text-fg truncate text-[14px] leading-none font-semibold">
            {t("settings.section.extensions")}
          </h1>
        </div>
        <button
          type="button"
          disabled={installBusy}
          onClick={() => void panelRef.current?.install()}
          className="ui-button ml-auto h-10 shrink-0 sm:h-8"
        >
          {installBusy ? <Loader2 size={14} className="animate-spin" /> : <FolderInput size={14} />}
          {t("common.install")}
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-3xl px-4 py-5 sm:px-8 sm:py-8">
          <PluginsPanel
            ref={panelRef}
            settings
            showHeading={false}
            showDescription={false}
            showInstallButton={false}
            onInstallBusyChange={setInstallBusy}
          />
        </div>
      </div>
    </div>
  );
}
