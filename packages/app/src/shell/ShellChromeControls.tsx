import { Search } from "lucide-react";
import { useUIStore } from "@/ui/ui-store";
import { DetailPanelToggleButton } from "./DetailPanelToggleButton";
import { SidebarToggleButton } from "./SidebarToggleButton";
import { useT } from "@/lib/i18n";

export function ShellChromeControls() {
  return (
    <>
      <div className="shell-toggle-hitbox shell-sidebar-toggle-hitbox">
        <SidebarToggleButton />
      </div>
      <div className="shell-toggle-hitbox shell-sidebar-search-hitbox">
        <SearchChatsButton />
      </div>
      <div className="shell-toggle-hitbox shell-detail-panel-toggle-hitbox">
        <DetailPanelToggleButton />
      </div>
    </>
  );
}

function SearchChatsButton() {
  const t = useT();
  const openSearch = () => useUIStore.getState().setSearchChatsOpen(true);

  return (
    <button
      type="button"
      title={t("searchChats.title")}
      aria-label={t("searchChats.title")}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerUp={(event) => {
        event.preventDefault();
        event.stopPropagation();
        window.setTimeout(openSearch, 0);
      }}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        openSearch();
      }}
      className="titlebar-toggle-button ui-icon-button h-10 w-10 rounded-[10px] sm:h-8 sm:w-8 sm:rounded-[8px]"
    >
      <Search size={17} strokeWidth={1.8} />
    </button>
  );
}
