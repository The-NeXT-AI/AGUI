import type { ReactNode } from "react";
import { cn } from "@/ui/cn";

export function StatusDot({ status }: { status?: "offline" | "online" | "unknown" }) {
  return (
    <span
      className={cn(
        "h-2 w-2 rounded-full",
        status === "online" ? "bg-success" : status === "offline" ? "bg-danger" : "bg-subtle",
      )}
    />
  );
}

export function TextAreaField({
  label,
  onChange,
  rows,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  rows: number;
  value: string;
}) {
  return (
    <div className="sm:col-span-2">
      <label className="text-subtle mb-1.5 block text-[11px] font-semibold tracking-wide uppercase">
        {label}
      </label>
      <textarea
        rows={rows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="ui-field resize-y font-mono text-[12.5px]"
      />
    </div>
  );
}

export function TextInput({
  label,
  type,
  value,
  disabled,
  onChange,
}: {
  label: string;
  type?: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      <span className="text-subtle mb-1.5 block text-[11px] font-semibold tracking-wide uppercase">
        {label}
      </span>
      <input
        type={type}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="ui-field text-[13px] disabled:opacity-50"
      />
    </label>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-subtle mb-1.5 text-[11px] font-semibold tracking-wide uppercase">
        {label}
      </div>
      {children}
    </div>
  );
}
