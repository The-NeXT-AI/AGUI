import { useEffect, useRef } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useUIStore } from "@/ui/ui-store";
import { t } from "@/lib/i18n";

/**
 * In-conversation find bar (⌘F). The query lives in the UI store so the
 * ChatStream can read it to compute matches; this component only renders the
 * field, the match counter, and prev/next/close controls.
 */
export function FindBar({
  count,
  current,
  onPrev,
  onNext,
  onClose,
}: {
  count: number;
  current: number;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const query = useUIStore((s) => s.findQuery);
  const setQuery = useUIStore((s) => s.setFindQuery);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="border-border-subtle bg-elevated mx-auto flex w-full max-w-[var(--thread-max-width)] items-center gap-1.5 border-b px-3 py-2">
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) onPrev();
            else onNext();
          }
        }}
        placeholder={t("find.placeholder")}
        className="text-fg placeholder:text-subtle flex-1 bg-transparent text-[13px] focus:outline-none"
      />
      <span className="text-subtle min-w-[44px] text-right text-[12px]">
        {query ? (count > 0 ? `${current + 1}/${count}` : t("find.noResults")) : ""}
      </span>
      <button
        type="button"
        title={t("find.previous")}
        aria-label={t("find.previous")}
        onClick={onPrev}
        disabled={count === 0}
        className="text-muted hover:bg-surface-hover hover:text-fg flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:opacity-30"
      >
        <ChevronUp size={15} />
      </button>
      <button
        type="button"
        title={t("find.next")}
        aria-label={t("find.next")}
        onClick={onNext}
        disabled={count === 0}
        className="text-muted hover:bg-surface-hover hover:text-fg flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:opacity-30"
      >
        <ChevronDown size={15} />
      </button>
      <button
        type="button"
        title={t("common.close")}
        aria-label={t("common.close")}
        onClick={onClose}
        className="text-muted hover:bg-surface-hover hover:text-fg flex h-7 w-7 items-center justify-center rounded-md transition-colors"
      >
        <X size={15} />
      </button>
    </div>
  );
}
