import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  FileText,
  Globe,
  MessageCircleQuestion,
  ShieldAlert,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { cn } from "@/ui/cn";
import { McpAppBlock } from "@/chat/blocks";
import { useChatStore } from "@/chat/chat-store";
import { useT, type TranslateFn } from "@/lib/i18n";
import type { InteractiveAppEmbed, McpAppSessionState } from "@/chat/types";
import { useAspStore } from "./asp-store";
import type {
  AspApprovalDecision,
  ApprovalRequestPayload,
  AspProvider,
  AspQuestion,
  AspQuestionAnswer,
  AspQuestionOption,
  AspQuestionResponse,
} from "./desktop-api";

const INPUT_CARD_EXIT_MS = 180;

export function ApprovalInputCard() {
  const t = useT();
  const activeSessionId = useChatStore((state) => state.activeSessionId);
  const activeSession = useChatStore((state) =>
    state.activeSessionId
      ? state.sessions.find((session) => session.id === state.activeSessionId)
      : undefined,
  );
  const request = useAspStore((state) =>
    activeSessionId
      ? state.approvalQueue.find((item) => item.uiSessionId === activeSessionId)
      : undefined,
  );
  const providers = useAspStore((state) => state.providers);
  const respond = useAspStore((state) => state.respondApproval);
  const [submitting, setSubmitting] = useState(false);
  const [closing, setClosing] = useState(false);
  const actorName = useMemo(
    () => approvalActorName(activeSession?.providerId, providers, t),
    [activeSession?.providerId, providers, t],
  );
  const card = useMemo(() => buildApprovalCard(request, actorName, t), [actorName, request, t]);

  useEffect(() => {
    setSubmitting(false);
    setClosing(false);
  }, [request?.requestId]);

  if (!request) return null;

  const allowDecision = request.options.includes("allow") ? "allow" : undefined;
  const scopedAllowDecision = request.options.includes("allow-session")
    ? "allow-session"
    : undefined;
  const alwaysAllowDecision = request.options.includes("allow-always") ? "allow-always" : undefined;
  const denyDecision = request.options.includes("deny")
    ? "deny"
    : request.options.includes("cancel")
      ? "cancel"
      : undefined;
  const approvalOptionDecisions = [scopedAllowDecision, alwaysAllowDecision].filter(
    (decision): decision is AspApprovalDecision => Boolean(decision),
  );
  const fallbackDecisions = request.options.filter(
    (decision) =>
      decision !== allowDecision &&
      decision !== scopedAllowDecision &&
      decision !== alwaysAllowDecision &&
      decision !== denyDecision,
  );

  const choose = async (decision: AspApprovalDecision) => {
    if (submitting || closing) return;
    setSubmitting(true);
    setClosing(true);
    try {
      await waitForInputCardExit();
      await respond(request.requestId, decision);
    } catch (error) {
      setClosing(false);
      throw error;
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="relative z-10 -mb-5 w-full">
      <div
        data-codex-approval-surface
        className={cn(
          "ui-composer-surface text-fg @container/request-card relative mx-auto flex max-h-[min(58vh,560px)] w-[calc(100%_-_1.5rem)] max-w-[44rem] origin-bottom flex-col overflow-hidden rounded-[16px] backdrop-blur sm:rounded-[18px]",
          closing ? "animate-question-card-exit" : "animate-question-card-enter",
        )}
      >
        <div className="flex min-w-0 flex-col gap-2 px-4 pt-4 pb-3">
          <div className="flex min-w-0 flex-col gap-2">
            <div className="text-muted flex items-center gap-2 text-[13px] leading-5 font-normal">
              {approvalScopeIcon(request.scope, card.command)}
              <span>{card.header}</span>
            </div>
            <div className="flex min-w-0 flex-col gap-0.5">
              <h2 className="text-fg min-w-0 text-[15px] leading-5 font-medium break-words">
                {card.title}
              </h2>
              {card.subtitle ? (
                <p className="text-subtle text-[13px] leading-5">{card.subtitle}</p>
              ) : null}
            </div>
          </div>
          {card.details.length ? (
            <dl className="flex flex-col gap-1 pt-0.5">
              {card.details.map((detail) => (
                <ApprovalDetailRow key={detail.key} detail={detail} />
              ))}
            </dl>
          ) : null}
        </div>
        {card.command ? <ApprovalCommandPreview command={card.command} /> : null}
        {card.patch ? (
          <ApprovalCommandPreview command={card.patch} label={t("approval.detail.patch")} />
        ) : null}
        <form
          className="border-border-subtle bg-elevated flex flex-wrap items-center gap-2 border-t px-4 pt-3 pb-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (allowDecision) void choose(allowDecision);
          }}
        >
          {fallbackDecisions.map((decision) => (
            <button
              key={decision}
              type="button"
              disabled={submitting || closing}
              onClick={() => void choose(decision)}
              className="ui-button h-9 px-4 text-[13px]"
            >
              {approvalLabel(decision, t)}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2">
            {denyDecision ? (
              <button
                type="button"
                disabled={submitting || closing}
                onClick={() => void choose(denyDecision)}
                className="ui-button ui-button-danger h-9 px-4 text-[13px]"
              >
                {approvalLabel(denyDecision, t)}
              </button>
            ) : null}
            {allowDecision ? (
              approvalOptionDecisions.length ? (
                <div className="bg-accent text-accent-fg inline-flex overflow-hidden rounded-[8px]">
                  <button
                    type="submit"
                    autoFocus
                    disabled={submitting || closing}
                    className="inline-flex h-9 items-center justify-center px-4 text-[13px] font-medium transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    {approvalLabel(allowDecision, t)}
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        title={t("approval.options")}
                        aria-label={t("approval.options")}
                        disabled={submitting || closing}
                        className="border-accent-fg/15 hover:bg-accent-fg/10 inline-flex h-9 w-9 items-center justify-center border-l transition-colors disabled:opacity-50"
                      >
                        <ChevronDown size={15} />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="top" align="end" sideOffset={8}>
                      {approvalOptionDecisions.map((decision) => (
                        <DropdownMenuItem key={decision} onSelect={() => void choose(decision)}>
                          {approvalLabel(decision, t)}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ) : (
                <button
                  type="submit"
                  autoFocus
                  disabled={submitting || closing}
                  className="ui-button ui-button-primary h-9 px-4 text-[13px]"
                >
                  {approvalLabel(allowDecision, t)}
                </button>
              )
            ) : null}
          </div>
        </form>
        <div className="bg-elevated h-7 shrink-0" aria-hidden />
      </div>
    </div>
  );
}

function ApprovalDetailRow({ detail }: { detail: ApprovalDetail }) {
  return (
    <div className="grid min-h-8 grid-cols-1 items-start gap-x-3 gap-y-0.5 py-1 text-[13px] leading-5 min-[420px]:grid-cols-[120px_minmax(0,1fr)]">
      <dt className="text-subtle flex min-w-0 items-center gap-2 break-words">{detail.label}</dt>
      <dd
        className={cn(
          "text-fg m-0 flex min-w-0 items-center break-words whitespace-pre-wrap",
          detail.mono && "font-mono text-[12.5px]",
        )}
      >
        {detail.value}
      </dd>
    </div>
  );
}

function ApprovalCommandPreview({ command, label }: { command: string; label?: string }) {
  return (
    <div className="px-3">
      {label ? <div className="sr-only">{label}</div> : null}
      <div className="bg-code-bg text-subtle flex max-h-[24vh] w-full flex-col overflow-hidden rounded-md">
        <div className="min-h-0 overflow-y-auto px-2 pt-2 pb-2 font-mono text-[12.5px] leading-5 font-medium">
          <span className="block break-words whitespace-pre-wrap">{command}</span>
        </div>
      </div>
    </div>
  );
}

export function QuestionInputCard() {
  const t = useT();
  const activeSessionId = useChatStore((state) => state.activeSessionId);
  const request = useAspStore((state) =>
    activeSessionId
      ? state.questionQueue.find((item) => item.uiSessionId === activeSessionId)
      : undefined,
  );
  const respond = useAspStore((state) => state.respondQuestion);
  const [values, setValues] = useState<Record<string, string | string[]>>({});
  const [appState, setAppState] = useState<McpAppSessionState | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [closing, setClosing] = useState(false);

  const questions = useMemo(() => request?.questions ?? [], [request]);
  const app = useMemo(() => interactiveAppFromRequest(request?.app), [request?.app]);
  const showApp = Boolean(
    app && (questions.length === 0 || shouldShowAppWithQuestions(request?.metadata, app.metadata)),
  );

  useEffect(() => {
    setValues(initialQuestionValues(request?.questions ?? []));
    setAppState(undefined);
    setClosing(false);
  }, [request?.requestId, request?.questions]);

  if (!request) return null;

  const cancel = async () => {
    if (submitting || closing) return;
    setSubmitting(true);
    setClosing(true);
    try {
      await waitForInputCardExit();
      await respond(request.requestId, { canceled: true });
    } catch (error) {
      setClosing(false);
      throw error;
    } finally {
      setSubmitting(false);
    }
  };

  const submit = async () => {
    if (submitting || closing || !canSubmit) return;
    const answers = questions.map((question, index) =>
      buildAnswer(
        question,
        index,
        values[questionKey(question, index)],
        values[customQuestionKey(question, index)],
      ),
    );
    const appResponse = showApp && app ? buildAppResponse(app, appState) : undefined;
    setSubmitting(true);
    setClosing(true);
    try {
      await waitForInputCardExit();
      await respond(request.requestId, {
        answers,
        ...(appResponse ? { app: appResponse } : {}),
      });
    } catch (error) {
      setClosing(false);
      throw error;
    } finally {
      setSubmitting(false);
    }
  };
  const canSubmit = questions.every(
    (question, index) =>
      !question.required ||
      hasQuestionValue(
        values[questionKey(question, index)],
        values[customQuestionKey(question, index)],
      ),
  );

  return (
    <div className="relative z-10 -mb-5 w-full">
      <div
        className={cn(
          "ui-composer-surface text-fg relative mx-auto flex w-[calc(100%_-_1.5rem)] max-w-[44rem] origin-bottom flex-col overflow-hidden rounded-[16px] backdrop-blur sm:rounded-[18px]",
          app ? "max-h-[min(64vh,680px)]" : "max-h-[min(58vh,560px)]",
          closing ? "animate-question-card-exit" : "animate-question-card-enter",
        )}
      >
        <div className="border-border-subtle flex min-h-[68px] items-center gap-3 border-b px-4 py-3.5">
          <div className="bg-info/15 text-info flex h-10 w-10 shrink-0 items-center justify-center rounded-full">
            <MessageCircleQuestion size={18} />
          </div>
          <div className="flex min-w-0 flex-1 items-center">
            <h2 className="text-fg min-w-0 text-[15px] leading-5 font-semibold">
              {request.title || t("question.title")}
            </h2>
          </div>
          <button
            type="button"
            disabled={submitting || closing}
            onClick={() => void cancel()}
            title={t("common.close")}
            aria-label={t("common.close")}
            className="ui-icon-button h-8 w-8 shrink-0 rounded-md"
          >
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {request.instructions ? (
            <div className="px-4 pt-4">
              <div className="border-border-subtle bg-surface text-muted rounded-[8px] border px-3 py-2 text-[13px] leading-5">
                {request.instructions}
              </div>
            </div>
          ) : null}
          {showApp && app ? (
            <div className={request.instructions ? "mt-4" : ""}>
              <McpAppBlock
                app={app}
                title={app.title || request.title || t("question.interactiveContent")}
                chrome="none"
                sessionId={request.uiSessionId}
                providerSessionId={request.providerSessionId}
                onModelContextChange={setAppState}
              />
            </div>
          ) : null}
          {questions.length ? (
            <div className="space-y-5 px-4 py-4">
              {questions.map((question, index) => {
                const key = questionKey(question, index);
                const customKey = customQuestionKey(question, index);
                const value = values[key];
                const multi = question.multiSelect || question.control === "multi_select";
                const dropdown = question.control === "dropdown";
                return (
                  <div key={key}>
                    {question.header ? (
                      <div className="text-subtle mb-1 text-[11px] font-semibold tracking-wide uppercase">
                        {question.header}
                      </div>
                    ) : null}
                    <div className="text-fg mb-1 text-[13.5px]">
                      {question.question}
                      {question.required ? <span className="text-danger ml-1">*</span> : null}
                    </div>
                    {question.description ? (
                      <div className="text-muted mb-2 text-[12px] leading-5">
                        {question.description}
                      </div>
                    ) : null}
                    {question.options?.length && dropdown ? (
                      <select
                        value={typeof value === "string" ? value : ""}
                        onChange={(event) =>
                          setValues((current) => ({ ...current, [key]: event.target.value }))
                        }
                        className="ui-field text-[13px]"
                      >
                        <option value="">
                          {question.placeholder || t("question.selectOption")}
                        </option>
                        {question.options.map((option) => (
                          <option
                            key={optionKey(option)}
                            value={optionValue(option)}
                            disabled={option.disabled}
                          >
                            {option.label}
                          </option>
                        ))}
                      </select>
                    ) : question.options?.length && question.control !== "text" ? (
                      <div className="space-y-1.5">
                        {question.options.map((option) => {
                          const optionId = optionValue(option);
                          const selected = multi
                            ? Array.isArray(value) && value.includes(optionId)
                            : value === optionId;
                          const image = optionImage(option);
                          return (
                            <button
                              key={optionKey(option)}
                              type="button"
                              disabled={option.disabled}
                              onClick={() =>
                                setValues((current) => ({
                                  ...current,
                                  [key]: multi
                                    ? toggleValue(
                                        Array.isArray(current[key]) ? current[key] : [],
                                        optionId,
                                      )
                                    : optionId,
                                }))
                              }
                              className={cn(
                                "flex w-full gap-3 rounded-[8px] border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                                selected
                                  ? "border-accent bg-accent/10"
                                  : "border-border-subtle bg-surface hover:border-border hover:bg-surface-hover",
                              )}
                            >
                              {image ? (
                                <img
                                  src={image}
                                  alt=""
                                  className="h-12 w-12 shrink-0 rounded-md object-cover"
                                />
                              ) : null}
                              <span className="min-w-0 flex-1">
                                <span className="text-fg block text-[13px]">{option.label}</span>
                                {option.description ? (
                                  <span className="text-muted mt-0.5 block text-[11.5px]">
                                    {option.description}
                                  </span>
                                ) : null}
                                {option.preview && !image ? (
                                  <span className="text-subtle mt-0.5 block text-[11.5px]">
                                    {option.preview}
                                  </span>
                                ) : null}
                              </span>
                            </button>
                          );
                        })}
                        {question.allowCustomAnswer ? (
                          <input
                            value={typeof values[customKey] === "string" ? values[customKey] : ""}
                            placeholder={question.placeholder || t("question.customAnswer")}
                            onChange={(event) =>
                              setValues((current) => ({
                                ...current,
                                [customKey]: event.target.value,
                              }))
                            }
                            className="ui-field text-[13px]"
                          />
                        ) : null}
                      </div>
                    ) : (
                      <textarea
                        rows={3}
                        value={typeof value === "string" ? value : ""}
                        placeholder={question.placeholder || t("question.typeAnswer")}
                        onChange={(event) =>
                          setValues((current) => ({ ...current, [key]: event.target.value }))
                        }
                        className="ui-field resize-y text-[13px]"
                      />
                    )}
                    {question.preview && !safeImageUrl(question.preview) ? (
                      <div className="text-subtle mt-2 text-[12px] leading-5">
                        {question.preview}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
        <div className="border-border-subtle bg-elevated shrink-0 border-t px-4 py-4">
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              disabled={submitting || closing}
              onClick={() => void cancel()}
              className="ui-button text-[13px]"
            >
              {request.cancelLabel || t("question.skip")}
            </button>
            <button
              type="button"
              disabled={submitting || closing || !canSubmit}
              onClick={() => void submit()}
              className="ui-button ui-button-primary text-[13px]"
            >
              {request.submitLabel || t("question.submitAnswers")}
            </button>
          </div>
        </div>
        <div className="bg-elevated h-7 shrink-0" aria-hidden />
      </div>
    </div>
  );
}

function initialQuestionValues(questions: AspQuestion[]): Record<string, string | string[]> {
  const values: Record<string, string | string[]> = {};
  questions.forEach((question, index) => {
    if (question.defaultValue === undefined) return;
    values[questionKey(question, index)] = question.defaultValue;
  });
  return values;
}

function waitForInputCardExit(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, INPUT_CARD_EXIT_MS));
}

function buildAnswer(
  question: AspQuestion,
  index: number,
  value: string | string[] | undefined,
  customValue: string | string[] | undefined,
): AspQuestionAnswer {
  const multi = question.multiSelect || question.control === "multi_select";
  const answer = value ?? (multi ? [] : "");
  const selected = question.options?.filter((option) =>
    Array.isArray(answer) ? answer.includes(optionValue(option)) : answer === optionValue(option),
  );
  const customAnswer = typeof customValue === "string" ? customValue.trim() : "";
  return {
    questionId: question.id || `question-${index}`,
    question: question.question,
    header: question.header,
    answer,
    customAnswer: customAnswer || undefined,
    selectedOptions: selected?.length ? selected : undefined,
  };
}

function buildAppResponse(
  app: InteractiveAppEmbed,
  state: McpAppSessionState | undefined,
): NonNullable<AspQuestionResponse["app"]> {
  return {
    title: app.title,
    server: app.server,
    resourceUri: state?.resourceUri || app.resourceUri || app.uri,
    documentId: state?.documentId,
    widgetState: state?.widgetState ?? app.widgetState,
    modelContext: state?.modelContext,
    metadata: app.metadata,
  };
}

function interactiveAppFromRequest(app: unknown): InteractiveAppEmbed | undefined {
  if (!app || typeof app !== "object" || Array.isArray(app)) return undefined;
  const source = app as Record<string, unknown>;
  const html = typeof source.html === "string" ? source.html : undefined;
  const src = typeof source.src === "string" ? source.src : undefined;
  const uri = typeof source.uri === "string" ? source.uri : undefined;
  const resourceUri =
    typeof source.resourceUri === "string"
      ? source.resourceUri
      : uri?.startsWith("ui://")
        ? uri
        : undefined;
  if (!html && !src && !resourceUri) return undefined;
  return {
    ...(source as Omit<InteractiveAppEmbed, "renderer">),
    renderer: "mcp-app",
    html,
    src,
    uri,
    resourceUri,
  };
}

function shouldShowAppWithQuestions(
  requestMetadata: Record<string, unknown> | undefined,
  appMetadata: Record<string, unknown> | undefined,
): boolean {
  return [
    requestMetadata?.showAppWithQuestions,
    requestMetadata?.show_app_with_questions,
    requestMetadata?.displayAppWithQuestions,
    requestMetadata?.display_app_with_questions,
    appMetadata?.showAppWithQuestions,
    appMetadata?.show_app_with_questions,
    appMetadata?.displayAppWithQuestions,
    appMetadata?.display_app_with_questions,
  ].some(booleanMetadataFlag);
}

function booleanMetadataFlag(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

function hasQuestionValue(
  value: string | string[] | undefined,
  customValue: string | string[] | undefined,
): boolean {
  if (Array.isArray(value)) return value.length > 0;
  const customAnswer = typeof customValue === "string" ? customValue.trim() : "";
  return Boolean(value?.trim() || customAnswer);
}

function questionKey(question: AspQuestion, index: number): string {
  return question.id || `question-${index}`;
}

function customQuestionKey(question: AspQuestion, index: number): string {
  return `${questionKey(question, index)}:custom`;
}

function optionValue(option: AspQuestionOption): string {
  return option.value || option.label;
}

function optionKey(option: AspQuestionOption): string {
  return `${optionValue(option)}:${option.label}`;
}

function optionImage(option: AspQuestionOption): string | undefined {
  return safeImageUrl(option.imageUri) || safeImageUrl(option.preview);
}

function safeImageUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^(https?:\/\/|data:image\/)/i.test(value) ? value : undefined;
}

function toggleValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function approvalLabel(decision: AspApprovalDecision, t: TranslateFn): string {
  if (decision === "allow") return t("approval.allowOnce");
  if (decision === "allow-session") return t("approval.allowSession");
  if (decision === "allow-always") return t("approval.allowAlways");
  if (decision === "deny") return t("approval.deny");
  return t("approval.cancelRun");
}

type ApprovalCard = {
  header: string;
  title: string;
  subtitle?: string;
  details: ApprovalDetail[];
  command?: string;
  patch?: string;
};

function buildApprovalCard(
  request: ApprovalRequestPayload | undefined,
  actorName: string,
  t: TranslateFn,
): ApprovalCard {
  const command = approvalCommand(request?.params);
  const patch = approvalPatch(request?.params);
  const details = approvalDetails(request?.params, request?.method, t, {
    includeCommand: !command,
    includePatch: !patch,
  });
  return {
    header: approvalHeader(request?.scope, request?.method, command, patch, t),
    title: approvalTitle(request, command, patch, actorName, t),
    subtitle: approvalSubtitle(request?.params),
    details,
    command,
    patch,
  };
}

function approvalHeader(
  scope: string | undefined,
  method: string | undefined,
  command: string | undefined,
  patch: string | undefined,
  t: TranslateFn,
): string {
  if (isCommandScope(scope) || command) return t("approval.header.terminal");
  if (isNetworkScope(scope)) return t("approval.header.internet");
  if (isFileScope(scope) || patch || /patch|edit|write/i.test(method ?? ""))
    return t("approval.header.editFiles");
  if (scope === "tool" || scope === "mcp") return t("approval.header.tool");
  return t("approval.header.askPermission");
}

function approvalTitle(
  request: ApprovalRequestPayload | undefined,
  command: string | undefined,
  patch: string | undefined,
  actorName: string,
  t: TranslateFn,
): string {
  if (!request) return t("approval.title.continue", { actor: actorName });
  if (isCommandScope(request.scope) || command)
    return t("approval.title.command", { actor: actorName });
  if (isNetworkScope(request.scope)) {
    const destination = approvalUrl(request.params);
    return destination
      ? t("approval.title.networkTo", { actor: actorName, destination })
      : t("approval.title.network", { actor: actorName });
  }
  if (isFileScope(request.scope) || patch || /patch|edit|write/i.test(request.method ?? "")) {
    const file = approvalPath(request.params);
    return file
      ? t("approval.title.editFile", { actor: actorName, file })
      : t("approval.title.editFiles", { actor: actorName });
  }
  return request.title || t("approval.title.continue", { actor: actorName });
}

function approvalActorName(
  providerId: string | undefined,
  providers: Pick<AspProvider, "id" | "name">[],
  t: TranslateFn,
): string {
  const providerName = providerId
    ? providers.find((provider) => provider.id === providerId)?.name
    : undefined;
  const name = providerName?.trim() || providerIdFallbackName(providerId);
  return name || t("approval.actor.agent");
}

function providerIdFallbackName(providerId: string | undefined): string | undefined {
  if (!providerId) return undefined;
  const normalized = providerId.toLowerCase();
  if (normalized.includes("claude")) return "Claude Code";
  if (normalized.includes("opencode") || normalized.includes("open-code")) return "OpenCode";
  if (normalized.includes("codex")) return "Codex";
  return humanizeDetailKey(providerId);
}

function approvalSubtitle(params: unknown): string | undefined {
  const root = recordValue(params);
  const nestedParams = recordValue(root.params);
  const input = recordValue(root.input ?? nestedParams.input);
  return (
    textValue(root.reason) ||
    textValue(input.reason) ||
    textValue(nestedParams.reason) ||
    textValue(root.message) ||
    textValue(input.message) ||
    textValue(nestedParams.message)
  );
}

function approvalCommand(params: unknown): string | undefined {
  const root = recordValue(params);
  const nestedParams = recordValue(root.params);
  const input = recordValue(root.input ?? nestedParams.input);
  return (
    textValue(root.command) ||
    textValue(root.cmd) ||
    textValue(root.argv) ||
    textValue(input.command) ||
    textValue(input.cmd) ||
    textValue(input.argv) ||
    textValue(nestedParams.command) ||
    textValue(nestedParams.cmd) ||
    textValue(nestedParams.argv)
  );
}

function approvalPath(params: unknown): string | undefined {
  const root = recordValue(params);
  const nestedParams = recordValue(root.params);
  const input = recordValue(root.input ?? nestedParams.input);
  return (
    textValue(root.path) ||
    textValue(root.file) ||
    textValue(root.filePath) ||
    textValue(root.target) ||
    textValue(input.path) ||
    textValue(input.file) ||
    textValue(input.filePath) ||
    textValue(nestedParams.path) ||
    textValue(nestedParams.file) ||
    textValue(nestedParams.filePath)
  );
}

function approvalUrl(params: unknown): string | undefined {
  const root = recordValue(params);
  const nestedParams = recordValue(root.params);
  const input = recordValue(root.input ?? nestedParams.input);
  return (
    textValue(root.url) ||
    textValue(root.href) ||
    textValue(root.host) ||
    textValue(root.destination) ||
    textValue(input.url) ||
    textValue(input.href) ||
    textValue(input.host) ||
    textValue(input.destination) ||
    textValue(nestedParams.url) ||
    textValue(nestedParams.href) ||
    textValue(nestedParams.host) ||
    textValue(nestedParams.destination)
  );
}

function approvalPatch(params: unknown): string | undefined {
  const root = recordValue(params);
  const nestedParams = recordValue(root.params);
  const input = recordValue(root.input ?? nestedParams.input);
  return textValue(root.patch) || textValue(input.patch) || textValue(nestedParams.patch);
}

function approvalScopeIcon(scope: string | undefined, command?: string) {
  if (isCommandScope(scope) || command) {
    return <Terminal size={13} />;
  }
  if (isFileScope(scope)) {
    return <FileText size={13} />;
  }
  if (isNetworkScope(scope)) {
    return <Globe size={13} />;
  }
  if (scope === "tool" || scope === "mcp") {
    return <Wrench size={13} />;
  }
  return <ShieldAlert size={13} />;
}

function isCommandScope(scope: string | undefined): boolean {
  return scope === "command" || scope === "shell" || scope === "terminal";
}

function isFileScope(scope: string | undefined): boolean {
  return scope === "filesystem" || scope === "file" || scope === "edit";
}

function isNetworkScope(scope: string | undefined): boolean {
  return scope === "network" || scope === "browser";
}

type ApprovalDetail = {
  key: string;
  label: string;
  value: string;
  mono?: boolean;
};

function approvalDetails(
  params: unknown,
  method?: string,
  t?: TranslateFn,
  options: { includeCommand?: boolean; includePatch?: boolean } = {},
): ApprovalDetail[] {
  const root = recordValue(params);
  const nestedParams = recordValue(root.params);
  const input = recordValue(root.input ?? nestedParams.input);
  const details: ApprovalDetail[] = [];
  const seen = new Set<string>();

  const add = (key: string, label: string, value: unknown, mono = false) => {
    const text = textValue(value);
    if (!text) return;
    if (method && text === method && ["action", "method", "tool", "toolName"].includes(key)) {
      return;
    }
    const fingerprint = `${label}:${text}`;
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    details.push({ key: `${key}-${details.length}`, label, value: text, mono });
  };

  const command =
    textValue(root.command) ||
    textValue(root.cmd) ||
    textValue(root.argv) ||
    textValue(input.command) ||
    textValue(input.cmd) ||
    textValue(input.argv) ||
    textValue(nestedParams.command) ||
    textValue(nestedParams.cmd) ||
    textValue(nestedParams.argv);
  if (options.includeCommand !== false) {
    add("command", t?.("approval.detail.command") ?? "Command", command, true);
  }

  const path =
    textValue(root.path) ||
    textValue(root.file) ||
    textValue(root.filePath) ||
    textValue(root.target) ||
    textValue(input.path) ||
    textValue(input.file) ||
    textValue(input.filePath) ||
    textValue(nestedParams.path) ||
    textValue(nestedParams.file) ||
    textValue(nestedParams.filePath);
  add("path", t?.("approval.detail.file") ?? "File", path, true);

  const url =
    textValue(root.url) ||
    textValue(root.href) ||
    textValue(input.url) ||
    textValue(input.href) ||
    textValue(nestedParams.url) ||
    textValue(nestedParams.href);
  add("url", t?.("approval.detail.url") ?? "URL", url);

  const tool =
    textValue(root.toolName) ||
    textValue(root.tool) ||
    textValue(input.toolName) ||
    textValue(input.tool) ||
    textValue(nestedParams.toolName) ||
    textValue(nestedParams.tool);
  add("tool", t?.("approval.detail.tool") ?? "Tool", tool);

  add(
    "reason",
    t?.("approval.detail.reason") ?? "Reason",
    root.reason ?? input.reason ?? nestedParams.reason,
  );
  add(
    "message",
    t?.("approval.detail.message") ?? "Message",
    root.message ?? input.message ?? nestedParams.message,
  );
  add(
    "cwd",
    t?.("approval.detail.workingDirectory") ?? "Working directory",
    root.cwd ?? input.cwd ?? nestedParams.cwd,
    true,
  );
  if (options.includePatch !== false) {
    add(
      "patch",
      t?.("approval.detail.patch") ?? "Patch",
      root.patch ?? input.patch ?? nestedParams.patch,
      true,
    );
  }

  appendScalarDetails(details, seen, root, method);
  appendScalarDetails(details, seen, input, method);
  appendScalarDetails(details, seen, nestedParams, method);

  return details;
}

const ignoredApprovalDetailKeys = new Set([
  "approvalId",
  "approvalOptions",
  "asp",
  "argv",
  "cmd",
  "command",
  "decisions",
  "file",
  "filePath",
  "href",
  "input",
  "message",
  "method",
  "options",
  "params",
  "patch",
  "path",
  "providerSessionId",
  "reason",
  "runId",
  "scope",
  "target",
  "title",
  "tool",
  "toolName",
  "type",
  "uiSessionId",
  "url",
  "version",
]);

function appendScalarDetails(
  details: ApprovalDetail[],
  seen: Set<string>,
  source: Record<string, unknown>,
  method?: string,
) {
  for (const [key, value] of Object.entries(source)) {
    if (ignoredApprovalDetailKeys.has(key)) continue;
    const text = textValue(value);
    if (!text || text === method) continue;
    const label = humanizeDetailKey(key);
    const fingerprint = `${label}:${text}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    details.push({
      key: `${key}-${details.length}`,
      label,
      value: text,
      mono: key.toLowerCase().includes("path") || key.toLowerCase().includes("command"),
    });
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function textValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    const joined = value.join(" ").trim();
    return joined || undefined;
  }
  return undefined;
}

function humanizeDetailKey(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
