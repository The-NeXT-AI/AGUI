import type {
  ExtensionAssetResult,
  ResolveAgentContributionsInput,
  ResolvedAgentContributions,
} from "@/asp/desktop-api";
import { desktopApi } from "@/asp/desktop-api";
import { readExtensionAsset, useExtensionStore } from "./extension-store";

const EMPTY_RESOURCES: ResolvedAgentContributions = {
  extensionIds: [],
  mcpServers: [],
  skills: [],
  prompts: [],
  warnings: [],
};

/**
 * Frontend facade for backend extension execution.
 *
 * The concrete Electron host already runs executable extensions in a dedicated
 * utility process. Keeping renderer code behind this facade makes UI slots,
 * commands, and future backend providers use the same lifecycle/RPC boundary.
 */
export const backendExtensionHost = {
  activate(extensionId: string, event: string): Promise<void> {
    return useExtensionStore.getState().activate(extensionId, event);
  },

  readAsset(
    extensionId: string,
    path: string,
    workspaceId?: string,
  ): Promise<ExtensionAssetResult> {
    return readExtensionAsset(extensionId, path, workspaceId);
  },

  executeCommand(extensionId: string, command: string, args: unknown[] = []): Promise<unknown> {
    return useExtensionStore.getState().executeCommand(extensionId, command, args);
  },

  async resolveAgentContributions(
    input: ResolveAgentContributionsInput,
  ): Promise<ResolvedAgentContributions> {
    const api = desktopApi()?.extensions;
    if (!api || !input.workspacePath) return EMPTY_RESOURCES;
    const resources = await api.resolveAgentContributions(input);
    const state = useExtensionStore.getState();
    return {
      ...resources,
      mcpServers: resources.mcpServers.filter(
        (item) => !state.disabledMcpServers.includes(item.id),
      ),
      skills: resources.skills.filter((item) => !state.disabledSkills.includes(item.id)),
      prompts: resources.prompts.filter((item) => !state.disabledPrompts.includes(item.id)),
    };
  },
};
