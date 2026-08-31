import { createHash } from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";
import * as tls from "node:tls";
import type { IncomingHttpHeaders } from "node:http";

const NAMESPACE = "agui.rss-reader";
const DISPLAY_NAME = "RSS Reader";
const ENABLED_KEY = `${NAMESPACE}.enabled`;
const FEEDS_KEY = `${NAMESPACE}.feeds`;
const MAX_ITEMS_KEY = `${NAMESPACE}.maxItemsPerFeed`;
const INCLUDE_CONTENT_KEY = `${NAMESPACE}.includeContent`;
const ITEM_RENDERER = `${NAMESPACE}.item`;
const DEFAULT_MAX_ITEMS = 8;
const MAX_ITEMS_LIMIT = 30;
const REQUEST_TIMEOUT_MS = 15_000;
const FEED_CACHE_MS = 5 * 60_000;
const MAX_FEED_CHARS = 2_000_000;
const ARTICLE_REQUEST_TIMEOUT_MS = 8_000;
const ARTICLE_CACHE_MS = 30 * 60_000;
const MAX_ARTICLE_CHARS = 4_000_000;
const MAX_MARKDOWN_CHARS = 14_000;
const MAX_SUMMARY_CHARS = 320;

type ExtensionContext = {
  commands: {
    registerCommand(id: string, handler: (input?: unknown) => unknown | Promise<unknown>): void;
  };
  configuration: {
    get<T = unknown>(key: string, fallback?: T): T | undefined;
  };
  log?: {
    warn(...args: unknown[]): void;
  };
};

type FeedConfig = {
  enabled: boolean;
  id: string;
  title: string;
  url: string;
};

type ParsedFeed = {
  description: string;
  feedUrl: string;
  siteUrl: string;
  title: string;
  items: ParsedItem[];
};

type ParsedItem = {
  author: string;
  categories: string[];
  content: string;
  id: string;
  link: string;
  publishedAt: string;
  summary: string;
  title: string;
  updatedAt: string;
};

type XmlNode = {
  attributes: Record<string, string>;
  children: Array<XmlNode | string>;
  name: string;
};

type FeedResponse = {
  headers: IncomingHttpHeaders;
  ok: boolean;
  status: number;
  statusText: string;
  text: string;
};

type TextRequestOptions = {
  headers?: Record<string, string>;
  label?: string;
  maxBytes?: number;
  method?: string;
  timeoutMs?: number;
};

const feedCache = new Map<string, { checkedAt: number; feed?: ParsedFeed; error?: string }>();
const articleCache = new Map<string, { checkedAt: number; text: string }>();

export function activate(context: ExtensionContext) {
  context.commands.registerCommand(`${NAMESPACE}.sessionTree`, async (input = {}) =>
    rssSessionTree(context, inputLanguageZh(input)),
  );
  context.commands.registerCommand(`${NAMESPACE}.feedItems`, async (input = {}) =>
    rssFeedItems(context, input, inputLanguageZh(input)),
  );
  context.commands.registerCommand(`${NAMESPACE}.refresh`, async (input = {}) => {
    feedCache.clear();
    return rssSessionTree(context, inputLanguageZh(input));
  });
}

async function rssSessionTree(context: ExtensionContext, zh: boolean) {
  if (context.configuration.get<boolean>(ENABLED_KEY, true) === false) return { children: [] };

  const feeds = feedsFrom(context.configuration.get(FEEDS_KEY));
  const enabledFeeds = feeds.filter((feed) => feed.enabled);
  if (!enabledFeeds.length) {
    return {
      children: [
        {
          id: `${NAMESPACE}.empty`,
          title: text("noFeeds", zh),
          kind: "folder",
          icon: "rss",
          description: text("addFeeds", zh),
        },
      ],
    };
  }

  const results = await Promise.all(
    enabledFeeds.map(async (feed, index) => {
      try {
        const parsed = await cachedFeed(feed.url);
        return feedNode(feed, parsed, { index, zh });
      } catch (error) {
        const message = errorMessage(error);
        context.log?.warn("RSS feed failed", feed.url, message);
        return feedErrorNode(feed, message, index, zh);
      }
    }),
  );

  return { children: results };
}

async function rssFeedItems(context: ExtensionContext, input: unknown, zh: boolean) {
  if (context.configuration.get<boolean>(ENABLED_KEY, true) === false) {
    return { children: [], hasMore: false };
  }
  const payload = recordValue(input);
  const loadInput = recordValue(payload.input);
  const feedUrl = safeFeedUrl(stringValue(loadInput.feedUrl));
  const configuredFeed = feedsFrom(context.configuration.get(FEEDS_KEY))
    .filter((feed) => feed.enabled)
    .find((feed) => feed.url === feedUrl);
  if (!configuredFeed) {
    return {
      children: [
        {
          id: `${NAMESPACE}.feed.invalid`,
          title: text("feedNotConfigured", zh),
          kind: "folder",
          icon: "alert-triangle",
        },
      ],
      hasMore: false,
    };
  }

  const parsed = await cachedFeed(configuredFeed.url);
  const pageSize = maxItemsFrom(context.configuration.get(MAX_ITEMS_KEY));
  const includeContent = context.configuration.get<boolean>(INCLUDE_CONTENT_KEY, true) !== false;
  const loadedCount = Math.max(0, Math.trunc(Number(payload.loadedCount || 0)));
  const cursorOffset = Math.trunc(Number(stringValue(payload.cursor)));
  const offset = Number.isFinite(cursorOffset) && cursorOffset >= 0 ? cursorOffset : loadedCount;
  const items = parsed.items.slice(offset, offset + pageSize);
  const children = items.length
    ? await Promise.all(
        items.map((item, index) =>
          itemNode(configuredFeed, parsed, item, {
            includeContent,
            index: offset + index,
            zh,
          }),
        ),
      )
    : offset === 0
      ? [
          {
            id: `${NAMESPACE}.feed.${stableHash(configuredFeed.url)}.empty`,
            title: text("noArticles", zh),
            kind: "folder",
            icon: "file-text",
          },
        ]
      : [];
  const nextOffset = offset + items.length;
  const hasMore = nextOffset < parsed.items.length;
  return {
    children,
    cursor: hasMore ? String(nextOffset) : "",
    hasMore,
  };
}

function feedsFrom(value: unknown): FeedConfig[] {
  if (!Array.isArray(value)) return [];
  const feeds: FeedConfig[] = [];
  for (const [index, item] of value.entries()) {
    const record = recordValue(item);
    const rawUrl = typeof item === "string" ? item : stringValue(record.url);
    const url = safeFeedUrl(rawUrl);
    if (!url) continue;
    feeds.push({
      enabled: record.enabled !== false,
      id: stableFeedId(stringValue(record.id) || url || String(index)),
      title: cleanInlineText(stringValue(record.title)),
      url,
    });
  }
  return feeds.slice(0, 50);
}

function maxItemsFrom(value: unknown): number {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) return DEFAULT_MAX_ITEMS;
  return Math.min(MAX_ITEMS_LIMIT, Math.max(1, number));
}

async function cachedFeed(url: string): Promise<ParsedFeed> {
  const now = Date.now();
  const cached = feedCache.get(url);
  if (cached && now - cached.checkedAt < FEED_CACHE_MS) {
    if (cached.feed) return cached.feed;
    throw new Error(cached.error || "Feed failed.");
  }
  try {
    const feed = await fetchFeed(url);
    feedCache.set(url, { checkedAt: now, feed });
    return feed;
  } catch (error) {
    const message = errorMessage(error);
    feedCache.set(url, { checkedAt: now, error: message });
    throw new Error(message);
  }
}

async function fetchFeed(url: string): Promise<ParsedFeed> {
  const response = await requestFeedText(url, {
    headers: {
      accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.8",
      "user-agent": "AGUI RSS Reader/0.1",
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
  const length = Number(response.headers["content-length"] || 0);
  if (length > MAX_FEED_CHARS) throw new Error("Feed is larger than the 2 MB limit.");
  if (response.text.length > MAX_FEED_CHARS) throw new Error("Feed is larger than the 2 MB limit.");
  return parseFeedXml(response.text, url);
}

async function requestFeedText(
  url: string,
  options: TextRequestOptions = {},
  redirectCount = 0,
): Promise<FeedResponse> {
  const target = new URL(url);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error(`Unsupported feed URL protocol: ${target.protocol}`);
  }
  const proxyUrl = proxyUrlFor(target);
  const response = proxyUrl
    ? await requestViaHttpProxy(target, options, new URL(proxyUrl))
    : await requestDirect(target, options);
  if (isRedirect(response.status)) {
    if (redirectCount >= 5) throw new Error(`${options.label || "Feed"} redirect limit exceeded.`);
    const location = stringHeader(response.headers.location);
    if (!location) throw new Error(`HTTP ${response.status} redirect without Location`);
    return requestFeedText(new URL(location, target).toString(), options, redirectCount + 1);
  }
  return response;
}

function requestDirect(target: URL, options: TextRequestOptions): Promise<FeedResponse> {
  return makeNodeRequest(target, options, {});
}

function requestViaHttpProxy(
  target: URL,
  options: TextRequestOptions,
  proxy: URL,
): Promise<FeedResponse> {
  if (proxy.protocol !== "http:" && proxy.protocol !== "https:") {
    throw new Error(`RSS proxy protocol is not supported: ${proxy.protocol}`);
  }
  return target.protocol === "https:"
    ? requestHttpsViaHttpProxy(target, options, proxy)
    : requestHttpViaHttpProxy(target, options, proxy);
}

function requestHttpsViaHttpProxy(
  target: URL,
  options: TextRequestOptions,
  proxy: URL,
): Promise<FeedResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(new Error(`RSS proxy request failed (${proxyHost(proxy)}): ${errorMessage(error)}`));
    };
    const connectClient = proxy.protocol === "https:" ? https : http;
    const request = connectClient.request({
      host: proxy.hostname,
      port: proxyPort(proxy),
      method: "CONNECT",
      path: targetAuthority(target),
      headers: proxyHeaders(proxy, target),
    });
    const timeout = setTimeout(() => {
      request.destroy(new Error(`RSS proxy connection timed out: ${proxyHost(proxy)}`));
    }, REQUEST_TIMEOUT_MS);
    request.once("connect", (response, socket, head) => {
      clearTimeout(timeout);
      if (response.statusCode !== 200) {
        socket.destroy();
        fail(new Error(`RSS proxy CONNECT failed: HTTP ${response.statusCode}`));
        return;
      }
      const secureSocket = tls.connect({ socket, servername: target.hostname });
      if (head.length) secureSocket.unshift(head);
      makeNodeRequest(target, options, { createConnection: () => secureSocket }).then((result) => {
        settled = true;
        resolve(result);
      }, fail);
    });
    request.once("error", (error) => {
      clearTimeout(timeout);
      fail(error);
    });
    request.end();
  });
}

function requestHttpViaHttpProxy(
  target: URL,
  options: TextRequestOptions,
  proxy: URL,
): Promise<FeedResponse> {
  const headers = {
    ...(options.headers ?? {}),
    host: target.host,
    ...proxyAuthorizationHeader(proxy),
  };
  const client = proxy.protocol === "https:" ? https : http;
  return makeHttpRequest(
    client,
    {
      host: proxy.hostname,
      port: proxyPort(proxy),
      path: target.toString(),
      method: options.method || "GET",
      headers,
    },
    options,
  );
}

function makeNodeRequest(
  target: URL,
  options: TextRequestOptions,
  transport: Record<string, unknown>,
): Promise<FeedResponse> {
  const client = target.protocol === "http:" ? http : https;
  return makeHttpRequest(
    client,
    {
      ...transport,
      host: target.hostname,
      port: Number(target.port || (target.protocol === "http:" ? 80 : 443)),
      path: `${target.pathname}${target.search}`,
      method: options.method || "GET",
      headers: options.headers ?? {},
    },
    options,
  );
}

function makeHttpRequest(
  client: typeof http | typeof https,
  requestOptions: http.RequestOptions,
  options: TextRequestOptions = {},
): Promise<FeedResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const maxBytes = options.maxBytes || MAX_FEED_CHARS;
    const timeoutMs = options.timeoutMs || REQUEST_TIMEOUT_MS;
    const label = options.label || "RSS";
    const request = client.request(requestOptions, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          request.destroy(new Error(`${label} response exceeds the ${maxBytes} byte limit.`));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          headers: response.headers,
          ok: Boolean(
            response.statusCode && response.statusCode >= 200 && response.statusCode < 300,
          ),
          status: response.statusCode || 0,
          statusText: response.statusMessage || "",
          text,
        });
      });
    });
    const timeout = setTimeout(() => {
      request.destroy(new Error(`${label} request timed out: ${requestHost(requestOptions)}`));
    }, timeoutMs);
    request.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    request.end();
  });
}

function proxyUrlFor(target: URL): string {
  if (isNoProxyHost(target.hostname)) return "";
  const proxy =
    target.protocol === "https:"
      ? stringValue(process.env.HTTPS_PROXY) ||
        stringValue(process.env.https_proxy) ||
        stringValue(process.env.ALL_PROXY) ||
        stringValue(process.env.all_proxy)
      : stringValue(process.env.HTTP_PROXY) ||
        stringValue(process.env.http_proxy) ||
        stringValue(process.env.ALL_PROXY) ||
        stringValue(process.env.all_proxy);
  return proxy.trim();
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function stringHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function proxyHeaders(proxy: URL, target: URL): Record<string, string> {
  return {
    host: targetAuthority(target),
    ...proxyAuthorizationHeader(proxy),
  };
}

function proxyAuthorizationHeader(proxy: URL): Record<string, string> {
  if (!proxy.username && !proxy.password) return {};
  return {
    "proxy-authorization": `Basic ${Buffer.from(
      `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
    ).toString("base64")}`,
  };
}

function proxyHost(proxy: URL): string {
  return `${proxy.hostname}:${proxyPort(proxy)}`;
}

function proxyPort(proxy: URL): number {
  return Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80));
}

function requestHost(options: http.RequestOptions): string {
  return `${String(options.host || "feed")}:${String(options.port || "")}`;
}

function targetAuthority(target: URL): string {
  return `${target.hostname}:${target.port || (target.protocol === "https:" ? 443 : 80)}`;
}

function isNoProxyHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return true;
  const rules = `${process.env.NO_PROXY || ""},${process.env.no_proxy || ""}`
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const host = hostname.toLowerCase();
  return rules.some((rule) => noProxyRuleMatches(host, rule));
}

function noProxyRuleMatches(host: string, rule: string): boolean {
  if (rule === "*") return true;
  const normalized = rule.replace(/^\*\./, ".").replace(/^\./, "");
  return host === normalized || host.endsWith(`.${normalized}`);
}

function parseFeedXml(xml: string, feedUrl: string): ParsedFeed {
  const root = parseXmlDocument(xml.replace(/^\uFEFF/, ""));
  const rootName = localName(root.name);
  if (rootName === "rss") return parseRssFeed(root, feedUrl);
  if (rootName === "feed") return parseAtomFeed(root, feedUrl);
  if (rootName === "rdf") return parseRdfFeed(root, feedUrl);
  throw new Error("Unsupported RSS or Atom document.");
}

function parseRssFeed(root: XmlNode, feedUrl: string): ParsedFeed {
  const channel = firstChild(root, "channel") || root;
  const title = cleanInlineText(childText(channel, "title")) || hostLabel(feedUrl);
  const siteUrl = safeWebUrl(childText(channel, "link"));
  const items = children(channel, "item").map((item) => parseRssItem(item, siteUrl));
  return {
    description: cleanBlockText(childText(channel, "description")),
    feedUrl,
    items: sortItems(items),
    siteUrl,
    title,
  };
}

function parseRdfFeed(root: XmlNode, feedUrl: string): ParsedFeed {
  const channel = firstChild(root, "channel") || root;
  const title = cleanInlineText(childText(channel, "title")) || hostLabel(feedUrl);
  const siteUrl = safeWebUrl(childText(channel, "link"));
  const items = children(root, "item").map((item) => parseRssItem(item, siteUrl));
  return {
    description: cleanBlockText(childText(channel, "description")),
    feedUrl,
    items: sortItems(items),
    siteUrl,
    title,
  };
}

function parseRssItem(item: XmlNode, siteUrl: string): ParsedItem {
  const guidNode = firstChild(item, "guid");
  const guid = cleanInlineText(guidNode ? textContent(guidNode) : "");
  const link = safeWebUrl(childText(item, "link")) || safeWebUrl(guid);
  const summary = childText(item, "description", "summary");
  const content = childText(item, "encoded", "content") || summary;
  const publishedAt = isoDate(childText(item, "pubDate", "published", "date", "dc:date"));
  const updatedAt = isoDate(childText(item, "updated", "modified")) || publishedAt;
  const title = cleanInlineText(childText(item, "title")) || link || siteUrl || "Untitled";
  return {
    author: cleanInlineText(childText(item, "creator", "author", "managingEditor")),
    categories: children(item, "category")
      .map((node) => cleanInlineText(textContent(node)))
      .filter(Boolean),
    content: cleanBlockText(content),
    id: guid || link || stableHash(`${title}:${publishedAt}`),
    link,
    publishedAt,
    summary: cleanBlockText(summary || content),
    title,
    updatedAt,
  };
}

function parseAtomFeed(root: XmlNode, feedUrl: string): ParsedFeed {
  const siteUrl = atomLink(root) || safeWebUrl(feedUrl);
  const title = cleanInlineText(childText(root, "title")) || hostLabel(siteUrl || feedUrl);
  const items = children(root, "entry").map((entry) => parseAtomItem(entry, siteUrl));
  return {
    description: cleanBlockText(childText(root, "subtitle", "tagline")),
    feedUrl,
    items: sortItems(items),
    siteUrl,
    title,
  };
}

function parseAtomItem(entry: XmlNode, siteUrl: string): ParsedItem {
  const link = atomLink(entry) || siteUrl;
  const summary = childText(entry, "summary");
  const content = childText(entry, "content") || summary;
  const publishedAt = isoDate(childText(entry, "published", "issued", "created"));
  const updatedAt = isoDate(childText(entry, "updated", "modified")) || publishedAt;
  const title = cleanInlineText(childText(entry, "title")) || link || "Untitled";
  return {
    author: atomAuthor(entry),
    categories: children(entry, "category")
      .map((node) =>
        cleanInlineText(node.attributes.term || node.attributes.label || textContent(node)),
      )
      .filter(Boolean),
    content: cleanBlockText(content),
    id: cleanInlineText(childText(entry, "id")) || link || stableHash(`${title}:${publishedAt}`),
    link,
    publishedAt,
    summary: cleanBlockText(summary || content),
    title,
    updatedAt,
  };
}

function feedNode(config: FeedConfig, parsed: ParsedFeed, options: { index: number; zh: boolean }) {
  const feedTitle = config.title || parsed.title || hostLabel(config.url);
  return {
    id: `${NAMESPACE}.feed.${stableHash(config.url)}`,
    title: feedTitle,
    kind: "folder",
    icon: "rss",
    badge: String(parsed.items.length),
    description: parsed.description || parsed.siteUrl || config.url,
    order: options.index,
    hasMore: parsed.items.length > 0,
    cursor: "0",
    loadChildrenCommand: `${NAMESPACE}.feedItems`,
    loadMoreCommand: `${NAMESPACE}.feedItems`,
    loadInput: {
      feedUrl: config.url,
    },
    children: [],
  };
}

function feedErrorNode(config: FeedConfig, message: string, index: number, zh: boolean) {
  return {
    id: `${NAMESPACE}.feed.${stableHash(config.url)}`,
    title: config.title || hostLabel(config.url),
    kind: "folder",
    icon: "rss",
    badge: text("errorBadge", zh),
    description: message,
    order: index,
    children: [
      {
        id: `${NAMESPACE}.feed.${stableHash(config.url)}.error`,
        title: text("loadFailed", zh),
        kind: "folder",
        icon: "alert-triangle",
        description: message,
      },
    ],
  };
}

async function itemNode(
  config: FeedConfig,
  feed: ParsedFeed,
  item: ParsedItem,
  options: { includeContent: boolean; index: number; zh: boolean },
) {
  const feedTitle = config.title || feed.title || hostLabel(config.url);
  const date = item.publishedAt || item.updatedAt;
  const body = await articleMarkdown(item, options.includeContent, options.zh);
  const url = safeWebUrl(item.link);
  return {
    id: `${NAMESPACE}.feed.${stableHash(config.url)}.item.${stableHash(item.id || item.link || item.title)}`,
    title: item.title,
    kind: "session",
    icon: "file-text",
    badge: shortDate(date, options.zh),
    description: truncate(cleanInlineText(item.summary || item.content), MAX_SUMMARY_CHARS),
    order: options.index,
    session: {
      title: item.title,
      renderer: ITEM_RENDERER,
      initialMarkdown: text("previewBlock", options.zh),
      developerInstructions: [
        `This conversation is scoped to an RSS article from ${feedTitle}.`,
        url ? `Article URL: ${url}` : "",
        "Use the article preview and metadata as context before answering.",
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: {
        provider: "rss",
        type: "article",
        title: item.title,
        feedTitle,
        feedUrl: feed.feedUrl || config.url,
        siteUrl: feed.siteUrl,
        url,
        author: item.author,
        categories: item.categories.slice(0, 8),
        publishedAt: item.publishedAt,
        updatedAt: item.updatedAt,
        summary: truncate(cleanInlineText(item.summary || item.content), MAX_SUMMARY_CHARS),
        markdown: {
          title: text("previewTitle", options.zh),
          content: body,
        },
      },
    },
  };
}

async function articleMarkdown(
  item: ParsedItem,
  includeContent: boolean,
  zh: boolean,
): Promise<string> {
  const feedBody = cleanBlockText(includeContent ? item.content || item.summary : item.summary);
  const extractedBody =
    includeContent && shouldFetchOriginalArticle(item, feedBody)
      ? await cachedArticleText(item.link)
      : "";
  const body = extractedBody || (isUsefulArticleText(feedBody) ? feedBody : "");
  const lines: string[] = [];
  if (item.link) {
    lines.push(`[${text("openOriginal", zh)}](${item.link})`);
    lines.push("");
  }
  if (extractedBody) {
    lines.push(text("extractedFromOriginal", zh));
    lines.push("");
  }
  const metadata = [item.author, displayDate(item.publishedAt || item.updatedAt, zh)]
    .filter(Boolean)
    .join(" · ");
  if (metadata) {
    lines.push(metadata);
    lines.push("");
  }
  lines.push(truncate(cleanBlockText(body), MAX_MARKDOWN_CHARS) || text("noPreview", zh));
  return lines.join("\n");
}

function shouldFetchOriginalArticle(item: ParsedItem, feedBody: string): boolean {
  if (!safeWebUrl(item.link)) return false;
  if (!feedBody) return true;
  const normalized = cleanInlineText(feedBody).toLowerCase();
  if (/^(comments?|comment|read more|continue reading|open article)$/i.test(normalized)) {
    return true;
  }
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  return normalized.length < 240 || wordCount < 45;
}

function isUsefulArticleText(value: string): boolean {
  const normalized = cleanInlineText(value);
  if (!normalized) return false;
  if (/^(comments?|comment|read more|continue reading|open article)$/i.test(normalized)) {
    return false;
  }
  return normalized.length >= 24;
}

async function cachedArticleText(url: string): Promise<string> {
  const safeUrl = safeWebUrl(url);
  if (!safeUrl) return "";
  const cached = articleCache.get(safeUrl);
  const now = Date.now();
  if (cached && now - cached.checkedAt < ARTICLE_CACHE_MS) return cached.text;

  let text = "";
  try {
    const response = await requestFeedText(safeUrl, {
      headers: {
        accept: "text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.5",
        "user-agent": "AGUI RSS Reader/0.1",
      },
      label: "Article",
      maxBytes: MAX_ARTICLE_CHARS,
      timeoutMs: ARTICLE_REQUEST_TIMEOUT_MS,
    });
    const contentType = stringHeader(response.headers["content-type"]).toLowerCase();
    if (
      response.ok &&
      (!contentType || /(?:text\/html|application\/xhtml\+xml)/.test(contentType))
    ) {
      text = extractArticleText(response.text);
    }
  } catch {
    text = "";
  }
  articleCache.set(safeUrl, { checkedAt: now, text });
  return text;
}

function extractArticleText(html: string): string {
  const candidates = articleHtmlCandidates(html);
  let best = "";
  let bestScore = 0;
  for (const candidate of candidates) {
    const text = htmlFragmentToReadableText(candidate);
    const score = articleTextScore(text);
    if (score > bestScore) {
      best = text;
      bestScore = score;
    }
  }
  return articleTextScore(best) >= 240 ? truncate(best, MAX_MARKDOWN_CHARS) : "";
}

function articleHtmlCandidates(html: string): string[] {
  const candidates: string[] = [];
  for (const tag of ["article", "main"]) {
    const expression = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
    for (const match of html.matchAll(expression)) {
      if (match[0]) candidates.push(match[0]);
    }
  }
  const contentExpression =
    /<(section|div)\b[^>]*(?:id|class)=["'][^"']*(?:article|content|entry|main|post|story)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi;
  for (const match of html.matchAll(contentExpression)) {
    if (match[0]) candidates.push(match[0]);
  }
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] || html;
  candidates.push(body);
  return candidates.slice(0, 24);
}

function htmlFragmentToReadableText(fragment: string): string {
  return cleanBlockText(
    fragment
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(
        /<(?:aside|canvas|footer|form|header|nav|svg)\b[\s\S]*?<\/(?:aside|canvas|footer|form|header|nav|svg)>/gi,
        " ",
      )
      .replace(/<h1\b[^>]*>/gi, "\n\n# ")
      .replace(/<h2\b[^>]*>/gi, "\n\n## ")
      .replace(/<h3\b[^>]*>/gi, "\n\n### ")
      .replace(/<\/h[1-6]>/gi, "\n\n")
      .replace(/<p\b[^>]*>/gi, "\n\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<\/(?:blockquote|div|li|main|section|article)>/gi, "\n"),
  );
}

function articleTextScore(text: string): number {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((item) => cleanInlineText(item))
    .filter((item) => item.length >= 35);
  const paragraphChars = paragraphs.reduce((total, item) => total + item.length, 0);
  return paragraphChars + paragraphs.length * 80;
}

function parseXmlDocument(xml: string): XmlNode {
  const document: XmlNode = { attributes: {}, children: [], name: "#document" };
  const stack: XmlNode[] = [document];
  let index = 0;

  while (index < xml.length) {
    const tagStart = xml.indexOf("<", index);
    if (tagStart < 0) {
      appendXmlText(stack.at(-1)!, xml.slice(index));
      break;
    }
    if (tagStart > index) appendXmlText(stack.at(-1)!, xml.slice(index, tagStart));

    if (xml.startsWith("<!--", tagStart)) {
      index = skipUntil(xml, "-->", tagStart + 4);
      continue;
    }
    if (xml.startsWith("<![CDATA[", tagStart)) {
      const end = xml.indexOf("]]>", tagStart + 9);
      appendXmlText(stack.at(-1)!, xml.slice(tagStart + 9, end < 0 ? xml.length : end), false);
      index = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith("<?", tagStart)) {
      index = skipUntil(xml, "?>", tagStart + 2);
      continue;
    }
    if (xml.startsWith("</", tagStart)) {
      const tagEnd = findTagEnd(xml, tagStart + 2);
      const closeName = normalizeName(
        xml
          .slice(tagStart + 2, tagEnd)
          .trim()
          .split(/\s+/)[0] || "",
      );
      for (let stackIndex = stack.length - 1; stackIndex > 0; stackIndex -= 1) {
        if (normalizeName(stack[stackIndex]!.name) === closeName) {
          stack.length = stackIndex;
          break;
        }
      }
      index = tagEnd + 1;
      continue;
    }
    if (xml.startsWith("<!", tagStart)) {
      index = findTagEnd(xml, tagStart + 2) + 1;
      continue;
    }

    const tagEnd = findTagEnd(xml, tagStart + 1);
    const rawTag = xml.slice(tagStart + 1, tagEnd);
    const selfClosing = /\/\s*$/.test(rawTag);
    const node = parseXmlTag(selfClosing ? rawTag.replace(/\/\s*$/, "") : rawTag);
    if (node) {
      stack.at(-1)!.children.push(node);
      if (!selfClosing) stack.push(node);
    }
    index = tagEnd + 1;
  }

  const root = document.children.find((child): child is XmlNode => typeof child !== "string");
  if (!root) throw new Error("Feed XML has no document element.");
  return root;
}

function parseXmlTag(value: string): XmlNode | null {
  const trimmed = value.trim();
  const match = /^([^\s/>]+)/.exec(trimmed);
  if (!match) return null;
  const name = match[1]!;
  const attributes: Record<string, string> = {};
  const source = trimmed.slice(name.length);
  const expression = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let attrMatch: RegExpExecArray | null;
  while ((attrMatch = expression.exec(source))) {
    attributes[attrMatch[1]!] = decodeXmlEntities(
      attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? "",
    );
  }
  return { attributes, children: [], name };
}

function findTagEnd(xml: string, start: number): number {
  let quote = "";
  for (let index = start; index < xml.length; index += 1) {
    const char = xml[index]!;
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return index;
    }
  }
  return xml.length;
}

function skipUntil(value: string, needle: string, start: number): number {
  const end = value.indexOf(needle, start);
  return end < 0 ? value.length : end + needle.length;
}

function appendXmlText(node: XmlNode, value: string, decode = true): void {
  if (!value) return;
  const text = decode ? decodeXmlEntities(value) : value;
  if (text.trim()) node.children.push(text);
}

function children(node: XmlNode, ...names: string[]): XmlNode[] {
  const wanted = new Set(names.map(normalizeName));
  return node.children.filter(
    (child): child is XmlNode =>
      typeof child !== "string" &&
      (wanted.has(normalizeName(child.name)) || wanted.has(localName(child.name))),
  );
}

function firstChild(node: XmlNode, ...names: string[]): XmlNode | undefined {
  return children(node, ...names)[0];
}

function childText(node: XmlNode, ...names: string[]): string {
  for (const name of names) {
    const child = firstChild(node, name);
    const text = child ? textContent(child) : "";
    if (text.trim()) return text;
  }
  return "";
}

function textContent(node: XmlNode): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textContent(child)))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function atomLink(node: XmlNode): string {
  const links = children(node, "link");
  const alternate =
    links.find((link) => (link.attributes.rel || "alternate").toLowerCase() === "alternate") ||
    links[0];
  return safeWebUrl(alternate?.attributes.href || textContent(alternate || emptyNode()));
}

function atomAuthor(node: XmlNode): string {
  const author = firstChild(node, "author");
  if (!author) return "";
  return cleanInlineText(childText(author, "name") || textContent(author));
}

function emptyNode(): XmlNode {
  return { attributes: {}, children: [], name: "" };
}

function sortItems(items: ParsedItem[]): ParsedItem[] {
  return [...items].sort((left, right) => itemTime(right) - itemTime(left));
}

function itemTime(item: ParsedItem): number {
  const value = Date.parse(item.publishedAt || item.updatedAt || "");
  return Number.isFinite(value) ? value : 0;
}

function stableFeedId(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9_.-]/g, "-")
      .slice(0, 80) || stableHash(value)
  );
}

function stableHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 16);
}

function safeFeedUrl(value: string): string {
  const url = safeWebUrl(value);
  if (!url) return "";
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function safeWebUrl(value: string | undefined): string {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function hostLabel(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return DISPLAY_NAME;
  }
}

function isoDate(value: string): string {
  const time = Date.parse(cleanInlineText(value));
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
}

function shortDate(value: string, zh: boolean): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(zh ? "zh-CN" : "en", {
    day: "numeric",
    month: "short",
  }).format(date);
}

function displayDate(value: string, zh: boolean): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(zh ? "zh-CN" : "en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function cleanInlineText(value: string): string {
  return cleanBlockText(value).replace(/\s+/g, " ").trim();
}

function cleanBlockText(value: string): string {
  const decoded = decodeXmlEntities(String(value || ""));
  return decoded
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|section|article|blockquote|h[1-6])>/gi, "\n\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function decodeXmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/g, (match, entity) => {
    if (entity.startsWith("#x")) {
      const codePoint = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (entity.startsWith("#")) {
      const codePoint = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return named[entity] ?? match;
  });
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
}

function inputLanguageZh(input: unknown): boolean {
  const language = stringValue(recordValue(input).language).toLowerCase();
  return language === "zh" || language.startsWith("zh-");
}

function text(key: string, zh: boolean): string {
  const labels: Record<string, [string, string]> = {
    addFeeds: ["Add RSS feed URLs in the extension settings.", "请在扩展设置中添加 RSS 源 URL。"],
    errorBadge: ["error", "错误"],
    extractedFromOriginal: ["Extracted from the original article.", "已从原文页面提取正文。"],
    feedNotConfigured: ["Feed is not configured", "RSS 源未配置"],
    loadFailed: ["Feed failed to load", "RSS 源加载失败"],
    noArticles: ["No articles found", "没有找到文章"],
    noFeeds: ["No RSS feeds configured", "尚未配置 RSS 源"],
    noPreview: [
      "No preview content is available for this article.",
      "这篇文章没有可用的预览内容。",
    ],
    openOriginal: ["Open original", "打开原文"],
    previewBlock: ["RSS article preview", "RSS 文章预览"],
    previewTitle: ["Article preview", "文章预览"],
  };
  const value = labels[key];
  return value ? value[zh ? 1 : 0] : key;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function localName(value: string): string {
  return normalizeName(value).split(":").pop() || "";
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
