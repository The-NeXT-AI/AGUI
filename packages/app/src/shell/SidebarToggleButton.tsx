import { useShellStore } from "@the-next-ai/agui-app";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { CSSProperties } from "react";
import { cn } from "@/ui/cn";
import { useT } from "@/lib/i18n";
import { useProductConfig } from "@/product/product-config";
import { panesNeedMutualExclusion } from "./pane-layout";

export function SidebarToggleButton({ className }: { className?: string }) {
  const sidebarOpen = useShellStore((s) => s.sidebarOpen);
  const toggleSidebar = useShellStore((s) => s.toggleSidebar);
  const sidebarWidth = useShellStore((s) => s.sidebarWidth);
  const detailPanelOpen = useShellStore((s) => s.detailPanelOpen);
  const detailPanelWidth = useShellStore((s) => s.detailPanelWidth);
  const setDetailPanelOpen = useShellStore((s) => s.setDetailPanelOpen);
  const t = useT();
  const minimumMainWidth = useProductConfig().layout.minimumMainWidth;
  const label = sidebarOpen ? t("layout.collapseSidebar") : t("layout.expandSidebar");
  const Icon = sidebarOpen ? PanelLeftClose : PanelLeftOpen;

  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-app-shell-sidebar-trigger
      style={{ viewTransitionName: "sidebar-trigger" } as CSSProperties}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        if (
          !sidebarOpen &&
          detailPanelOpen &&
          panesNeedMutualExclusion(
            window.innerWidth,
            sidebarWidth,
            detailPanelWidth,
            minimumMainWidth,
          )
        ) {
          setDetailPanelOpen(false);
        }
        toggleSidebar();
      }}
      className={cn(
        "titlebar-toggle-button ui-icon-button h-10 w-10 rounded-[10px] sm:h-8 sm:w-8 sm:rounded-[8px]",
        className,
      )}
    >
      <Icon size={18} strokeWidth={1.8} />
    </button>
  );
}
