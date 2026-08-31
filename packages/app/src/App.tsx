import { useEffect } from "react";
import { ExtensionHost, useShellStore } from "@agui/app";
import { AppShell } from "@/shell/AppShell";
import { CommandPalette } from "@/command/CommandPalette";
import { SearchChatsDialog } from "@/shell/SearchChatsDialog";
import { builtinExtensions } from "@/extensions/builtins";
import { chatWorkspaceId, installWorkspaceSessionIsolation, useChatStore } from "@/chat/chat-store";
import { useUIStore } from "@/ui/ui-store";
import { Toaster } from "@/ui/toast";
import { ConfirmDialogHost } from "@/ui/confirm-dialog";
import { KeyBindings } from "@/lib/keybindings";
import { TooltipProvider } from "@/ui/tooltip";
import { useAspStore } from "@/asp/asp-store";
import { installAspBridge } from "@/asp/asp-bridge";
import { ExtensionRuntimeHost } from "@/extensions/ExtensionRuntimeHost";
import { FloatingWidgetsHost } from "@/extensions/FloatingWidgetsHost";
import { installAgentTaskNotificationNavigation } from "@/chat/task-notifications";
import { installScheduledTaskBridge } from "@/schedule/scheduled-task-bridge";
import { productConfig } from "@/product/product-config";
import { ProductCustomizationController } from "@/product/ProductCustomizationController";
import { UIRegion } from "@/product/UIRegion";
import { installWorkspacePreferenceSync, useWorkspaceStore } from "@/workspaces/workspace-store";
import { PanelRuntimeBridge } from "@/shell/PanelRuntimeBridge";
import { DesktopThemeSync } from "@/ui/DesktopThemeSync";

export default function App() {
  useEffect(() => {
    let disposed = false;
    const uninstallBridge = installAspBridge();
    const uninstallScheduledTaskBridge = productConfig.features.scheduledTasks
      ? installScheduledTaskBridge()
      : () => undefined;
    const uninstallWorkspaceSync = installWorkspacePreferenceSync();
    const uninstallWorkspaceSessionIsolation = installWorkspaceSessionIsolation();
    const uninstallTaskNotifications = installAgentTaskNotificationNavigation((sessionId) => {
      const chat = useChatStore.getState();
      const activeWorkspaceId = chatWorkspaceId(useWorkspaceStore.getState().activeWorkspaceId);
      if (
        !chat.sessions.some(
          (session) =>
            session.id === sessionId &&
            !session.archivedAt &&
            chatWorkspaceId(session.workspaceId) === activeWorkspaceId,
        )
      ) {
        return;
      }
      const ui = useUIStore.getState();
      ui.closeExtensions();
      ui.closeSchedule();
      ui.closeSettings();
      ui.closePalette();
      ui.setSearchChatsOpen(false);
      ui.setFindOpen(false);
      chat.openSession(sessionId);
    });
    void useAspStore
      .getState()
      .initialize()
      .then(() => {
        if (disposed) return;
        let chat = useChatStore.getState();
        const asp = useAspStore.getState();
        useWorkspaceStore.getState().initialize({ defaultPath: asp.workspacePath });
        const activeWorkspaceId = chatWorkspaceId(useWorkspaceStore.getState().activeWorkspaceId);
        chat.isolateWorkspaceSessions(activeWorkspaceId);
        chat = useChatStore.getState();
        if (chat.sessions.length === 0) {
          chat.startDraftSession();
        } else {
          useChatStore.setState((state) => ({
            sessions: state.sessions.map((session) => ({
              ...session,
              providerId: session.providerId || asp.activeProviderId,
              projectPath:
                session.projectPath !== undefined
                  ? session.projectPath
                  : session.privateSessionPath
                    ? null
                    : session.cwd || asp.workspacePath || null,
              cwd:
                session.projectPath === null
                  ? session.cwd || session.privateSessionPath || ""
                  : session.cwd ||
                    session.projectPath ||
                    session.privateSessionPath ||
                    asp.workspacePath ||
                    "",
            })),
          }));
          const latest = useChatStore.getState();
          const initialSessionId = initialSessionIdFromUrl();
          const activeSessionId = latest.activeSessionId;
          const initialSessionAvailable = Boolean(
            initialSessionId &&
            latest.sessions.some(
              (session) =>
                session.id === initialSessionId &&
                !session.archivedAt &&
                chatWorkspaceId(session.workspaceId) === activeWorkspaceId,
            ),
          );
          const activeSessionAvailable = Boolean(
            activeSessionId &&
            latest.sessions.some(
              (session) =>
                session.id === activeSessionId &&
                !session.archivedAt &&
                chatWorkspaceId(session.workspaceId) === activeWorkspaceId,
            ),
          );
          if (initialSessionAvailable && initialSessionId) {
            latest.openSession(initialSessionId);
          } else if (!activeSessionAvailable) {
            latest.startDraftSession();
          } else if (activeSessionId) {
            latest.openSession(activeSessionId);
          }
        }
      });
    useShellStore.getState().setActivePanel(productConfig.navigation.initialSidebarPanelId);
    return () => {
      disposed = true;
      uninstallBridge();
      uninstallWorkspaceSync();
      uninstallWorkspaceSessionIsolation();
      uninstallTaskNotifications();
      uninstallScheduledTaskBridge();
    };
  }, []);

  return (
    <TooltipProvider>
      <ProductCustomizationController />
      <DesktopThemeSync />
      <ExtensionHost extensions={builtinExtensions}>
        <ExtensionRuntimeHost />
        <PanelRuntimeBridge />
        <UIRegion id="app.keybindings">
          <KeyBindings />
        </UIRegion>
        <UIRegion id="app.shell">
          <AppShell />
        </UIRegion>
        <UIRegion id="app.floatingWidgets">
          <FloatingWidgetsHost />
        </UIRegion>
        <UIRegion id="app.commandPalette">
          <CommandPalette />
        </UIRegion>
        <UIRegion id="app.searchChatsDialog">
          <SearchChatsDialog />
        </UIRegion>
        <UIRegion id="app.toaster">
          <Toaster />
        </UIRegion>
        <UIRegion id="app.confirmDialog">
          <ConfirmDialogHost />
        </UIRegion>
      </ExtensionHost>
    </TooltipProvider>
  );
}

function initialSessionIdFromUrl(): string | null {
  try {
    return new URLSearchParams(window.location.search).get("sessionId");
  } catch {
    return null;
  }
}
