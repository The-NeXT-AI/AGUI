import {
  useCallback,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { cn } from "@/ui/cn";

interface SashProps {
  orientation: "vertical" | "horizontal";
  onDrag: (delta: number) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  className?: string;
  style?: CSSProperties;
  ariaLabel: string;
  value: number;
  min: number;
  max: number;
  valuePerDrag?: 1 | -1;
}

/** Draggable separator (sidebar ↔ main). Pointer-capture based. */
export function Sash({
  orientation,
  onDrag,
  onDragStart,
  onDragEnd,
  className,
  style,
  ariaLabel,
  value,
  min,
  max,
  valuePerDrag = 1,
}: SashProps) {
  const lastRef = useRef(0);
  const draggingRef = useRef(false);
  const isVertical = orientation === "vertical";

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      draggingRef.current = true;
      lastRef.current = isVertical ? e.clientX : e.clientY;
      e.currentTarget.setPointerCapture(e.pointerId);
      onDragStart?.();
    },
    [isVertical, onDragStart],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      const current = isVertical ? e.clientX : e.clientY;
      const delta = current - lastRef.current;
      lastRef.current = current;
      if (delta !== 0) onDrag(delta);
    },
    [isVertical, onDrag],
  );

  const end = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      e.currentTarget.releasePointerCapture(e.pointerId);
      onDragEnd?.();
    },
    [onDragEnd],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const backward = isVertical ? event.key === "ArrowLeft" : event.key === "ArrowUp";
      const forward = isVertical ? event.key === "ArrowRight" : event.key === "ArrowDown";
      let delta = 0;
      if (backward) delta = event.shiftKey ? -32 : -12;
      else if (forward) delta = event.shiftKey ? 32 : 12;
      else if (event.key === "Home") delta = (min - value) / valuePerDrag;
      else if (event.key === "End") delta = (max - value) / valuePerDrag;
      else return;
      event.preventDefault();
      onDrag(delta);
    },
    [isVertical, max, min, onDrag, value, valuePerDrag],
  );

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
      style={style}
      className={cn(
        "group/sash relative z-20 shrink-0 outline-none",
        isVertical ? "w-[3px] cursor-col-resize" : "h-[3px] cursor-row-resize",
        className,
      )}
    >
      <div
        className={cn(
          "absolute",
          isVertical ? "inset-y-0 -right-1.5 -left-1.5" : "inset-x-0 -top-1.5 -bottom-1.5",
        )}
      />
      <div
        className={cn(
          "absolute transition-colors",
          isVertical ? "inset-y-0 right-0 left-0" : "inset-x-0 top-0 bottom-0",
          "group-hover/sash:bg-border group-active/sash:bg-fg/40 bg-transparent",
        )}
      />
    </div>
  );
}
