import { create } from "zustand";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { useT } from "@/lib/i18n";
import { uid } from "@/ui/id";

type ConfirmTone = "default" | "danger";
type ConfirmKind = "confirm" | "alert";

type ConfirmDialogRequest = {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
};

type ConfirmDialogItem = ConfirmDialogRequest & {
  id: string;
  kind: ConfirmKind;
  resolve: (confirmed: boolean) => void;
};

interface ConfirmDialogStore {
  active: ConfirmDialogItem | null;
  queue: ConfirmDialogItem[];
  enqueue: (item: ConfirmDialogItem) => void;
  respond: (id: string, confirmed: boolean) => void;
}

const useConfirmDialogStore = create<ConfirmDialogStore>((set) => ({
  active: null,
  queue: [],
  enqueue: (item) =>
    set((state) =>
      state.active ? { queue: [...state.queue, item] } : { active: item, queue: state.queue },
    ),
  respond: (id, confirmed) => {
    let resolved: ConfirmDialogItem | undefined;
    set((state) => {
      if (!state.active || state.active.id !== id) return state;
      resolved = state.active;
      const [next, ...rest] = state.queue;
      return { active: next ?? null, queue: rest };
    });
    if (resolved) resolved.resolve(confirmed);
  },
}));

export function confirmDialog(request: ConfirmDialogRequest): Promise<boolean> {
  return new Promise((resolve) => {
    useConfirmDialogStore.getState().enqueue({
      id: uid("confirm"),
      kind: "confirm",
      tone: "default",
      ...request,
      resolve,
    });
  });
}

export function alertDialog(request: Omit<ConfirmDialogRequest, "cancelLabel" | "tone">) {
  return new Promise<void>((resolve) => {
    useConfirmDialogStore.getState().enqueue({
      id: uid("alert"),
      kind: "alert",
      tone: "default",
      ...request,
      resolve: () => resolve(),
    });
  });
}

export function ConfirmDialogHost() {
  const t = useT();
  const active = useConfirmDialogStore((state) => state.active);
  const respond = useConfirmDialogStore((state) => state.respond);

  const close = (confirmed: boolean) => {
    if (active) respond(active.id, confirmed);
  };

  return (
    <Dialog
      open={Boolean(active)}
      onOpenChange={(open) => {
        if (!open) close(false);
      }}
    >
      {active ? (
        <DialogContent
          className="flex max-h-[calc(100vh-32px)] max-w-sm flex-col overflow-hidden"
          showClose={active.kind === "confirm"}
        >
          <DialogHeader className="shrink-0">
            <DialogTitle>{active.title}</DialogTitle>
          </DialogHeader>
          {active.description ? (
            <DialogDescription className="min-h-0 overflow-y-auto pr-1 whitespace-pre-line">
              {active.description}
            </DialogDescription>
          ) : null}
          <DialogFooter className="shrink-0">
            {active.kind === "confirm" ? (
              <button type="button" className="ui-button" onClick={() => close(false)}>
                {active.cancelLabel ?? t("common.cancel")}
              </button>
            ) : null}
            <button
              type="button"
              className={
                active.tone === "danger"
                  ? "ui-button ui-button-danger-primary"
                  : "ui-button ui-button-primary"
              }
              onClick={() => close(true)}
              autoFocus
            >
              {active.confirmLabel ?? t("common.ok")}
            </button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
