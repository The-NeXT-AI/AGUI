import { Tooltip } from "@base-ui/react/tooltip";
import { isValidElement, type ReactElement, type ReactNode } from "react";

/**
 * Base UI tooltip. Wrap the app once in `TooltipProvider`, then use `<Tip>`
 * around any trigger element for an accessible, keyboard-friendly tooltip that
 * replaces the bare `title` attribute.
 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return <Tooltip.Provider delay={300}>{children}</Tooltip.Provider>;
}

export function Tip({
  label,
  children,
  side = "bottom",
  closeOnClick = true,
}: {
  label: ReactNode;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  closeOnClick?: boolean;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger closeOnClick={closeOnClick} render={renderChild(children)}>
        {childContent(children)}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner side={side} sideOffset={6} className="z-[90]">
          <Tooltip.Popup className="border-border-subtle bg-elevated text-fg relative z-[90] rounded-md border px-2 py-1 text-[11px] shadow-lg transition-opacity duration-100 data-[closed]:hidden data-[ending-style]:opacity-0 data-[starting-style]:opacity-0">
            {label}
            <Tooltip.Arrow className="fill-elevated" />
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function renderChild(children: ReactNode): ReactElement | undefined {
  return isValidElement(children) ? children : undefined;
}

function childContent(children: ReactNode): ReactNode {
  return isValidElement<{ children?: ReactNode }>(children) ? children.props.children : children;
}
