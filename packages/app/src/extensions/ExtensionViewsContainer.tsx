import { useMemo, useState, type MouseEvent } from "react";
import { ChevronDown, MoreHorizontal } from "lucide-react";
import { useRegistryStore } from "@agui/app";
import type {
  ExtensionMenuContribution,
  ExtensionMenusContribution,
  ExtensionViewContribution,
  ExtensionViewsContainerContribution,
} from "@/asp/desktop-api";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { cn } from "@/ui/cn";
import { useT } from "@/lib/i18n";
import { ExtensionView } from "./ExtensionView";
import { evaluateWhen, type ExtensionContextValues } from "./when";
import { resolveOptionalExtensionIcon } from "./extension-icons";

export function ExtensionViewsContainer({
  extensionId,
  container,
  views,
  menus,
  context,
  data,
  surface,
  allowNetwork,
}: {
  extensionId: string;
  container: ExtensionViewsContainerContribution;
  views: ExtensionViewContribution[];
  menus?: ExtensionMenusContribution;
  context: ExtensionContextValues;
  data?: unknown;
  surface: "sidebar" | "detail-panel";
  allowNetwork: boolean;
}) {
  const t = useT();
  const visibleViews = useMemo(
    () =>
      views
        .filter((view) => view.visibility !== "hidden")
        .filter((view) => evaluateWhen(view.when, context))
        .sort(
          (a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER),
        ),
    [context, views],
  );

  if (visibleViews.length === 0) {
    return (
      <div className="text-subtle flex h-full items-center justify-center p-4 text-center text-[12px]">
        {t("extension.noViews", { title: container.title })}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {visibleViews.map((view) => (
        <ExtensionViewSection
          key={view.id}
          extensionId={extensionId}
          view={view}
          menus={menus}
          context={context}
          data={data}
          surface={surface}
          allowNetwork={allowNetwork}
        />
      ))}
    </div>
  );
}

function ExtensionViewSection({
  extensionId,
  view,
  menus,
  context,
  data,
  surface,
  allowNetwork,
}: {
  extensionId: string;
  view: ExtensionViewContribution;
  menus?: ExtensionMenusContribution;
  context: ExtensionContextValues;
  data?: unknown;
  surface: "sidebar" | "detail-panel";
  allowNetwork: boolean;
}) {
  const [collapsed, setCollapsed] = useState(view.visibility === "collapsed");
  const viewContext = useMemo(() => ({ ...context, view: view.id }), [context, view.id]);
  const titleActions = useMemo(
    () => viewTitleActions(extensionId, menus, viewContext),
    [extensionId, menus, viewContext],
  );
  const ViewIcon = resolveOptionalExtensionIcon(extensionId, view.icon);
  const displayTitle = view.contextualTitle || view.name;
  const viewData = useMemo(
    () => ({
      ...objectData(data),
      view: { id: view.id, name: view.name, contextualTitle: view.contextualTitle ?? "" },
    }),
    [data, view.contextualTitle, view.id, view.name],
  );

  return (
    <section
      data-extension-view-section={view.id}
      className="border-border-subtle flex min-h-0 flex-col border-b last:border-b-0"
    >
      <header className="flex h-9 shrink-0 items-center gap-1 px-2">
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          className="text-muted hover:bg-surface-hover hover:text-fg flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[12px] font-semibold tracking-wide uppercase transition-colors"
          aria-expanded={!collapsed}
          aria-label={displayTitle}
          title={displayTitle}
        >
          <ChevronDown
            size={13}
            className={cn("shrink-0 transition-transform", collapsed && "-rotate-90")}
          />
          {ViewIcon ? <ViewIcon size={13} className="text-subtle shrink-0" /> : null}
          <span className="truncate">{view.name}</span>
        </button>
        <ExtensionViewTitleActions extensionId={extensionId} actions={titleActions} />
      </header>
      {collapsed ? null : (
        <div className="min-h-0 flex-1 overflow-hidden px-2 pb-2">
          <ExtensionView
            extensionId={extensionId}
            contribution={{
              ...view,
              viewType: view.viewType ?? "web-component",
              activationEvent: `onView:${view.id}`,
            }}
            data={viewData}
            surface={surface}
            allowNetwork={allowNetwork}
          />
        </div>
      )}
    </section>
  );
}

function ExtensionViewTitleActions({
  extensionId,
  actions,
}: {
  extensionId: string;
  actions: ExtensionMenuContribution[];
}) {
  const t = useT();
  const commands = useRegistryStore((state) => state.commands);
  const primary = actions.filter((action) => action.group === "navigation");
  const secondary = actions.filter((action) => action.group !== "navigation");
  const secondaryGroups = useMemo(() => groupedMenuActions(secondary), [secondary]);

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {primary.map((action) => {
        const resolved = resolveMenuCommand(extensionId, commands, action);
        const command = resolved.command ?? resolved.altCommand;
        if (!command) return null;
        const Icon = command.icon;
        const altTitle = resolved.altCommand?.title;
        return (
          <button
            key={`${action.command ?? ""}:${action.alt ?? ""}`}
            type="button"
            data-icon-button="true"
            title={altTitle ? `${command.title} / ${altTitle}` : command.title}
            aria-label={command.title}
            onClick={(event) => void menuCommandForEvent(resolved, event).handler()}
            className="text-muted hover:bg-surface-hover hover:text-fg flex h-7 w-7 items-center justify-center rounded-md transition-colors"
          >
            {Icon ? (
              <Icon size={14} />
            ) : (
              <span className="text-[11px]">{command.title.slice(0, 1)}</span>
            )}
          </button>
        );
      })}
      {secondary.length ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            title={t("common.moreActions")}
            aria-label={t("common.moreActions")}
            className="text-muted hover:bg-surface-hover hover:text-fg data-[state=open]:bg-surface-active data-[state=open]:text-fg flex h-7 w-7 items-center justify-center rounded-md transition-colors"
          >
            <MoreHorizontal size={14} />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="bottom" align="end" className="w-48">
            {secondaryGroups.items.map((action) => (
              <ExtensionMenuActionItem
                key={`${extensionId}:${action.command ?? ""}:${action.alt ?? ""}`}
                action={action}
                commands={commands}
                extensionId={extensionId}
              />
            ))}
            {secondaryGroups.submenus.map(([submenu, items]) => (
              <DropdownMenuSub key={`${extensionId}:submenu:${submenu}`}>
                <DropdownMenuSubTrigger>{menuSubmenuLabel(submenu)}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {items.map((action) => (
                    <ExtensionMenuActionItem
                      key={`${extensionId}:${submenu}:${action.command ?? ""}:${action.alt ?? ""}`}
                      action={action}
                      commands={commands}
                      extensionId={extensionId}
                    />
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

function ExtensionMenuActionItem({
  action,
  commands,
  extensionId,
}: {
  action: ExtensionMenuContribution;
  commands: ReturnType<typeof useRegistryStore.getState>["commands"];
  extensionId: string;
}) {
  const resolved = resolveMenuCommand(extensionId, commands, action);
  const command = resolved.command ?? resolved.altCommand;
  if (!command) return null;
  const Icon = command.icon;
  return (
    <DropdownMenuItem onSelect={(event) => void menuCommandForEvent(resolved, event).handler()}>
      {Icon ? <Icon size={14} className="text-subtle shrink-0" /> : null}
      <span className="truncate">{command.title}</span>
      {resolved.altCommand ? <DropdownMenuShortcut>Alt</DropdownMenuShortcut> : null}
    </DropdownMenuItem>
  );
}

function viewTitleActions(
  extensionId: string,
  menus: ExtensionMenusContribution | undefined,
  context: ExtensionContextValues,
): ExtensionMenuContribution[] {
  return (menus?.["view/title"] ?? [])
    .filter(
      (item) =>
        isExtensionCommand(extensionId, item.command) || isExtensionCommand(extensionId, item.alt),
    )
    .filter((item) => evaluateWhen(item.when, context))
    .sort(compareMenuItems);
}

function isExtensionCommand(extensionId: string, command: string | undefined): command is string {
  return Boolean(
    command && (command.startsWith(`${extensionId}.`) || command.startsWith(`${extensionId}/`)),
  );
}

function compareMenuItems(a: ExtensionMenuContribution, b: ExtensionMenuContribution): number {
  return menuGroupRank(a.group) - menuGroupRank(b.group);
}

function menuGroupRank(group: string | undefined): number {
  if (group === "navigation") return 0;
  const match = group?.match(/@(-?\d+)/);
  return match ? Number(match[1]) : 1000;
}

function resolveMenuCommand(
  extensionId: string,
  commands: ReturnType<typeof useRegistryStore.getState>["commands"],
  action: ExtensionMenuContribution,
) {
  const command =
    isExtensionCommand(extensionId, action.command) && action.command
      ? commands[action.command]
      : undefined;
  const altCommand =
    isExtensionCommand(extensionId, action.alt) && action.alt ? commands[action.alt] : undefined;
  return { command, altCommand };
}

function menuCommandForEvent(
  resolved: ReturnType<typeof resolveMenuCommand>,
  event: MouseEvent<HTMLElement>,
) {
  return (
    (event.altKey ? resolved.altCommand : undefined) ?? resolved.command ?? resolved.altCommand!
  );
}

function groupedMenuActions(actions: ExtensionMenuContribution[]): {
  items: ExtensionMenuContribution[];
  submenus: Array<[string, ExtensionMenuContribution[]]>;
} {
  const items: ExtensionMenuContribution[] = [];
  const submenuMap = new Map<string, ExtensionMenuContribution[]>();
  for (const action of actions) {
    const submenu = action.submenu?.trim();
    if (!submenu) {
      items.push(action);
      continue;
    }
    submenuMap.set(submenu, [...(submenuMap.get(submenu) ?? []), action]);
  }
  return { items, submenus: [...submenuMap.entries()] };
}

function menuSubmenuLabel(submenu: string): string {
  return submenu.split(/[./]/).filter(Boolean).at(-1) || submenu;
}

function objectData(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
