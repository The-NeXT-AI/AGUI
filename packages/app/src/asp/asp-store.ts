import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  desktopApi,
  type ApprovalRequestPayload,
  type AspApprovalDecision,
  type AspModel,
  type AspQuestion,
  type AspProvider,
  type AspQuestionResponse,
  type QuestionRequestPayload,
} from "./desktop-api";
import { notifyAgentNeedsInput } from "@/chat/task-notifications";
import { t } from "@/lib/i18n";
import { createPersistentJsonStorage } from "@/storage/persistent-storage";

interface AspStore {
  available: boolean;
  initialized: boolean;
  providers: AspProvider[];
  unavailableProviderIds: string[];
  activeProviderId: string;
  workspacePath: string;
  privateSessionsRoot: string;
  approvalQueue: ApprovalRequestPayload[];
  questionQueue: QuestionRequestPayload[];
  initialize: () => Promise<void>;
  refreshProviders: () => Promise<void>;
  refreshProviderCapabilities: (
    providerId: string,
    cwd: string,
  ) => Promise<AspProvider | undefined>;
  checkProviderAvailability: (providerId: string, cwd: string) => Promise<boolean>;
  setActiveProvider: (id: string) => void;
  chooseWorkspace: () => Promise<string | null>;
  setWorkspacePath: (path: string) => void;
  saveProvider: (provider: AspProvider) => Promise<AspProvider>;
  removeProvider: (id: string) => Promise<void>;
  enqueueApproval: (request: ApprovalRequestPayload) => void;
  respondApproval: (
    requestId: string,
    decision: AspApprovalDecision,
    message?: string,
  ) => Promise<void>;
  enqueueQuestion: (request: QuestionRequestPayload) => void;
  respondQuestion: (requestId: string, response: AspQuestionResponse) => Promise<void>;
}

export const useAspStore = create<AspStore>()(
  persist(
    (set, get) => ({
      available: false,
      initialized: false,
      providers: [],
      unavailableProviderIds: [],
      activeProviderId: "codex",
      workspacePath: "",
      privateSessionsRoot: "",
      approvalQueue: [],
      questionQueue: [],

      initialize: async () => {
        const api = desktopApi();
        if (!api) {
          set({ available: false, initialized: true });
          return;
        }
        try {
          const [providerList, defaultWorkspace, privateSessionsRoot] = await Promise.all([
            api.providers.list(),
            api.workspace.getDefault(),
            api.workspace.privateRoot(),
          ]);
          const providers = sanitizeProviders(providerList);
          const currentProvider = get().activeProviderId;
          const activeProviderId = providers.some((provider) => provider.id === currentProvider)
            ? currentProvider
            : (providers.find((provider) => provider.enabled)?.id ?? "");
          set({
            available: true,
            initialized: true,
            providers,
            unavailableProviderIds: get().unavailableProviderIds.filter((id) =>
              providers.some((provider) => provider.id === id),
            ),
            activeProviderId,
            workspacePath: get().workspacePath || defaultWorkspace,
            privateSessionsRoot,
          });
        } catch {
          set({ available: false, initialized: true });
        }
      },

      refreshProviders: async () => {
        const api = desktopApi();
        if (!api) return;
        const providers = sanitizeProviders(await api.providers.list());
        const currentProvider = get().activeProviderId;
        const activeProviderId = providers.some((provider) => provider.id === currentProvider)
          ? currentProvider
          : (providers.find((provider) => provider.enabled)?.id ?? "");
        set({
          available: true,
          initialized: true,
          providers,
          unavailableProviderIds: get().unavailableProviderIds.filter((id) =>
            providers.some((provider) => provider.id === id),
          ),
          activeProviderId,
        });
      },

      refreshProviderCapabilities: async (providerId, cwd) => {
        const api = desktopApi();
        const provider = get().providers.find((item) => item.id === providerId);
        if (!api || !provider) return provider;
        const result = cwd
          ? await api.providers.capabilities({ providerId, cwd }).catch(() => null)
          : await api.providers.test(provider).catch(() => null);
        const needsFallback =
          Boolean(cwd) &&
          (!result?.ok || (result.capabilities.models !== false && !result.models.length));
        const fallbackResult = needsFallback
          ? await api.providers.test(provider).catch(() => null)
          : result;
        const refreshedResult = fallbackResult?.ok ? fallbackResult : null;
        if (!refreshedResult) return provider;
        const refreshed: AspProvider = {
          ...provider,
          capabilities: refreshedResult.capabilities,
          models: refreshedProviderModels(provider, refreshedResult.models),
        };
        set((state) => ({
          providers: state.providers.map((item) => (item.id === providerId ? refreshed : item)),
        }));
        return refreshed;
      },

      checkProviderAvailability: async (providerId, cwd) => {
        const api = desktopApi();
        const provider = get().providers.find((item) => item.id === providerId);
        if (!api || !provider) return false;
        const result = cwd
          ? await api.providers.capabilities({ providerId, cwd }).catch(() => null)
          : await api.providers.test(provider).catch(() => null);
        if (!result?.ok) {
          set((state) => ({
            unavailableProviderIds: state.unavailableProviderIds.includes(providerId)
              ? state.unavailableProviderIds
              : [...state.unavailableProviderIds, providerId],
          }));
          return false;
        }
        const refreshed: AspProvider = {
          ...provider,
          capabilities: result.capabilities,
          models: refreshedProviderModels(provider, result.models),
        };
        set((state) => ({
          providers: state.providers.map((item) => (item.id === providerId ? refreshed : item)),
          unavailableProviderIds: state.unavailableProviderIds.filter((id) => id !== providerId),
        }));
        return true;
      },

      setActiveProvider: (activeProviderId) => set({ activeProviderId }),

      chooseWorkspace: async () => {
        const api = desktopApi();
        if (!api) return null;
        const selected = await api.workspace.choose(get().workspacePath || undefined);
        if (selected) set({ workspacePath: selected });
        return selected;
      },

      setWorkspacePath: (workspacePath) => set({ workspacePath }),

      saveProvider: async (provider) => {
        const api = desktopApi();
        if (!api) throw new Error("Provider configuration is only available in Electron.");
        const saved = await api.providers.save(provider);
        const providers = sanitizeProviders(await api.providers.list());
        set((state) => ({
          providers,
          unavailableProviderIds: state.unavailableProviderIds.filter((id) => id !== saved.id),
        }));
        return saved;
      },

      removeProvider: async (id) => {
        const api = desktopApi();
        if (!api) return;
        await api.providers.remove(id);
        const providers = sanitizeProviders(await api.providers.list());
        const activeProviderId =
          get().activeProviderId === id
            ? (providers.find((provider) => provider.enabled)?.id ?? "")
            : get().activeProviderId;
        set((state) => ({
          providers,
          activeProviderId,
          unavailableProviderIds: state.unavailableProviderIds.filter(
            (providerId) => providerId !== id,
          ),
        }));
      },

      enqueueApproval: (request) => {
        let added = false;
        set((state) => {
          if (state.approvalQueue.some((item) => item.requestId === request.requestId)) {
            return state;
          }
          added = true;
          return { approvalQueue: [...state.approvalQueue, request] };
        });
        if (added) {
          notifyAgentNeedsInput({
            sessionId: request.uiSessionId,
            title: "Agent needs approval",
            body: approvalNotificationBody(request),
          });
        }
      },

      respondApproval: async (requestId, decision, message) => {
        const api = desktopApi();
        if (api) await api.interactions.respondApproval({ requestId, decision, message });
        set((state) => ({
          approvalQueue: state.approvalQueue.filter((item) => item.requestId !== requestId),
        }));
      },

      enqueueQuestion: (request) => {
        let added = false;
        set((state) => {
          if (state.questionQueue.some((item) => item.requestId === request.requestId)) {
            return state;
          }
          added = true;
          return { questionQueue: [...state.questionQueue, request] };
        });
        if (added) {
          notifyAgentNeedsInput({
            sessionId: request.uiSessionId,
            title: request.title || t("question.title"),
            body: questionNotificationBody(request),
          });
        }
      },

      respondQuestion: async (requestId, response) => {
        const api = desktopApi();
        if (api) await api.interactions.respondQuestion({ requestId, response });
        set((state) => ({
          questionQueue: state.questionQueue.filter((item) => item.requestId !== requestId),
        }));
      },
    }),
    {
      name: "agui-asp-preferences",
      storage: createPersistentJsonStorage(),
      partialize: (state) => ({
        activeProviderId: state.activeProviderId,
        workspacePath: state.workspacePath,
      }),
    },
  ),
);

function questionNotificationBody(request: QuestionRequestPayload): string | undefined {
  return (
    notificationText(request.question) ||
    notificationText(request.instructions) ||
    notificationText(firstQuestionText(request.questions))
  );
}

function approvalNotificationBody(request: ApprovalRequestPayload): string | undefined {
  return notificationText(request.title) || notificationText(request.method);
}

function firstQuestionText(questions: AspQuestion[]): string | undefined {
  const first = questions.find((question) => notificationText(question.question));
  if (!first) return undefined;
  const header = notificationText(first.header);
  const question = notificationText(first.question);
  return header ? `${header}: ${question}` : question;
}

function notificationText(value: string | undefined): string | undefined {
  const text = value?.replace(/\s+/g, " ").trim();
  return text || undefined;
}

function sanitizeProviders(providers: AspProvider[]): AspProvider[] {
  return providers.map(sanitizeProviderModels);
}

function sanitizeProviderModels(provider: AspProvider): AspProvider {
  if (!isSyntheticClaudeCodeModelList(provider, provider.models ?? [])) return provider;
  return { ...provider, models: [] };
}

function refreshedProviderModels(provider: AspProvider, models: AspModel[]): AspModel[] {
  const existing = provider.models ?? [];
  return models.length ? mergeProviderModels(models, existing) : existing;
}

function mergeProviderModels(models: AspModel[], existing: AspModel[]): AspModel[] {
  if (!models.length) return [];
  return models.map((model) => {
    const previous = existing.find((item) => sameProviderModel(item, model));
    if (!previous) return model;
    return {
      ...previous,
      ...model,
      contextWindowTokens: model.contextWindowTokens ?? previous.contextWindowTokens,
      defaultReasoningEffort:
        model.defaultReasoningEffort ?? previous.defaultReasoningEffort ?? null,
      supportedReasoningEfforts: model.supportedReasoningEfforts?.length
        ? model.supportedReasoningEfforts
        : previous.supportedReasoningEfforts,
      supportedSpeeds: model.supportedSpeeds?.length
        ? model.supportedSpeeds
        : previous.supportedSpeeds,
    };
  });
}

function sameProviderModel(left: AspModel, right: AspModel): boolean {
  return modelIdentityValues(left).some((leftValue) =>
    modelIdentityValues(right).some((rightValue) => modelNameMatches(leftValue, rightValue)),
  );
}

function modelIdentityValues(model: AspModel): string[] {
  return [model.id, model.model, model.displayName].filter((value): value is string =>
    Boolean(value),
  );
}

function modelNameMatches(left: string, right: string): boolean {
  if (left === right) return true;
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  const comparableLeft = modelComparableName(left);
  const comparableRight = modelComparableName(right);
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.endsWith(`/${normalizedRight}`) ||
    normalizedRight.endsWith(`/${normalizedLeft}`) ||
    comparableLeft === comparableRight ||
    comparableLeft.endsWith(` ${comparableRight}`) ||
    comparableRight.endsWith(` ${comparableLeft}`)
  );
}

function modelComparableName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\([^)]*\bcontext\b[^)]*\)/gi, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isSyntheticClaudeCodeModelList(provider: AspProvider, models: AspModel[]): boolean {
  if (!isClaudeCodeProvider(provider)) return false;
  const visible = models.filter((model) => !model.hidden);
  if (visible.length !== 4) return false;
  const signature = visible
    .map((model) => `${model.id}|${model.model}|${model.displayName}`)
    .sort()
    .join("\n");
  return (
    signature === "default|default|Default\nhaiku|haiku|Haiku\nopus|opus|Opus\nsonnet|sonnet|Sonnet"
  );
}

function isClaudeCodeProvider(provider: AspProvider): boolean {
  const capabilities = provider.capabilities;
  return [capabilities?.runtimeAdapter, capabilities?.wireProtocol]
    .map((value) => String(value ?? "").toLowerCase())
    .some((value) => value === "claude-code-stream-json" || value === "claude-code");
}
