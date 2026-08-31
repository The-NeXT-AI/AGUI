import { ChevronDown, Folder, FolderOpen, X } from "lucide-react";
import type { MouseEvent } from "react";
import { desktopApi } from "@/asp/desktop-api";
import { useAspStore } from "@/asp/asp-store";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { useI18nStore, useT } from "@/lib/i18n";
import { cn } from "@/ui/cn";
import { useUIStore, type SidebarProjectNavItem } from "@/ui/ui-store";
import { useWorkspaceStore } from "@/workspaces/workspace-store";
import { useChatStore } from "./chat-store";

interface ProjectSwitcherProps {
  variant: "title" | "composer" | "sidebar";
  draftOnly?: boolean;
}

type ProjectOption = {
  key: string;
  label: string;
  projectPath: string;
  title: string;
};

export function ProjectSwitcher({ variant, draftOnly = false }: ProjectSwitcherProps) {
  const lang = useI18nStore((s) => s.lang);
  const t = useT();
  const api = desktopApi();
  const workspacePath = useAspStore((s) => s.workspacePath);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const projectNavItems = useUIStore((s) => s.sidebarProjectNavItems);
  const activeProjectIndex = useUIStore((s) => s.sidebarProjectNavIndex);
  const setActiveProjectIndex = useUIStore((s) => s.setSidebarProjectNavIndex);
  const draftSession = useChatStore((s) => s.draftSession);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const activeProjectPath = useChatStore((s) => {
    const session = s.sessions.find((item) => item.id === s.activeSessionId);
    if (!session) return undefined;
    return session.projectPath !== undefined
      ? session.projectPath
      : session.privateSessionPath
        ? null
        : session.cwd || null;
  });
  const activeProviderSessionId = useChatStore(
    (s) => s.sessions.find((session) => session.id === s.activeSessionId)?.providerSessionId,
  );
  const setDraftWorkspace = useChatStore((s) => s.setDraftWorkspace);
  const setSessionWorkspace = useChatStore((s) => s.setSessionWorkspace);
  const addSessionProject = useChatStore((s) => s.addSessionProject);
  const removeSessionProject = useChatStore((s) => s.removeSessionProject);

  if (draftOnly && activeSessionId) return null;

  const activeNavProjectPath = projectNavItems[activeProjectIndex]?.projectPath;
  const activeNavProject = projectNavItems[activeProjectIndex];
  const projectPath =
    variant === "sidebar"
      ? activeNavProject
        ? activeNavProject.projectPath
        : (draftSession?.projectPath ?? (workspacePath || null))
      : activeProjectPath !== undefined
        ? activeProjectPath
        : draftSession
          ? draftSession.projectPath
          : (activeNavProjectPath ?? (workspacePath || null));
  const editable = variant === "sidebar" || !activeProviderSessionId;
  const projectOptions = projectOptionsFromNavItems(projectNavItems, workspacePath, projectPath);
  const currentProjectPath = projectPath ? normalizeProjectPath(projectPath) : null;
  const currentKey = projectKeyForPath(currentProjectPath);
  const currentProject =
    variant === "sidebar" && activeNavProject
      ? {
          key: activeNavProject.key,
          label: activeNavProject.label,
          projectPath: activeNavProject.projectPath ?? "",
          title: activeNavProject.title,
        }
      : projectOptions.find((option) => option.key === currentKey);
  const currentLabel = projectPath
    ? (currentProject?.label ?? projectName(projectPath))
    : t("common.noProject");
  const chooseLabel = api?.features.nativeDialogs
    ? lang === "zh"
      ? "选择项目文件夹..."
      : "Choose project folder..."
    : lang === "zh"
      ? "打开服务器项目..."
      : "Open server project...";

  const selectProjectKeyAfterNavUpdate = (key: string) => {
    const index = projectNavItems.findIndex((item) => item.key === key);
    if (index >= 0) {
      setActiveProjectIndex(index);
      return;
    }
    window.requestAnimationFrame(() => {
      const updatedIndex = useUIStore
        .getState()
        .sidebarProjectNavItems.findIndex((item) => item.key === key);
      if (updatedIndex >= 0) useUIStore.getState().setSidebarProjectNavIndex(updatedIndex);
    });
  };

  const updateProject = (path: string | null) => {
    if (!editable) return;
    const normalized = path ? normalizeProjectPath(path) : null;
    if (variant === "sidebar") {
      useWorkspaceStore.getState().updateWorkspace(activeWorkspaceId, {
        projectPath: normalized,
      });
      if (!activeSessionId) setDraftWorkspace(normalized);
      selectProjectKeyAfterNavUpdate(projectKeyForPath(normalized));
      return;
    }

    if (activeSessionId) {
      setSessionWorkspace(activeSessionId, normalized ?? "");
    } else {
      setDraftWorkspace(normalized);
    }
    const nextKey = projectKeyForPath(normalized);
    selectProjectKeyAfterNavUpdate(nextKey);
  };

  const removeProject = (event: MouseEvent<HTMLButtonElement>, option: ProjectOption) => {
    event.preventDefault();
    event.stopPropagation();
    if (variant !== "sidebar") return;
    removeSessionProject(option.key);

    const remaining = projectNavItems.filter((item) => item.key !== option.key);
    const nextIndex = Math.max(0, Math.min(activeProjectIndex, remaining.length - 1));
    const nextProject = remaining[nextIndex];
    setActiveProjectIndex(nextIndex);
    if (currentKey === option.key || normalizeProjectPath(workspacePath) === option.projectPath) {
      useWorkspaceStore.getState().updateWorkspace(activeWorkspaceId, {
        projectPath: nextProject?.projectPath ?? null,
      });
    }
    if (!activeSessionId && currentKey === option.key) {
      setDraftWorkspace(nextProject?.projectPath ?? null);
    }
  };

  const chooseProject = async () => {
    if (!editable) return;
    if (variant === "sidebar") {
      const selected = await api?.workspace.choose((projectPath ?? workspacePath) || undefined);
      if (!selected) return;
      const normalized = normalizeProjectPath(selected);
      addSessionProject(normalized);
      updateProject(normalized);
      return;
    }
    const selected = await api?.workspace.choose((projectPath ?? workspacePath) || undefined);
    if (selected) updateProject(selected);
  };

  const TriggerIcon = variant === "composer" && projectPath ? FolderOpen : null;
  const triggerClass =
    variant === "title"
      ? "inline-flex min-w-0 max-w-[min(24rem,70vw)] items-center gap-1.5 rounded-[8px] px-2 py-1 text-[18px] font-semibold leading-none text-fg transition-colors hover:bg-surface-hover data-[state=open]:bg-surface-active"
      : variant === "sidebar"
        ? "flex min-h-9 w-full min-w-0 items-center gap-2 rounded-[8px] px-2.5 py-2 text-[14px] font-semibold text-fg transition-colors hover:bg-surface-hover data-[state=open]:bg-surface-active"
        : "flex h-10 w-full items-center gap-2 rounded-t-[24px] border-b border-border-subtle bg-surface/55 px-4 text-[13px] text-muted transition-colors hover:text-fg";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("projectSwitcher.switchProject")}
          disabled={!editable}
          className={cn(triggerClass, "disabled:opacity-70")}
        >
          {TriggerIcon ? (
            <TriggerIcon size={variant === "title" ? 17 : 16} className="text-info shrink-0" />
          ) : null}
          <span
            className={cn(
              "min-w-0 truncate",
              (variant === "title" || variant === "sidebar") && "text-left",
            )}
          >
            {currentLabel}
          </span>
          {variant === "title" || variant === "sidebar" ? (
            <ChevronDown size={16} className="text-subtle shrink-0" strokeWidth={2} />
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={variant === "composer" ? "top" : "bottom"}
        align="start"
        className="w-72"
      >
        <DropdownMenuLabel>{t("projectSwitcher.project")}</DropdownMenuLabel>
        {projectOptions.map((option) => (
          <DropdownMenuItem
            key={option.key}
            title={option.title}
            onSelect={() => updateProject(option.projectPath)}
            className="group pr-1"
          >
            <Folder size={14} />
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {variant === "sidebar" ? (
              <button
                type="button"
                data-icon-button="true"
                title={t("projectSwitcher.removeProject")}
                aria-label={t("projectSwitcher.removeProject")}
                onClick={(event) => removeProject(event, option)}
                className="text-subtle hover:bg-surface-hover hover:text-danger ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md opacity-0 transition-[background-color,color,opacity] group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
              >
                <X size={13} />
              </button>
            ) : null}
          </DropdownMenuItem>
        ))}
        {projectOptions.length > 0 ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem onSelect={() => void chooseProject()}>
          <FolderOpen size={14} />
          <span>{chooseLabel}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function projectName(projectPath: string): string {
  return (
    projectPath
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || projectPath
  );
}

function projectOptionsFromNavItems(
  items: SidebarProjectNavItem[],
  workspacePath: string,
  currentProjectPath: string | null,
): ProjectOption[] {
  const options = new Map<string, ProjectOption>();
  const add = (projectPath: string | null | undefined, label?: string, title?: string) => {
    const normalized = normalizeProjectPath(projectPath ?? "");
    if (!normalized) return;
    const key = projectKeyForPath(normalized);
    const existing = options.get(key);
    if (existing) {
      return;
    }
    options.set(key, {
      key,
      label: label || projectName(normalized),
      projectPath: normalized,
      title: title || normalized,
    });
  };

  for (const item of items) {
    add(item.projectPath, item.label, item.title);
  }
  add(workspacePath);
  add(currentProjectPath);
  return [...options.values()];
}

function projectKeyForPath(projectPath: string | null): string {
  return projectPath ? `project:${projectPath}` : "private";
}

function normalizeProjectPath(value: string): string {
  return value.trim().replace(/[\\/]+$/, "");
}
