import "./styles.css";

import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { aguiCommand, githubLanguage, recordValue, stringValue, useAguiData } from "./common";
import { mount } from "./mount";

const COMMAND = "agui.github.quickAction";
const DIFF_PANEL_ID = "agui.github.prDiff";

type Metadata = {
  htmlUrl: string;
  issueStatus: string;
  kind: "issue" | "pull_request";
  language: "en" | "zh" | "";
  number: number;
  pullRequestStatus: string;
  repository: string;
  state: string;
  title: string;
};

type Copy = ReturnType<typeof labels>;

function readMetadata(data: unknown, overrides: Map<string, Partial<Metadata>>): Metadata | null {
  const tree = recordValue(recordValue(data).sessionTree);
  const metadata = recordValue(tree.metadata);
  const provider = stringValue(metadata.provider);
  const kind = stringValue(metadata.kind);
  const repository = stringValue(metadata.repository).trim();
  const number = Number(metadata.number || 0);
  if (provider !== "github") return null;
  if (kind !== "issue" && kind !== "pull_request") return null;
  if (!repository || !Number.isInteger(number) || number <= 0) return null;
  const base: Metadata = {
    htmlUrl: stringValue(metadata.htmlUrl),
    issueStatus: stringValue(metadata.issueStatus),
    kind,
    language: githubLanguage(metadata.language),
    number,
    pullRequestStatus: stringValue(metadata.pullRequestStatus),
    repository,
    state: stringValue(metadata.state) || "open",
    title: stringValue(metadata.title),
  };
  return { ...base, ...(overrides.get(metadataKey(base)) || {}) };
}

function metadataKey(metadata: Pick<Metadata, "number" | "repository">): string {
  return `${metadata.repository}#${metadata.number}`;
}

function isZh(metadata: Metadata): boolean {
  return metadata.language === "zh" || navigator.language.toLowerCase().startsWith("zh");
}

function labels(metadata: Metadata) {
  const zh = isZh(metadata);
  return {
    approved: zh ? "已批准" : "approved",
    changesRequested: zh ? "请求修改" : "changes requested",
    closeIssue: zh ? "关闭议题" : "Close issue",
    closePullRequest: zh ? "关闭 PR" : "Close PR",
    closed: zh ? "关闭" : "closed",
    closing: zh ? "执行中..." : "Running...",
    confirmAgain: zh ? "再点确认" : "Confirm",
    confirmHint: zh ? "再点一次确认操作" : "Click again to confirm",
    done: zh ? "已完成" : "Done",
    draft: zh ? "草稿" : "draft",
    issue: zh ? "议题" : "Issue",
    mergePullRequest: zh ? "合并 PR" : "Merge PR",
    merged: zh ? "已合并" : "merged",
    open: zh ? "打开" : "open",
    openDiffFailed: zh ? "无法打开修改面板" : "Could not open diff panel",
    openInGitHub: zh ? "打开网页" : "Open",
    pullRequest: zh ? "PR" : "PR",
    replied: zh ? "已回复" : "replied",
    reopenIssue: zh ? "重开 Issue" : "Reopen issue",
    reviewRequested: zh ? "请求 Review" : "review requested",
    reviewRequired: zh ? "需要 Review" : "review required",
    viewDiff: zh ? "查看修改" : "View diff",
    waitingReply: zh ? "等待回复" : "waiting reply",
  };
}

function statusLabel(metadata: Metadata, copy: Copy): string {
  const status = metadata.kind === "issue" ? metadata.issueStatus : metadata.state;
  if (status === "closed") return copy.closed;
  if (status === "merged") return copy.merged;
  if (status === "replied") return copy.replied;
  if (status === "waiting_reply") return copy.waitingReply;
  if (metadata.kind === "pull_request") {
    const prStatus = metadata.pullRequestStatus || status;
    if (prStatus === "draft") return copy.draft;
    if (prStatus === "approved") return copy.approved;
    if (prStatus === "changes_requested") return copy.changesRequested;
    if (prStatus === "review_requested") return copy.reviewRequested;
    if (prStatus === "review_required") return copy.reviewRequired;
  }
  return copy.open;
}

function ComposerActions() {
  const data = useAguiData();
  const overrides = useRef(new Map<string, Partial<Metadata>>());
  const confirmTimer = useRef<number>(0);
  const [confirmAction, setConfirmAction] = useState("");
  const [pendingAction, setPendingAction] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [statusKind, setStatusKind] = useState<"" | "error">("");
  const [overrideVersion, setOverrideVersion] = useState(0);

  const metadata = useMemo(
    () => readMetadata(data, overrides.current),
    [data, confirmAction, overrideVersion, pendingAction, statusMessage],
  );

  useEffect(() => {
    document.body.dataset.visible = metadata ? "true" : "false";
    document.documentElement.lang = metadata && isZh(metadata) ? "zh" : "en";
  }, [metadata]);

  if (!metadata) return null;

  const copy = labels(metadata);
  const kindLabel = metadata.kind === "pull_request" ? copy.pullRequest : copy.issue;
  const isClosed = metadata.state === "closed" || metadata.state === "merged";

  async function runAction(action: string) {
    if (!metadata || pendingAction) return;

    if (action === "viewDiff") {
      setPendingAction(action);
      setStatusMessage("");
      setStatusKind("");
      try {
        await aguiCommand("agui.host.openDetailPanel", [DIFF_PANEL_ID]);
        setStatusMessage(copy.done);
      } catch {
        setStatusMessage(copy.openDiffFailed);
        setStatusKind("error");
      } finally {
        setPendingAction("");
      }
      return;
    }

    const needsConfirmation =
      action === "closeIssue" || action === "closePullRequest" || action === "mergePullRequest";
    if (needsConfirmation && confirmAction !== action) {
      setConfirmAction(action);
      setStatusMessage(copy.confirmHint);
      setStatusKind("");
      window.clearTimeout(confirmTimer.current);
      confirmTimer.current = window.setTimeout(() => {
        setConfirmAction((current) => (current === action ? "" : current));
        setStatusMessage("");
      }, 5000);
      return;
    }

    setConfirmAction("");
    window.clearTimeout(confirmTimer.current);
    setPendingAction(action);
    setStatusMessage("");
    setStatusKind("");
    try {
      const result = recordValue(
        await aguiCommand(COMMAND, [
          {
            action,
            language: isZh(metadata) ? "zh" : "en",
            number: metadata.number,
            repository: metadata.repository,
          },
        ]),
      );
      const next: Partial<Metadata> = {};
      if (action === "closeIssue" || action === "closePullRequest") {
        next.state = "closed";
        next.issueStatus = "closed";
        next.pullRequestStatus = "closed";
      } else if (action === "reopenIssue") {
        next.state = "open";
        next.issueStatus = "open";
      } else if (action === "mergePullRequest") {
        next.state = stringValue(result.state) || "merged";
        next.pullRequestStatus = "merged";
      }
      overrides.current.set(metadataKey(metadata), next);
      setStatusMessage(copy.done);
      setOverrideVersion((value) => value + 1);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
      setStatusKind("error");
    } finally {
      setPendingAction("");
    }
  }

  const buttonClass =
    "inline-flex h-6 min-w-0 cursor-pointer items-center justify-center rounded-[8px] border border-[color-mix(in_srgb,var(--agui-border)_76%,transparent)] px-[9px] text-[12px] leading-none whitespace-nowrap text-[var(--agui-fg)] outline-none hover:border-[color-mix(in_srgb,var(--agui-accent)_58%,transparent)] focus-visible:border-[color-mix(in_srgb,var(--agui-accent)_58%,transparent)] disabled:cursor-default disabled:opacity-55";
  const primaryButton = `${buttonClass} bg-[color-mix(in_srgb,var(--agui-accent)_20%,transparent)]`;
  const dangerButton = `${buttonClass} border-[color-mix(in_srgb,#f87171_42%,transparent)] bg-[color-mix(in_srgb,#f87171_18%,transparent)]`;

  return (
    <div className="flex h-8 w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-[10px] border border-[color-mix(in_srgb,var(--agui-border)_68%,transparent)] bg-[color-mix(in_srgb,var(--agui-surface)_88%,transparent)] px-1.5 py-[3px] shadow-[0_10px_28px_rgb(0_0_0_/_22%)] max-[640px]:gap-1 max-[640px]:px-[5px]">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-[12px] text-[var(--agui-muted)]">
        <strong
          className="min-w-0 overflow-hidden text-[12px] font-semibold text-ellipsis whitespace-nowrap text-[var(--agui-fg)] max-[640px]:hidden"
          title={`${metadata.repository} #${metadata.number} ${metadata.title}`}
        >
          {kindLabel} #{metadata.number}
        </strong>
        <span className="shrink-0 rounded-full border border-[color-mix(in_srgb,var(--agui-accent)_35%,transparent)] bg-[color-mix(in_srgb,var(--agui-accent)_18%,transparent)] px-[7px] text-[11px] leading-[18px] whitespace-nowrap text-[var(--agui-fg)]">
          {statusLabel(metadata, copy)}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-[5px]">
        {metadata.kind === "issue" ? (
          isClosed ? (
            <button
              type="button"
              className={primaryButton}
              disabled={Boolean(pendingAction)}
              onClick={() => void runAction("reopenIssue")}
            >
              {copy.reopenIssue}
            </button>
          ) : (
            <button
              type="button"
              className={dangerButton}
              disabled={Boolean(pendingAction)}
              onClick={() => void runAction("closeIssue")}
            >
              {confirmAction === "closeIssue" ? copy.confirmAgain : copy.closeIssue}
            </button>
          )
        ) : (
          <>
            <button
              type="button"
              className={primaryButton}
              disabled={Boolean(pendingAction)}
              onClick={() => void runAction("viewDiff")}
            >
              {copy.viewDiff}
            </button>
            {!isClosed ? (
              <>
                <button
                  type="button"
                  className={primaryButton}
                  disabled={Boolean(pendingAction)}
                  onClick={() => void runAction("mergePullRequest")}
                >
                  {confirmAction === "mergePullRequest" ? copy.confirmAgain : copy.mergePullRequest}
                </button>
                <button
                  type="button"
                  className={dangerButton}
                  disabled={Boolean(pendingAction)}
                  onClick={() => void runAction("closePullRequest")}
                >
                  {confirmAction === "closePullRequest" ? copy.confirmAgain : copy.closePullRequest}
                </button>
              </>
            ) : null}
          </>
        )}
        {metadata.htmlUrl ? (
          <a
            className={`${buttonClass} bg-[color-mix(in_srgb,var(--agui-surface)_80%,transparent)] no-underline max-[640px]:px-[7px]`}
            href={metadata.htmlUrl}
            rel="noopener noreferrer"
            target="_blank"
            title={copy.openInGitHub}
          >
            <ExternalLink className="size-3.5" aria-hidden="true" />
          </a>
        ) : null}
      </div>

      <span
        className={`max-w-40 shrink overflow-hidden text-[11px] text-ellipsis whitespace-nowrap text-[var(--agui-muted)] max-[640px]:hidden ${
          statusKind === "error" ? "text-[#fca5a5]" : ""
        }`}
        aria-live="polite"
      >
        {pendingAction ? copy.closing : statusMessage}
      </span>
    </div>
  );
}

mount(<ComposerActions />);
