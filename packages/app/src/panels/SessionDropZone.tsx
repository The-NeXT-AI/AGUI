import type { DragEvent } from "react";
import { cn } from "@/ui/cn";

export function DropZone({
  active,
  depth,
  onDragOver,
  onDrop,
  visible,
}: {
  active: boolean;
  depth: number;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  visible: boolean;
}) {
  if (!visible && !active) return null;

  return (
    <div
      aria-label="Drop session"
      onDragOver={onDragOver}
      onDrop={onDrop}
      style={{ marginLeft: depth * 10 }}
      className={cn(
        "h-2 rounded-full border border-transparent transition-colors",
        active && "border-info bg-info/15",
      )}
    />
  );
}
