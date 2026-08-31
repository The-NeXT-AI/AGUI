import "./styles.css";

import { useEffect, type ReactNode } from "react";
import { CircleDot, GitPullRequest, Github } from "lucide-react";
import {
  aguiCommand,
  numberValue,
  recordValue,
  safeHttpsUrl,
  stringValue,
  useAguiData,
} from "./common";
import { mount } from "./mount";

type Metadata = Record<string, unknown>;

function metadataFrom(data: unknown): Metadata {
  return recordValue(recordValue(data).metadata);
}

function isZh(metadata: Metadata): boolean {
  return metadata.language === "zh";
}

function label(metadata: Metadata, key: string): string {
  const zh = isZh(metadata);
  const labels: Record<string, string> = {
    approved: zh ? "已批准" : "approved",
    changesRequested: zh ? "请求修改" : "changes requested",
    closed: zh ? "关闭" : "closed",
    comment: zh ? "条评论" : "comment",
    comments: zh ? "条评论" : "comments",
    draft: zh ? "草稿" : "Draft",
    github: "GitHub",
    issue: zh ? "议题" : "Issue",
    merged: zh ? "已合并" : "merged",
    open: zh ? "打开" : "open",
    pullRequest: zh ? "PR" : "Pull Request",
    reviewRequested: zh ? "请求 Review" : "review requested",
    reviewRequired: zh ? "需要 Review" : "review required",
    unknown: zh ? "未知" : "unknown",
  };
  return labels[key] || key;
}

function itemKind(metadata: Metadata): "issue" | "pull_request" {
  return metadata.kind === "pull_request" ? "pull_request" : "issue";
}

function stateLabel(metadata: Metadata, state: string): string {
  if (state === "closed") return label(metadata, "closed");
  if (state === "merged") return label(metadata, "merged");
  return label(metadata, "open");
}

function pullRequestStatusLabel(metadata: Metadata): string {
  const status = stringValue(metadata.pullRequestStatus) || stringValue(metadata.state) || "open";
  if (status === "draft") return label(metadata, "draft");
  if (status === "approved") return label(metadata, "approved");
  if (status === "changes_requested") return label(metadata, "changesRequested");
  if (status === "review_requested") return label(metadata, "reviewRequested");
  if (status === "review_required") return label(metadata, "reviewRequired");
  return stateLabel(metadata, status);
}

function openExternal(url: string) {
  const safe = safeHttpsUrl(url);
  if (!safe) return;
  aguiCommand("agui.host.openExternal", [safe]).catch(() => undefined);
}

function Tag({
  avatar,
  children,
  icon,
  url,
}: {
  avatar?: string;
  children: ReactNode;
  icon?: "github";
  url?: string;
}) {
  const clickable = Boolean(url);
  const className = `inline-flex h-[26px] max-w-full items-center gap-1.5 rounded-full border border-[var(--agui-border)] bg-[color-mix(in_srgb,var(--agui-surface)_86%,transparent)] px-2.5 text-[13px] leading-none text-[var(--agui-fg)] no-underline ${
    clickable
      ? "cursor-pointer text-[#bfdbfe] hover:border-[color-mix(in_srgb,#60a5fa_58%,var(--agui-border))] hover:bg-[color-mix(in_srgb,#60a5fa_14%,var(--agui-surface))]"
      : ""
  } ${avatar ? "pl-1" : ""}`;
  const content = (
    <>
      {icon === "github" ? <Github className="size-[15px] shrink-0" aria-hidden="true" /> : null}
      {avatar ? (
        <img
          className="size-[18px] shrink-0 rounded-full bg-[color-mix(in_srgb,var(--agui-fg)_10%,transparent)]"
          alt=""
          loading="lazy"
          src={avatar}
        />
      ) : null}
      <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{children}</span>
    </>
  );

  return clickable ? (
    <button type="button" className={className} onClick={() => openExternal(url || "")}>
      {content}
    </button>
  ) : (
    <span className={className}>{content}</span>
  );
}

function ItemRenderer() {
  const data = useAguiData();
  const metadata = metadataFrom(data);
  const kind = itemKind(metadata);
  const state = stringValue(metadata.state) || "open";
  const title =
    stringValue(metadata.title) || stringValue(recordValue(data).text) || label(metadata, "github");
  const number = numberValue(metadata.number);
  const repository = stringValue(metadata.repository);
  const itemUrl = safeHttpsUrl(metadata.htmlUrl);
  const author = stringValue(metadata.author);
  const authorUrl = safeHttpsUrl(metadata.authorHtmlUrl);
  const authorAvatar = safeHttpsUrl(metadata.authorAvatarUrl);
  const comments = numberValue(metadata.comments);
  const labels = Array.isArray(metadata.labels)
    ? metadata.labels.map(stringValue).filter(Boolean)
    : [];
  const commentWord =
    comments === 1 && !isZh(metadata) ? label(metadata, "comment") : label(metadata, "comments");

  useEffect(() => {
    document.documentElement.lang = isZh(metadata) ? "zh" : "en";
  }, [metadata]);

  const statusDot =
    state === "open"
      ? "border-[#86efac] bg-[#34d399] shadow-[0_0_0_4px_color-mix(in_srgb,#34d399_18%,transparent)]"
      : "border-[#c084fc] bg-[#a855f7] shadow-[0_0_0_4px_color-mix(in_srgb,#a855f7_16%,transparent)]";

  return (
    <article className="text-[var(--agui-fg)]">
      <h3 className="mb-[18px] flex items-center gap-2 text-2xl leading-[1.22] font-bold tracking-[0] text-[var(--agui-fg)] max-[640px]:text-xl">
        <span
          className="inline-flex size-[26px] shrink-0 items-center justify-center text-[#a7c7ff]"
          title={
            kind === "pull_request" ? label(metadata, "pullRequest") : label(metadata, "issue")
          }
        >
          {kind === "pull_request" ? (
            <GitPullRequest className="size-[22px]" aria-hidden="true" />
          ) : (
            <CircleDot className="size-[22px]" aria-hidden="true" />
          )}
        </span>
        <span className="min-w-0 [overflow-wrap:anywhere]">{title}</span>
        <span
          className="inline-flex size-[22px] shrink-0 items-center justify-center"
          title={
            kind === "pull_request" ? pullRequestStatusLabel(metadata) : stateLabel(metadata, state)
          }
        >
          <span className={`block size-[11px] rounded-full border ${statusDot}`} />
        </span>
      </h3>

      <div className="mb-[18px] flex flex-wrap items-center gap-2 max-[640px]:gap-1.5">
        {repository ? <Tag icon="github">{repository}</Tag> : null}
        {kind === "pull_request" ? (
          <Tag>{pullRequestStatusLabel(metadata)}</Tag>
        ) : metadata.draft === true ? (
          <Tag>{label(metadata, "draft")}</Tag>
        ) : null}
        {author ? (
          <Tag avatar={authorAvatar} url={authorUrl}>
            @{author}
          </Tag>
        ) : null}
        <Tag>
          {comments} {commentWord}
        </Tag>
        {labels.map((item) => (
          <Tag key={item}>{item}</Tag>
        ))}
        {number > 0 ? <Tag url={itemUrl}>#{number}</Tag> : null}
      </div>
    </article>
  );
}

mount(<ItemRenderer />);
