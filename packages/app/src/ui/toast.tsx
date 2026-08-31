import { create } from "zustand";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { cn } from "./cn";
import { uid } from "./id";

export type ToastKind = "success" | "error" | "info";

export interface ToastItem {
  id: string;
  kind: ToastKind;
  title: string;
  description?: string;
  /** Auto-dismiss after ms; 0 keeps it until dismissed. */
  duration?: number;
}

interface ToastStore {
  toasts: ToastItem[];
  push: (t: Omit<ToastItem, "id">) => string;
  dismiss: (id: string) => void;
}

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  push: (t) => {
    const id = uid("toast");
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
    const duration = t.duration ?? 4000;
    if (duration > 0) {
      setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), duration);
    }
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

/** Imperative API — `toast.success("Saved")` from anywhere, no hooks needed. */
export const toast = {
  success: (title: string, description?: string) =>
    useToastStore.getState().push({ kind: "success", title, description }),
  error: (title: string, description?: string) =>
    useToastStore.getState().push({ kind: "error", title, description, duration: 6000 }),
  info: (title: string, description?: string) =>
    useToastStore.getState().push({ kind: "info", title, description }),
};

const ICONS = {
  success: CheckCircle2,
  error: AlertTriangle,
  info: Info,
} as const;

const COLORS = {
  success: "text-success",
  error: "text-danger",
  info: "text-info",
} as const;

/**
 * Mount once near the root. Renders the toast stack top-center; each toast
 * slides/fades in via the shared `animate-fade-in` motion.
 */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  return (
    <div className="pointer-events-none fixed top-[calc(var(--titlebar-height)+0.75rem)] left-1/2 z-[60] flex w-[min(calc(100vw-2rem),24rem)] -translate-x-1/2 flex-col gap-1.5">
      {toasts.map((t) => {
        const Icon = ICONS[t.kind];
        return (
          <div
            key={t.id}
            role="status"
            className="ui-popover-surface animate-fade-in pointer-events-auto flex items-start gap-2.5 rounded-lg px-3 py-2.5 backdrop-blur"
          >
            <Icon size={16} className={cn("mt-0.5 shrink-0", COLORS[t.kind])} />
            <div className="min-w-0 flex-1">
              <p className="text-fg truncate text-[13px] leading-5 font-medium">{t.title}</p>
              {t.description ? (
                <p className="text-muted mt-0.5 line-clamp-2 text-[11.5px] leading-4 break-words">
                  {t.description}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="ui-icon-button -mt-0.5 -mr-1 h-5 w-5 shrink-0 rounded-md"
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
