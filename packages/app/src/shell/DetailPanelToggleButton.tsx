import { useShellStore } from "@the-next-ai/agui-app";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import type { CSSProperties } from "react";
import { cn } from "@/ui/cn";
import { useT } from "@/lib/i18n";
import { useProductConfig } from "@/product/product-config";
import { panesNeedMutualExclusion } from "./pane-layout";

export function DetailPanelToggleButton({ className }: { className?: string }) {
  const detailPanelOpen = useShellStore((s) => s.detailPanelOpen);
  const toggleDetailPanel = useShellStore((s) => s.toggleDetailPanel);
  const detailPanelWidth = useShellStore((s) => s.detailPanelWidth);
  const sidebarOpen = useShellStore((s) => s.sidebarOpen);
  const sidebarWidth = useShellStore((s) => s.sidebarWidth);
  const setSidebarOpen = useShellStore((s) => s.setSidebarOpen);
  const t = useT();
  const minimumMainWidth = useProductConfig().layout.minimumMainWidth;
  const label = detailPanelOpen ? t("layout.collapseDetailPanel") : t("layout.expandDetailPanel");
  const Icon = detailPanelOpen ? PanelRightClose : PanelRightOpen;

  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-app-shell-detail-panel-trigger
      style={{ viewTransitionName: "detail-panel-trigger" } as CSSProperties}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        if (
          !detailPanelOpen &&
          sidebarOpen &&
          panesNeedMutualExclusion(
            window.innerWidth,
            sidebarWidth,
            detailPanelWidth,
            minimumMainWidth,
          )
        ) {
          setSidebarOpen(false);
        }
        toggleDetailPanel();
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
