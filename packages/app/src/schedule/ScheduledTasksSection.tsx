import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  CalendarClock,
  Check,
  ChevronDown,
  Clock,
  FolderOpen,
  PauseCircle,
  Pencil,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import { useAspStore } from "@/asp/asp-store";
import { desktopApi } from "@/asp/desktop-api";
import { cn } from "@/ui/cn";
import { confirmDialog } from "@/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/ui/dialog";
import { toast } from "@/ui/toast";
import { useI18nStore, useT } from "@/lib/i18n";
import { useUIStore } from "@/ui/ui-store";
import { useWorkspaceStore } from "@/workspaces/workspace-store";
import {
  formatDateInput,
  formatSchedule,
  formatTimeInput,
  useScheduledTaskStore,
  validateScheduledTaskInput,
  WEEKDAY_LABEL_KEYS,
  type ScheduledTask,
  type ScheduledTaskFrequency,
  type ScheduledTaskInput,
  type ScheduledTaskSchedule,
} from "./scheduled-task-store";

const SCHEDULE_TYPES: { id: ScheduledTaskFrequency; labelKey: string }[] = [
  { id: "once", labelKey: "schedule.once" },
  { id: "daily", labelKey: "schedule.daily" },
  { id: "weekly", labelKey: "schedule.weekly" },
  { id: "interval", labelKey: "schedule.interval" },
];
const FIELD_CLASS = "ui-field";

export type ScheduledTasksSectionHandle = {
  startCreate: (input?: Partial<ScheduledTaskInput>) => void;
};

type ScheduledTasksSectionProps = {
  showHeading?: boolean;
  showCreateButton?: boolean;
};

export const ScheduledTasksSection = forwardRef<
  ScheduledTasksSectionHandle,
  ScheduledTasksSectionProps
>(function ScheduledTasksSection({ showHeading = true, showCreateButton = true }, ref) {
  const t = useT();
  const tasks = useScheduledTaskStore((state) => state.tasks);
  const initialized = useScheduledTaskStore((state) => state.initialized);
  const addTask = useScheduledTaskStore((state) => state.addTask);
  const updateTask = useScheduledTaskStore((state) => state.updateTask);
  const removeTask = useScheduledTaskStore((state) => state.removeTask);
  const refreshTasks = useScheduledTaskStore((state) => state.refresh);
  const runTaskNow = useScheduledTaskStore((state) => state.runTaskNow);
  const setTaskEnabled = useScheduledTaskStore((state) => state.setTaskEnabled);
  const providers = useAspStore((state) => state.providers);
  const activeProviderId = useAspStore((state) => state.activeProviderId);
  const workspacePath = useAspStore((state) => state.workspacePath);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const approvalMode = useUIStore((state) => state.approvalMode);
  const model = useUIStore((state) => state.model);
  const effort = useUIStore((state) => state.effort);
  const speed = useUIStore((state) => state.speed);
  const enabledProviders = providers.filter((provider) => provider.enabled);
  const providerById = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider.name])),
    [providers],
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ScheduledTaskInput | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (initialized) return;
    void refreshTasks().catch(() => undefined);
  }, [initialized, refreshTasks]);

  const closeEditor = () => {
    setDraft(null);
    setEditingId(null);
    setError("");
  };

  const startCreate = (input: Partial<ScheduledTaskInput> = {}) => {
    const baseDraft = createDefaultDraft(
      input.providerId || activeProviderId || enabledProviders[0]?.id || "",
      activeWorkspaceId,
      {
        approvalMode,
        effort: scheduledEffort(effort),
        model: model || undefined,
        speed,
      },
    );
    setEditingId(null);
    setDraft({
      ...baseDraft,
      ...input,
      enabled: input.enabled ?? baseDraft.enabled,
      projectPath: input.projectPath !== undefined ? input.projectPath : baseDraft.projectPath,
      retryPolicy: input.retryPolicy ?? baseDraft.retryPolicy,
      schedule: input.schedule ? cloneSchedule(input.schedule) : baseDraft.schedule,
    });
    setError("");
  };

  useImperativeHandle(ref, () => ({ startCreate }));

  const startEdit = (task: ScheduledTask) => {
    setEditingId(task.id);
    setDraft({
      approvalMode: task.approvalMode,
      cwd: task.cwd,
      effort: task.effort,
      enabled: task.enabled,
      model: task.model,
      projectPath: task.projectPath,
      title: task.title,
      prompt: task.prompt,
      providerId: task.providerId,
      retryPolicy: { ...task.retryPolicy },
      schedule: cloneSchedule(task.schedule),
      speed: task.speed,
      workspaceId: task.workspaceId,
    });
    setError("");
  };

  const saveDraft = async () => {
    if (!draft) return;
    const validation = validateScheduledTaskInput(draft, t);
    if (validation) {
      setError(validation);
      return;
    }
    try {
      if (editingId) await updateTask(editingId, draft);
      else await addTask(draft);
      toast.success(editingId ? t("schedule.updated") : t("schedule.created"));
      closeEditor();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    }
  };

  const runNow = async (task: ScheduledTask) => {
    try {
      await runTaskNow(task.id);
      toast.info(t("schedule.runNow"), task.title);
    } catch (runError) {
      toast.error(
        t("schedule.failed"),
        runError instanceof Error ? runError.message : String(runError),
      );
    }
  };

  const deleteTask = async (task: ScheduledTask) => {
    const confirmed = await confirmDialog({
      title: t("schedule.deleteTitle"),
      description: t("schedule.deleteConfirm", { title: task.title }),
      confirmLabel: t("common.delete"),
      tone: "danger",
    });
    if (!confirmed) return;
    try {
      await removeTask(task.id);
      if (editingId === task.id) closeEditor();
    } catch (deleteError) {
      toast.error(
        t("schedule.failed"),
        deleteError instanceof Error ? deleteError.message : String(deleteError),
      );
    }
  };

  const toggleTask = async (task: ScheduledTask) => {
    try {
      await setTaskEnabled(task.id, !task.enabled);
    } catch (toggleError) {
      toast.error(
        t("schedule.failed"),
        toggleError instanceof Error ? toggleError.message : String(toggleError),
      );
    }
  };
  const showToolbar = showHeading || showCreateButton;

  return (
    <div className="flex flex-col gap-5">
      {showToolbar ? (
        <div
          className={cn("flex items-start gap-4", showHeading ? "justify-between" : "justify-end")}
        >
          {showHeading ? (
            <div>
              <h2 className="text-fg text-[18px] font-semibold">
                {t("settings.section.schedule")}
              </h2>
              <p className="text-muted mt-1 text-[13px]">{t("schedule.description")}</p>
            </div>
          ) : null}
          {showCreateButton ? (
            <button
              type="button"
              onClick={() => startCreate()}
              className="ui-button ui-button-primary shrink-0"
            >
              <Plus size={14} />
              {t("schedule.newTask")}
            </button>
          ) : null}
        </div>
      ) : null}

      <Dialog
        open={Boolean(draft)}
        onOpenChange={(open) => {
          if (!open) closeEditor();
        }}
      >
        <DialogContent className="max-h-[calc(100vh-32px)] max-w-2xl overflow-auto">
          <DialogHeader>
            <DialogTitle>
              {editingId ? t("schedule.editTitle") : t("schedule.newTitle")}
            </DialogTitle>
            <DialogDescription>{t("schedule.dialogDescription")}</DialogDescription>
          </DialogHeader>
          {draft ? (
            <ScheduledTaskEditor
              draft={draft}
              error={error}
              providers={enabledProviders}
              workspacePath={workspacePath}
              editing={Boolean(editingId)}
              onChange={(next) => {
                setDraft(next);
                if (error) setError("");
              }}
              onCancel={closeEditor}
              onSave={saveDraft}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      {tasks.length === 0 ? (
        <div className="ui-soft-card flex items-start gap-3 rounded-[8px] px-4 py-4">
          <div className="bg-surface-hover text-muted flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
            <CalendarClock size={17} strokeWidth={1.8} />
          </div>
          <div className="min-w-0">
            <div className="text-fg text-[13.5px] font-medium">{t("schedule.emptyTitle")}</div>
            <p className="text-muted mt-1 text-[12.5px]">{t("schedule.emptyDescription")}</p>
          </div>
        </div>
      ) : (
        <div className="divide-border-subtle border-border-subtle divide-y border-y">
          {tasks.map((task) => (
            <ScheduledTaskRow
              key={task.id}
              task={task}
              providerName={providerById.get(task.providerId) ?? task.providerId}
              onEdit={() => startEdit(task)}
              onRunNow={() => void runNow(task)}
              onToggle={() => void toggleTask(task)}
              onDelete={() => void deleteTask(task)}
            />
          ))}
        </div>
      )}
    </div>
  );
});

function ScheduledTaskEditor({
  draft,
  error,
  providers,
  workspacePath,
  editing,
  onChange,
  onCancel,
  onSave,
}: {
  draft: ScheduledTaskInput;
  error: string;
  providers: { id: string; name: string }[];
  workspacePath: string;
  editing: boolean;
  onChange: (draft: ScheduledTaskInput) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const t = useT();
  const validationMessage = validateScheduledTaskInput(draft, t);
  const chooseProject = async () => {
    const api = desktopApi();
    if (!api) {
      toast.error(t("schedule.projectPickerUnavailable"));
      return;
    }
    const selected = await api.workspace.choose(draft.projectPath || workspacePath || undefined);
    if (selected) onChange({ ...draft, projectPath: selected });
  };

  return (
    <div className="mt-5 grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label={t("schedule.taskName")}
          value={draft.title}
          required
          onChange={(title) => onChange({ ...draft, title })}
        />
        <label>
          <span className="text-subtle mb-1.5 block text-[11px] font-semibold tracking-wide uppercase">
            {t("schedule.agent")}
          </span>
          <div className="relative">
            <select
              value={draft.providerId}
              required
              onChange={(event) => onChange({ ...draft, providerId: event.target.value })}
              className={cn(FIELD_CLASS, "appearance-none pr-8")}
            >
              {providers.length === 0 ? (
                <option value="">{t("schedule.validation.agentRequired")}</option>
              ) : null}
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
            <ChevronDown
              size={15}
              className="text-subtle pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2"
            />
          </div>
        </label>
      </div>

      <label>
        <span className="text-subtle mb-1.5 block text-[11px] font-semibold tracking-wide uppercase">
          {t("schedule.prompt")}
        </span>
        <textarea
          rows={5}
          required
          value={draft.prompt}
          onChange={(event) => onChange({ ...draft, prompt: event.target.value })}
          className={cn(FIELD_CLASS, "resize-y leading-5")}
        />
      </label>

      <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
        <div>
          <span className="text-subtle mb-1.5 block text-[11px] font-semibold tracking-wide uppercase">
            {t("schedule.project")}
          </span>
          <button
            type="button"
            onClick={chooseProject}
            className="ui-button bg-input min-h-9 w-full justify-start text-left"
          >
            <FolderOpen size={15} className="text-info shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              {draft.projectPath ? projectLabel(draft.projectPath) : t("common.noProject")}
            </span>
          </button>
        </div>
        <div className="flex items-end gap-2">
          <button
            type="button"
            aria-pressed={draft.projectPath === null}
            onClick={() => onChange({ ...draft, projectPath: null })}
            className="ui-button aria-pressed:border-border-strong aria-pressed:bg-surface aria-pressed:text-fg min-h-9"
          >
            {t("common.noProject")}
          </button>
        </div>
      </div>

      <ScheduleEditor
        schedule={draft.schedule}
        onChange={(schedule) => onChange({ ...draft, schedule })}
      />

      <RetryPolicyEditor
        retryPolicy={draft.retryPolicy ?? { backoffMinutes: 5, maxRetries: 1 }}
        onChange={(retryPolicy) => onChange({ ...draft, retryPolicy })}
      />

      <label className="text-muted flex items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => onChange({ ...draft, enabled: event.target.checked })}
          className="h-4 w-4"
        />
        {t("common.enabled")}
      </label>

      {error || validationMessage ? (
        <div
          aria-live="polite"
          className="border-danger/40 bg-danger/10 text-danger rounded-lg border px-3 py-2 text-[12.5px]"
        >
          {error || validationMessage}
        </div>
      ) : null}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="ui-button">
          {t("common.cancel")}
        </button>
        <button
          type="button"
          disabled={Boolean(validationMessage)}
          onClick={onSave}
          className="ui-button ui-button-primary"
        >
          {editing ? t("common.save") : t("common.create")}
        </button>
      </div>
    </div>
  );
}

function ScheduleEditor({
  schedule,
  onChange,
}: {
  schedule: ScheduledTaskSchedule;
  onChange: (schedule: ScheduledTaskSchedule) => void;
}) {
  const t = useT();
  const setType = (type: ScheduledTaskFrequency) => {
    if (schedule.type === type) return;
    onChange(defaultSchedule(type, schedule));
  };

  return (
    <div className="grid gap-3">
      <span className="text-subtle text-[11px] font-semibold tracking-wide uppercase">
        {t("schedule.schedule")}
      </span>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {SCHEDULE_TYPES.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={schedule.type === item.id}
            onClick={() => setType(item.id)}
            className={cn(
              "ui-button h-8 px-3",
              schedule.type === item.id ? "border-border-strong bg-surface text-fg" : "text-muted",
            )}
          >
            {t(item.labelKey)}
          </button>
        ))}
      </div>

      {schedule.type === "once" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <DateField
            label={t("schedule.date")}
            value={schedule.date}
            onChange={(date) => onChange({ ...schedule, date })}
          />
          <TimeField
            label={t("schedule.time")}
            value={schedule.time}
            onChange={(time) => onChange({ ...schedule, time })}
          />
        </div>
      ) : null}

      {schedule.type === "daily" ? (
        <TimeField
          label={t("schedule.time")}
          value={schedule.time}
          onChange={(time) => onChange({ ...schedule, time })}
        />
      ) : null}

      {schedule.type === "weekly" ? (
        <div className="grid gap-3">
          <div className="grid grid-cols-7 gap-1">
            {WEEKDAY_LABEL_KEYS.map((labelKey, day) => {
              const selected = schedule.weekdays.includes(day);
              return (
                <button
                  key={labelKey}
                  type="button"
                  onClick={() =>
                    onChange({
                      ...schedule,
                      weekdays: selected
                        ? schedule.weekdays.filter((item) => item !== day)
                        : [...schedule.weekdays, day].sort((a, b) => a - b),
                    })
                  }
                  className={cn(
                    "flex h-8 items-center justify-center rounded-lg text-[12px] font-medium",
                    selected
                      ? "bg-surface text-fg"
                      : "text-muted hover:bg-surface-hover hover:text-fg",
                  )}
                >
                  {t(labelKey)}
                </button>
              );
            })}
          </div>
          <TimeField
            label={t("schedule.time")}
            value={schedule.time}
            onChange={(time) => onChange({ ...schedule, time })}
          />
        </div>
      ) : null}

      {schedule.type === "interval" ? (
        <label>
          <span className="text-subtle mb-1.5 block text-[11px] font-semibold tracking-wide uppercase">
            {t("schedule.minutes")}
          </span>
          <input
            type="number"
            min={1}
            step={1}
            value={schedule.intervalMinutes}
            onChange={(event) =>
              onChange({
                ...schedule,
                intervalMinutes: Math.max(1, Number(event.target.value) || 1),
              })
            }
            className={FIELD_CLASS}
          />
        </label>
      ) : null}
    </div>
  );
}

function RetryPolicyEditor({
  retryPolicy,
  onChange,
}: {
  retryPolicy: NonNullable<ScheduledTaskInput["retryPolicy"]>;
  onChange: (retryPolicy: NonNullable<ScheduledTaskInput["retryPolicy"]>) => void;
}) {
  const t = useT();
  return (
    <div className="grid gap-3">
      <span className="text-subtle text-[11px] font-semibold tracking-wide uppercase">
        {t("schedule.retry")}
      </span>
      <div className="grid gap-3 sm:grid-cols-2">
        <label>
          <span className="text-subtle mb-1.5 block text-[11px] font-semibold tracking-wide uppercase">
            {t("schedule.retryMax")}
          </span>
          <input
            type="number"
            min={0}
            max={5}
            step={1}
            value={retryPolicy.maxRetries}
            onChange={(event) =>
              onChange({
                ...retryPolicy,
                maxRetries: Math.min(5, Math.max(0, Number(event.target.value) || 0)),
              })
            }
            className={FIELD_CLASS}
          />
        </label>
        <label>
          <span className="text-subtle mb-1.5 block text-[11px] font-semibold tracking-wide uppercase">
            {t("schedule.retryBackoff")}
          </span>
          <input
            type="number"
            min={1}
            max={10080}
            step={1}
            value={retryPolicy.backoffMinutes}
            onChange={(event) =>
              onChange({
                ...retryPolicy,
                backoffMinutes: Math.min(10080, Math.max(1, Number(event.target.value) || 1)),
              })
            }
            className={FIELD_CLASS}
          />
        </label>
      </div>
    </div>
  );
}

function ScheduledTaskRow({
  task,
  providerName,
  onEdit,
  onRunNow,
  onToggle,
  onDelete,
}: {
  task: ScheduledTask;
  providerName: string;
  onEdit: () => void;
  onRunNow: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const lang = useI18nStore((state) => state.lang);
  const latestRun = task.runHistory[0];
  return (
    <div className="py-4">
      <div className="flex items-start gap-3">
        <div className="bg-surface-hover text-muted flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
          <Clock size={17} strokeWidth={1.8} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="text-fg truncate text-[13.5px] font-semibold">{task.title}</h3>
            <span
              className={cn(
                "shrink-0 rounded-full px-2 py-0.5 text-[11px]",
                task.enabled ? "bg-success/10 text-success" : "bg-surface-hover text-subtle",
              )}
            >
              {task.enabled ? t("common.enabled") : t("common.paused")}
            </span>
          </div>
          <div className="text-subtle mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
            <span>{formatSchedule(task.schedule, t)}</span>
            <span>{providerName}</span>
            <span>{task.projectPath ? projectLabel(task.projectPath) : t("common.noProject")}</span>
          </div>
          <p className="text-muted mt-2 line-clamp-2 text-[12.5px] leading-5">{task.prompt}</p>
          <div className="text-subtle mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px]">
            <span>{t("schedule.next", { time: formatTimestamp(task.nextRunAt, t, lang) })}</span>
            <span>{t("schedule.last", { time: formatTimestamp(task.lastRunAt, t, lang) })}</span>
            <span>{t("schedule.runs", { count: task.runCount })}</span>
            <span>
              {t("schedule.retrySummary", {
                backoff: task.retryPolicy.backoffMinutes,
                retries: task.retryPolicy.maxRetries,
              })}
            </span>
            {task.pendingRetry ? (
              <span>
                {t("schedule.pendingRetry", {
                  attempt: task.pendingRetry.attempt,
                  time: formatTimestamp(task.nextRunAt, t, lang),
                })}
              </span>
            ) : null}
            {task.missedRunCount > 0 ? (
              <span>{t("schedule.missedRuns", { count: task.missedRunCount })}</span>
            ) : null}
            {task.failureCount > 0 ? (
              <span>{t("schedule.failures", { count: task.failureCount })}</span>
            ) : null}
          </div>
          {latestRun ? (
            <div className="text-subtle mt-1 text-[11.5px]">
              {t("schedule.latestRun", {
                reason: t(`schedule.reason.${latestRun.reason}`),
                status: t(`schedule.status.${latestRun.status}`),
                time: formatTimestamp(latestRun.finishedAt ?? latestRun.startedAt, t, lang),
              })}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton label={t("schedule.runNow")} onClick={onRunNow}>
            <Play size={14} />
          </IconButton>
          <IconButton
            label={task.enabled ? t("schedule.pause") : t("schedule.enable")}
            onClick={onToggle}
          >
            {task.enabled ? <PauseCircle size={14} /> : <Check size={14} />}
          </IconButton>
          <IconButton label={t("common.edit")} onClick={onEdit}>
            <Pencil size={14} />
          </IconButton>
          <IconButton label={t("common.delete")} onClick={onDelete} danger>
            <Trash2 size={14} />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

function IconButton({
  label,
  danger,
  children,
  onClick,
}: {
  label: string;
  danger?: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn("ui-icon-button h-7 w-7 rounded-md", danger && "hover:text-danger")}
    >
      {children}
    </button>
  );
}

function TextField({
  label,
  value,
  onChange,
  required = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
}) {
  return (
    <label>
      <span className="text-subtle mb-1.5 block text-[11px] font-semibold tracking-wide uppercase">
        {label}
      </span>
      <input
        value={value}
        required={required}
        onChange={(event) => onChange(event.target.value)}
        className={FIELD_CLASS}
      />
    </label>
  );
}

function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      <span className="text-subtle mb-1.5 block text-[11px] font-semibold tracking-wide uppercase">
        {label}
      </span>
      <input
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={FIELD_CLASS}
      />
    </label>
  );
}

function TimeField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      <span className="text-subtle mb-1.5 block text-[11px] font-semibold tracking-wide uppercase">
        {label}
      </span>
      <input
        type="time"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={FIELD_CLASS}
      />
    </label>
  );
}

function createDefaultDraft(
  providerId: string,
  workspaceId: string,
  runSettings: Pick<ScheduledTaskInput, "approvalMode" | "effort" | "model" | "speed">,
): ScheduledTaskInput {
  return {
    ...runSettings,
    title: "",
    prompt: "",
    providerId,
    projectPath: null,
    workspaceId,
    schedule: { type: "daily", time: "09:00" },
    retryPolicy: { backoffMinutes: 5, maxRetries: 1 },
    enabled: true,
  };
}

function scheduledEffort(effort: string): ScheduledTaskInput["effort"] {
  return effort === "none" ||
    effort === "minimal" ||
    effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh" ||
    effort === "max"
    ? effort
    : undefined;
}

function defaultSchedule(
  type: ScheduledTaskFrequency,
  current: ScheduledTaskSchedule,
): ScheduledTaskSchedule {
  const time = "time" in current ? current.time : formatTimeInput(nextHour());
  switch (type) {
    case "once":
      return { type, date: formatDateInput(), time };
    case "daily":
      return { type, time };
    case "weekly":
      return { type, weekdays: [new Date().getDay()], time };
    case "interval":
      return { type, intervalMinutes: 60 };
  }
}

function cloneSchedule(schedule: ScheduledTaskSchedule): ScheduledTaskSchedule {
  return schedule.type === "weekly"
    ? { ...schedule, weekdays: [...schedule.weekdays] }
    : { ...schedule };
}

function nextHour(): Date {
  const date = new Date();
  date.setHours(date.getHours() + 1, 0, 0, 0);
  return date;
}

function projectLabel(projectPath: string): string {
  return projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? projectPath;
}

function formatTimestamp(
  timestamp: number | undefined | null,
  t: ReturnType<typeof useT>,
  lang: "en" | "zh",
): string {
  if (!timestamp) return t("schedule.noTime");
  return new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}
