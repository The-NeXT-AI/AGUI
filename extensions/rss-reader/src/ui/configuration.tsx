import "./styles.css";

import { useEffect, useMemo, useState } from "react";
import { Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { aguiCommand, numberValue, recordValue, stringValue, useAguiData } from "./common";
import { mount } from "./mount";

const NAMESPACE = "agui.rss-reader";
const ENABLED_KEY = `${NAMESPACE}.enabled`;
const FEEDS_KEY = `${NAMESPACE}.feeds`;
const MAX_ITEMS_KEY = `${NAMESPACE}.maxItemsPerFeed`;
const INCLUDE_CONTENT_KEY = `${NAMESPACE}.includeContent`;

type Language = "en" | "zh";

type FeedDraft = {
  enabled: boolean;
  id: string;
  title: string;
  url: string;
};

const labels = {
  en: {
    addFeed: "Add feed",
    enabled: "Enabled",
    feedTitle: "Title",
    feedUrl: "Feed URL",
    feeds: "Feeds",
    includeContent: "Load article content",
    maxItems: "Items per page",
    refresh: "Refresh tree",
    remove: "Remove",
    rssSettings: "RSS settings",
    save: "Save",
    saved: "Saved.",
    urlRequired: "Each enabled feed needs an HTTP or HTTPS URL.",
  },
  zh: {
    addFeed: "添加源",
    enabled: "启用",
    feedTitle: "标题",
    feedUrl: "Feed URL",
    feeds: "订阅源",
    includeContent: "加载原文正文",
    maxItems: "每页显示数量",
    refresh: "刷新会话树",
    remove: "删除",
    rssSettings: "RSS 设置",
    save: "保存",
    saved: "已保存。",
    urlRequired: "每个启用的订阅源都需要 HTTP 或 HTTPS URL。",
  },
} as const;

function Configuration() {
  const data = useAguiData();
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [feeds, setFeeds] = useState<FeedDraft[]>([]);
  const [includeContent, setIncludeContent] = useState(true);
  const [language, setLanguage] = useState<Language>("en");
  const [maxItems, setMaxItems] = useState(8);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"" | "error">("");

  const text = labels[language];
  const enabledFeedCount = useMemo(() => feeds.filter((feed) => feed.enabled).length, [feeds]);

  useEffect(() => {
    const payload = recordValue(data);
    const nextLanguage = languageFrom(payload.language);
    const values = recordValue(payload.values);
    setLanguage(nextLanguage);
    document.documentElement.lang = nextLanguage;
    setEnabled(values[ENABLED_KEY] !== false);
    setFeeds(feedsFrom(values[FEEDS_KEY]));
    setIncludeContent(values[INCLUDE_CONTENT_KEY] !== false);
    setMaxItems(clampItems(numberValue(values[MAX_ITEMS_KEY]) || 8));
  }, [data]);

  function updateFeed(id: string, patch: Partial<FeedDraft>) {
    setFeeds((current) => current.map((feed) => (feed.id === id ? { ...feed, ...patch } : feed)));
  }

  function addFeed() {
    setFeeds((current) => [
      ...current,
      {
        enabled: true,
        id: `feed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        title: "",
        url: "",
      },
    ]);
  }

  function removeFeed(id: string) {
    setFeeds((current) => current.filter((feed) => feed.id !== id));
  }

  async function refreshTree() {
    setBusy(true);
    setMessage("");
    setMessageTone("");
    try {
      await aguiCommand(`${NAMESPACE}.refresh`, [{ language }]).catch(() => undefined);
      await aguiCommand("agui.extensions.refresh");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageTone("error");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const normalizedFeeds = feeds
      .map((feed) => ({
        enabled: feed.enabled,
        id: feed.id,
        title: feed.title.trim(),
        url: feed.url.trim(),
      }))
      .filter((feed) => feed.url || feed.title);
    if (normalizedFeeds.some((feed) => feed.enabled && !/^https?:\/\/[^\s]+$/i.test(feed.url))) {
      setMessage(text.urlRequired);
      setMessageTone("error");
      return;
    }

    setBusy(true);
    setMessage("");
    setMessageTone("");
    try {
      await aguiCommand("agui.configuration.update", [
        {
          [ENABLED_KEY]: enabled,
          [FEEDS_KEY]: normalizedFeeds,
          [INCLUDE_CONTENT_KEY]: includeContent,
          [MAX_ITEMS_KEY]: clampItems(maxItems),
        },
      ]);
      await aguiCommand("agui.extensions.refresh");
      setMessage(text.saved);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageTone("error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-3 text-[var(--agui-fg)]">
      <header className="flex min-w-0 items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold">{text.rssSettings}</div>
          <div className="mt-0.5 text-[11px] text-[var(--agui-muted)]">
            {enabledFeedCount} {text.feeds.toLowerCase()}
          </div>
        </div>
        <button
          type="button"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-[7px] border border-[var(--agui-border)] bg-[color-mix(in_srgb,var(--agui-surface)_88%,transparent)] text-[var(--agui-fg)] disabled:opacity-55"
          disabled={busy}
          onClick={() => void refreshTree()}
          title={text.refresh}
        >
          <RefreshCw className={`size-4 ${busy ? "animate-spin" : ""}`} aria-hidden="true" />
        </button>
      </header>

      <label className="flex min-h-8 items-center gap-2 text-[12px] text-[var(--agui-muted)]">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        <span>{text.enabled}</span>
      </label>

      <div className="grid grid-cols-[minmax(0,1fr)_96px] items-end gap-2 max-[420px]:grid-cols-1">
        <label className="flex min-w-0 flex-col gap-1 text-[12px] text-[var(--agui-muted)]">
          <span>{text.maxItems}</span>
          <input
            className="h-8 min-w-0 rounded-[7px] border border-[var(--agui-border)] bg-[color-mix(in_srgb,var(--agui-surface)_90%,transparent)] px-2 text-[var(--agui-fg)] outline-none"
            min={1}
            max={30}
            type="number"
            value={maxItems}
            onChange={(event) => setMaxItems(clampItems(Number(event.target.value)))}
          />
        </label>
        <label className="flex min-h-8 items-center gap-2 text-[12px] text-[var(--agui-muted)]">
          <input
            type="checkbox"
            checked={includeContent}
            onChange={(event) => setIncludeContent(event.target.checked)}
          />
          <span className="min-w-0">{text.includeContent}</span>
        </label>
      </div>

      <section className="flex min-w-0 flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[12px] font-semibold">{text.feeds}</div>
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1.5 rounded-[7px] border border-[var(--agui-border)] bg-[color-mix(in_srgb,var(--agui-surface)_88%,transparent)] px-2.5 text-[12px] font-semibold text-[var(--agui-fg)]"
            onClick={addFeed}
          >
            <Plus className="size-3.5" aria-hidden="true" />
            {text.addFeed}
          </button>
        </div>

        {feeds.map((feed) => (
          <div
            key={feed.id}
            className="grid grid-cols-[minmax(0,0.6fr)_minmax(0,1fr)_auto] gap-2 rounded-[8px] border border-[color-mix(in_srgb,var(--agui-border)_72%,transparent)] bg-[color-mix(in_srgb,var(--agui-surface)_90%,transparent)] p-2 max-[560px]:grid-cols-1"
          >
            <input
              className="h-8 min-w-0 rounded-[7px] border border-[var(--agui-border)] bg-[color-mix(in_srgb,var(--agui-canvas)_86%,transparent)] px-2 text-[12px] text-[var(--agui-fg)] outline-none"
              placeholder={text.feedTitle}
              value={feed.title}
              onChange={(event) => updateFeed(feed.id, { title: event.target.value })}
            />
            <input
              className="h-8 min-w-0 rounded-[7px] border border-[var(--agui-border)] bg-[color-mix(in_srgb,var(--agui-canvas)_86%,transparent)] px-2 text-[12px] text-[var(--agui-fg)] outline-none"
              placeholder={text.feedUrl}
              value={feed.url}
              onChange={(event) => updateFeed(feed.id, { url: event.target.value })}
            />
            <div className="flex items-center justify-end gap-1">
              <label className="inline-flex h-8 items-center gap-1.5 px-1 text-[12px] text-[var(--agui-muted)]">
                <input
                  type="checkbox"
                  checked={feed.enabled}
                  onChange={(event) => updateFeed(feed.id, { enabled: event.target.checked })}
                />
                <span>{text.enabled}</span>
              </label>
              <button
                type="button"
                className="inline-flex size-8 items-center justify-center rounded-[7px] border border-[var(--agui-border)] text-[var(--agui-muted)] hover:text-[var(--agui-fg)]"
                onClick={() => removeFeed(feed.id)}
                title={text.remove}
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>
        ))}
      </section>

      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          className="inline-flex min-h-8 items-center gap-1.5 rounded-[7px] border border-[var(--agui-accent)] bg-[var(--agui-accent)] px-2.5 text-[12px] font-semibold text-black disabled:opacity-55"
          disabled={busy}
          onClick={() => void save()}
        >
          <Save className="size-3.5" aria-hidden="true" />
          {text.save}
        </button>
        {message ? (
          <span
            className={`min-w-0 truncate text-[12px] ${
              messageTone === "error" ? "text-[#fca5a5]" : "text-[var(--agui-muted)]"
            }`}
          >
            {message}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function feedsFrom(value: unknown): FeedDraft[] {
  return Array.isArray(value)
    ? value.map((item, index) => {
        const feed = recordValue(item);
        return {
          enabled: feed.enabled !== false,
          id: stringValue(feed.id) || `feed-${index}`,
          title: stringValue(feed.title),
          url: stringValue(feed.url),
        };
      })
    : [];
}

function languageFrom(value: unknown): Language {
  const language = stringValue(value).toLowerCase();
  return language === "zh" || language.startsWith("zh-") ? "zh" : "en";
}

function clampItems(value: number): number {
  if (!Number.isFinite(value)) return 8;
  return Math.min(30, Math.max(1, Math.trunc(value)));
}

mount(<Configuration />);
