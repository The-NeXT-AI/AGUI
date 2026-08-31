import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/ui/cn";

export function ProjectSessionItems({
  collapsed,
  children,
}: {
  collapsed: boolean;
  children: ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);
  const previousCollapsedRef = useRef(collapsed);
  const [rendered, setRendered] = useState(!collapsed);
  const [height, setHeight] = useState<number | "auto">(collapsed ? 0 : "auto");
  const shouldRender = rendered || !collapsed;

  useEffect(() => {
    if (!collapsed) {
      setRendered(true);
    }
  }, [collapsed]);

  useLayoutEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
      previousCollapsedRef.current = collapsed;
      return;
    }

    if (!shouldRender || previousCollapsedRef.current === collapsed) return;
    previousCollapsedRef.current = collapsed;

    const content = contentRef.current;
    if (!content) return;

    let frame = 0;
    if (collapsed) {
      setHeight(content.scrollHeight);
      frame = window.requestAnimationFrame(() => setHeight(0));
    } else {
      setHeight(0);
      frame = window.requestAnimationFrame(() => setHeight(content.scrollHeight));
    }

    return () => window.cancelAnimationFrame(frame);
  }, [collapsed, shouldRender]);

  if (!shouldRender) return null;

  return (
    <div
      aria-hidden={collapsed}
      inert={collapsed}
      onTransitionEnd={(event) => {
        if (event.target !== event.currentTarget || event.propertyName !== "height") return;
        if (collapsed) setRendered(false);
        else setHeight("auto");
      }}
      style={{ height }}
      className={cn(
        "overflow-hidden transition-[height,opacity] duration-200 ease-out",
        collapsed ? "pointer-events-none opacity-0" : "opacity-100",
      )}
    >
      <div ref={contentRef}>{children}</div>
    </div>
  );
}
