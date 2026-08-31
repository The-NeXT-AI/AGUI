import { useMemo } from "react";
import { useAspStore } from "@/asp/asp-store";
import { useChatStore } from "@/chat/chat-store";

export function useActiveSessionExtensionData() {
  const activeProviderId = useAspStore((state) => state.activeProviderId);
  const activeSessionId = useChatStore((state) => state.activeSessionId ?? "");
  const activeSessionTree = useChatStore(
    (state) =>
      state.sessions.find((item) => item.id === state.activeSessionId)?.extensionState?.sessionTree,
  );
  const sessionProviderId = useChatStore(
    (state) => state.sessions.find((item) => item.id === state.activeSessionId)?.providerId,
  );
  const sessionStreaming = useChatStore(
    (state) =>
      state.sessions.find((item) => item.id === state.activeSessionId)?.status === "streaming",
  );
  return useMemo(
    () => ({
      activeSessionId,
      providerId: sessionProviderId || activeProviderId || "",
      sessionTree: activeSessionTree ?? null,
      streaming: Boolean(sessionStreaming),
    }),
    [activeProviderId, activeSessionId, activeSessionTree, sessionProviderId, sessionStreaming],
  );
}
