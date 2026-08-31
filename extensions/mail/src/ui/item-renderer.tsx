import "./styles.css";

import { CalendarClock, MailOpen, UserRound } from "lucide-react";
import { recordValue, stringValue, useAguiData } from "./common";
import { mount } from "./mount";

function ItemRenderer() {
  const data = useAguiData();
  const metadata = recordValue(recordValue(data).metadata);
  const subject =
    stringValue(metadata.subject) || stringValue(recordValue(data).text) || "(no subject)";
  const from = stringValue(metadata.from);
  const date = stringValue(metadata.date);
  const preview = stringValue(metadata.preview);

  return (
    <article className="text-[var(--agui-fg)]">
      <h3 className="mb-3 flex items-start gap-2 text-xl font-bold tracking-[0]">
        <MailOpen className="mt-0.5 size-5 shrink-0 text-[var(--agui-accent)]" aria-hidden="true" />
        <span className="min-w-0 [overflow-wrap:anywhere]">{subject}</span>
      </h3>
      <div className="mb-3 flex flex-wrap gap-2">
        {from ? (
          <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--agui-border)] bg-[color-mix(in_srgb,var(--agui-surface)_86%,transparent)] px-2.5 py-1 text-[var(--agui-muted)]">
            <UserRound className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate">{from}</span>
          </span>
        ) : null}
        {date ? (
          <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--agui-border)] bg-[color-mix(in_srgb,var(--agui-surface)_86%,transparent)] px-2.5 py-1 text-[var(--agui-muted)]">
            <CalendarClock className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate">{date}</span>
          </span>
        ) : null}
      </div>
      {preview ? (
        <p className="rounded-[7px] border border-[color-mix(in_srgb,var(--agui-border)_70%,transparent)] bg-[color-mix(in_srgb,var(--agui-surface)_82%,transparent)] p-3 leading-relaxed whitespace-pre-wrap text-[var(--agui-fg)]">
          {preview}
        </p>
      ) : null}
    </article>
  );
}

mount(<ItemRenderer />);
