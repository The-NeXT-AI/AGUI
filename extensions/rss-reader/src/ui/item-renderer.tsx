import "./styles.css";

import { type ReactNode } from "react";
import { ExternalLink, Rss, UserRound } from "lucide-react";
import { aguiCommand, recordValue, safeWebUrl, stringValue, useAguiData } from "./common";
import { mount } from "./mount";

type Metadata = Record<string, unknown>;

function ItemRenderer() {
  const data = useAguiData();
  const metadata = recordValue(recordValue(data).metadata);
  const title = stringValue(metadata.title) || stringValue(recordValue(data).text) || "RSS";
  const feedTitle = stringValue(metadata.feedTitle) || "RSS";
  const url = safeWebUrl(metadata.url);
  const siteUrl = safeWebUrl(metadata.siteUrl);
  const author = stringValue(metadata.author);
  const date = displayDate(stringValue(metadata.publishedAt) || stringValue(metadata.updatedAt));
  const categories = categoriesFrom(metadata);

  return (
    <article className="max-w-[980px] text-[var(--agui-fg)]">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Tag icon={<Rss className="size-3.5" aria-hidden="true" />} url={siteUrl}>
          {feedTitle}
        </Tag>
        {author ? (
          <Tag icon={<UserRound className="size-3.5" aria-hidden="true" />}>{author}</Tag>
        ) : null}
        {date ? <Tag>{date}</Tag> : null}
        {categories.map((category) => (
          <Tag key={category}>{category}</Tag>
        ))}
      </div>

      <div className="flex min-w-0 items-start justify-between gap-3">
        <h3 className="min-w-0 flex-1 text-2xl leading-[1.22] font-bold tracking-[0] [overflow-wrap:anywhere] max-[640px]:text-xl">
          {title}
        </h3>
        {url ? (
          <button
            type="button"
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[7px] border border-[var(--agui-border)] bg-[color-mix(in_srgb,var(--agui-surface)_88%,transparent)] px-2.5 text-[12px] font-semibold text-[var(--agui-fg)]"
            onClick={() => openExternal(url)}
          >
            <ExternalLink className="size-3.5" aria-hidden="true" />
            <span>Open</span>
          </button>
        ) : null}
      </div>
    </article>
  );
}

function Tag({ children, icon, url }: { children: string; icon?: ReactNode; url?: string }) {
  const content = (
    <>
      {icon}
      <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{children}</span>
    </>
  );
  const className =
    "inline-flex h-[26px] max-w-full items-center gap-1.5 rounded-full border border-[var(--agui-border)] bg-[color-mix(in_srgb,var(--agui-surface)_86%,transparent)] px-2.5 text-[12px] leading-none text-[var(--agui-muted)]";
  return url ? (
    <button
      type="button"
      className={`${className} hover:text-[var(--agui-fg)]`}
      onClick={() => openExternal(url)}
    >
      {content}
    </button>
  ) : (
    <span className={className}>{content}</span>
  );
}

function openExternal(url: string) {
  const safe = safeWebUrl(url);
  if (!safe) return;
  aguiCommand("agui.host.openExternal", [safe]).catch(() => undefined);
}

function categoriesFrom(metadata: Metadata): string[] {
  return Array.isArray(metadata.categories)
    ? metadata.categories.map(stringValue).filter(Boolean).slice(0, 6)
    : [];
}

function displayDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(document.documentElement.lang || undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

mount(<ItemRenderer />);
