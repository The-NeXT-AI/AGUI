import { cn } from "./cn";

/** Three-dot "thinking" indicator — the AGUI working-dot-wave. */
export function WorkingDots({ className }: { className?: string }) {
  return (
    <span className={cn("working-dots", className)} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}
