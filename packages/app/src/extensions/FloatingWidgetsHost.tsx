import type { CSSProperties } from "react";
import { useFloatingWidgets, type FloatingWidget, type FloatingWidgetPosition } from "@the-next-ai/agui-app";
import { cn } from "@/ui/cn";

const POSITIONS: FloatingWidgetPosition[] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];

const DEFAULT_POSITION: FloatingWidgetPosition = "bottom-right";
const MIN_WIDTH = 120;
const DEFAULT_WIDTH = 320;
const MAX_WIDTH = 560;
const MIN_HEIGHT = 48;
const DEFAULT_HEIGHT = 160;
const MAX_HEIGHT = 640;

export function FloatingWidgetsHost() {
  const widgets = useFloatingWidgets();
  if (!widgets.length) return null;

  const groups: Record<FloatingWidgetPosition, FloatingWidget[]> = {
    "top-left": [],
    "top-right": [],
    "bottom-left": [],
    "bottom-right": [],
  };
  for (const widget of widgets) {
    groups[floatingWidgetPosition(widget.position)].push(widget);
  }

  return (
    <div
      data-floating-widgets-host
      className="pointer-events-none fixed inset-0 z-[45]"
      aria-live="polite"
    >
      {POSITIONS.map((position) =>
        groups[position].length ? (
          <div
            key={position}
            data-floating-widget-stack={position}
            className={cn(
              "pointer-events-none fixed flex max-w-[calc(100vw-2rem)] gap-2",
              positionClass(position),
            )}
          >
            {groups[position].map((widget) => (
              <div
                key={widget.id}
                role="region"
                aria-label={widget.title}
                data-floating-widget={widget.id}
                className="ui-popover-surface text-fg pointer-events-auto overflow-hidden rounded-lg shadow-[var(--shadow-elevated)] backdrop-blur"
                style={floatingWidgetStyle(widget)}
              >
                {widget.render()}
              </div>
            ))}
          </div>
        ) : null,
      )}
    </div>
  );
}

function floatingWidgetPosition(value: unknown): FloatingWidgetPosition {
  return POSITIONS.includes(value as FloatingWidgetPosition)
    ? (value as FloatingWidgetPosition)
    : DEFAULT_POSITION;
}

function positionClass(position: FloatingWidgetPosition): string {
  if (position === "top-left") {
    return "top-[calc(var(--titlebar-height)+1rem)] left-4 flex-col items-start";
  }
  if (position === "top-right") {
    return "top-[calc(var(--titlebar-height)+1rem)] right-4 flex-col items-end";
  }
  if (position === "bottom-left") return "bottom-4 left-4 flex-col-reverse items-start";
  return "right-4 bottom-4 flex-col-reverse items-end";
}

function floatingWidgetStyle(widget: FloatingWidget): CSSProperties {
  const minWidth = clampedNumber(widget.minWidth, MIN_WIDTH, MAX_WIDTH, MIN_WIDTH);
  const maxWidth = Math.max(
    minWidth,
    clampedNumber(widget.maxWidth, minWidth, MAX_WIDTH, MAX_WIDTH),
  );
  const width = clampedNumber(widget.width, minWidth, maxWidth, DEFAULT_WIDTH);
  const minHeight = clampedNumber(widget.minHeight, MIN_HEIGHT, MAX_HEIGHT, MIN_HEIGHT);
  const maxHeight = Math.max(
    minHeight,
    clampedNumber(widget.maxHeight, minHeight, MAX_HEIGHT, MAX_HEIGHT),
  );
  const height = clampedNumber(widget.height, minHeight, maxHeight, DEFAULT_HEIGHT);
  return {
    height,
    maxHeight: `min(calc(100vh - var(--titlebar-height, 0px) - 2rem), ${maxHeight}px)`,
    maxWidth: `min(calc(100vw - 2rem), ${maxWidth}px)`,
    minHeight,
    minWidth,
    width,
  };
}

function clampedNumber(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}
