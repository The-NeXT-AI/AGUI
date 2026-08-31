import { Menu } from "@base-ui/react/menu";
import { Check, ChevronRight, Circle } from "lucide-react";
import {
  isValidElement,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type ReactElement,
  type ReactNode,
  forwardRef,
} from "react";
import { cn } from "./cn";

const DropdownMenu = Menu.Root;
const DropdownMenuGroup = Menu.Group;
const DropdownMenuPortal = Menu.Portal;
const DropdownMenuSub = Menu.SubmenuRoot;
const DropdownMenuRadioGroup = Menu.RadioGroup;

type TriggerProps = Omit<ComponentPropsWithoutRef<typeof Menu.Trigger>, "render"> & {
  asChild?: boolean;
};

const DropdownMenuTrigger = forwardRef<HTMLButtonElement, TriggerProps>(
  ({ asChild, children, ...props }, ref) => (
    <Menu.Trigger ref={ref} render={asChild ? renderChild(children) : undefined} {...props}>
      {asChild ? childContent(children) : children}
    </Menu.Trigger>
  ),
);
DropdownMenuTrigger.displayName = "DropdownMenuTrigger";

const DropdownMenuSubTrigger = forwardRef<
  ElementRef<typeof Menu.SubmenuTrigger>,
  ComponentPropsWithoutRef<typeof Menu.SubmenuTrigger> & {
    inset?: boolean;
  }
>(({ className, inset, children, ...props }, ref) => (
  <Menu.SubmenuTrigger
    ref={ref}
    className={(state) =>
      cn(
        "flex cursor-default items-center rounded-md px-2 py-1.5 text-[13px] outline-none select-none",
        state.highlighted && "bg-surface-active text-fg",
        state.open && "bg-surface-active",
        state.disabled && "pointer-events-none opacity-45",
        inset && "pl-8",
        className,
      )
    }
    {...props}
  >
    {children}
    <ChevronRight className="ml-auto h-4 w-4" />
  </Menu.SubmenuTrigger>
));
DropdownMenuSubTrigger.displayName = "DropdownMenuSubTrigger";

const DropdownMenuSubContent = forwardRef<
  ElementRef<typeof Menu.Popup>,
  ComponentPropsWithoutRef<typeof Menu.Popup> &
    Pick<ComponentPropsWithoutRef<typeof Menu.Positioner>, "side" | "align" | "sideOffset">
>(({ className, side = "right", align = "start", sideOffset = 6, ...props }, ref) => (
  <Menu.Portal>
    <Menu.Positioner side={side} align={align} sideOffset={sideOffset} className="z-[80]">
      <Menu.Popup
        ref={ref}
        className={cn(
          "ui-popover-surface text-fg z-[80] max-h-[min(22rem,calc(100vh-2rem))] min-w-32 origin-[var(--transform-origin)] overflow-y-auto rounded-lg p-1 transition-[opacity,transform] duration-100 outline-none data-[closed]:hidden data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
          className,
        )}
        {...props}
      />
    </Menu.Positioner>
  </Menu.Portal>
));
DropdownMenuSubContent.displayName = "DropdownMenuSubContent";

const DropdownMenuContent = forwardRef<
  ElementRef<typeof Menu.Popup>,
  ComponentPropsWithoutRef<typeof Menu.Popup> &
    Pick<ComponentPropsWithoutRef<typeof Menu.Positioner>, "side" | "align" | "sideOffset">
>(({ className, side = "bottom", align = "start", sideOffset = 6, ...props }, ref) => (
  <Menu.Portal>
    <Menu.Positioner side={side} align={align} sideOffset={sideOffset} className="z-[80]">
      <Menu.Popup
        ref={ref}
        className={cn(
          "ui-popover-surface text-fg z-[80] max-h-[min(22rem,calc(100vh-2rem))] min-w-44 origin-[var(--transform-origin)] overflow-y-auto rounded-lg p-1 transition-[opacity,transform] duration-100 outline-none data-[closed]:hidden data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
          className,
        )}
        {...props}
      />
    </Menu.Positioner>
  </Menu.Portal>
));
DropdownMenuContent.displayName = "DropdownMenuContent";

type DropdownMenuItemProps = Omit<ComponentPropsWithoutRef<typeof Menu.Item>, "onSelect"> & {
  inset?: boolean;
  onSelect?: (event: React.MouseEvent<HTMLElement>) => void;
};

const DropdownMenuItem = forwardRef<ElementRef<typeof Menu.Item>, DropdownMenuItemProps>(
  ({ className, inset, onClick, onSelect, ...props }, ref) => (
    <Menu.Item
      ref={ref}
      className={(state) =>
        cn(
          "relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors outline-none select-none",
          state.highlighted && "bg-surface-active text-fg",
          state.disabled && "pointer-events-none opacity-45",
          inset && "pl-8",
          className,
        )
      }
      onClick={(event) => {
        onSelect?.(event);
        onClick?.(event);
      }}
      {...props}
    />
  ),
);
DropdownMenuItem.displayName = "DropdownMenuItem";

const DropdownMenuCheckboxItem = forwardRef<
  ElementRef<typeof Menu.CheckboxItem>,
  ComponentPropsWithoutRef<typeof Menu.CheckboxItem>
>(({ className, children, checked, ...props }, ref) => (
  <Menu.CheckboxItem
    ref={ref}
    className={(state) =>
      cn(
        "relative flex cursor-default items-center rounded-md py-1.5 pr-2 pl-8 text-[13px] transition-colors outline-none select-none",
        state.highlighted && "bg-surface-active text-fg",
        state.disabled && "pointer-events-none opacity-45",
        className,
      )
    }
    checked={checked}
    {...props}
  >
    <Menu.CheckboxItemIndicator className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <Check className="h-3.5 w-3.5" />
    </Menu.CheckboxItemIndicator>
    {children}
  </Menu.CheckboxItem>
));
DropdownMenuCheckboxItem.displayName = "DropdownMenuCheckboxItem";

const DropdownMenuRadioItem = forwardRef<
  ElementRef<typeof Menu.RadioItem>,
  ComponentPropsWithoutRef<typeof Menu.RadioItem>
>(({ className, children, closeOnClick = true, ...props }, ref) => (
  <Menu.RadioItem
    ref={ref}
    className={(state) =>
      cn(
        "relative flex cursor-default items-center rounded-md py-1.5 pr-2 pl-8 text-[13px] transition-colors outline-none select-none",
        state.highlighted && "bg-surface-active text-fg",
        state.disabled && "pointer-events-none opacity-45",
        className,
      )
    }
    closeOnClick={closeOnClick}
    {...props}
  >
    <Menu.RadioItemIndicator className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <Circle className="h-2 w-2 fill-current" />
    </Menu.RadioItemIndicator>
    {children}
  </Menu.RadioItem>
));
DropdownMenuRadioItem.displayName = "DropdownMenuRadioItem";

const DropdownMenuLabel = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<"div"> & {
    inset?: boolean;
  }
>(({ className, inset, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "text-subtle px-2 py-1.5 text-[11px] font-medium tracking-wide uppercase",
      inset && "pl-8",
      className,
    )}
    {...props}
  />
));
DropdownMenuLabel.displayName = "DropdownMenuLabel";

const DropdownMenuSeparator = forwardRef<
  ElementRef<typeof Menu.Separator>,
  ComponentPropsWithoutRef<typeof Menu.Separator>
>(({ className, ...props }, ref) => (
  <Menu.Separator ref={ref} className={cn("bg-border -mx-1 my-1 h-px", className)} {...props} />
));
DropdownMenuSeparator.displayName = "DropdownMenuSeparator";

const DropdownMenuShortcut = ({ className, ...props }: ComponentPropsWithoutRef<"span">) => {
  return (
    <span className={cn("text-subtle ml-auto text-[11px] tracking-widest", className)} {...props} />
  );
};
DropdownMenuShortcut.displayName = "DropdownMenuShortcut";

function renderChild(children: ReactNode): ReactElement | undefined {
  return isValidElement(children) ? children : undefined;
}

function childContent(children: ReactNode): ReactNode {
  return isValidElement<{ children?: ReactNode }>(children) ? children.props.children : children;
}

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
};
