import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import {
  isValidElement,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type ReactElement,
  type ReactNode,
  forwardRef,
} from "react";
import { cn } from "./cn";
import { useT } from "@/lib/i18n";

const Dialog = DialogPrimitive.Root;
const DialogPortal = DialogPrimitive.Portal;

type DialogTriggerProps = Omit<
  ComponentPropsWithoutRef<typeof DialogPrimitive.Trigger>,
  "render"
> & {
  asChild?: boolean;
};

const DialogTrigger = forwardRef<HTMLButtonElement, DialogTriggerProps>(
  ({ asChild, children, ...props }, ref) => (
    <DialogPrimitive.Trigger
      ref={ref}
      render={asChild ? renderChild(children) : undefined}
      {...props}
    >
      {asChild ? childContent(children) : children}
    </DialogPrimitive.Trigger>
  ),
);
DialogTrigger.displayName = "DialogTrigger";

const DialogClose = DialogPrimitive.Close;

const DialogOverlay = forwardRef<
  ElementRef<typeof DialogPrimitive.Backdrop>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Backdrop>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Backdrop
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] transition-opacity duration-150 data-[closed]:hidden data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = "DialogOverlay";

const DialogContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Popup>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Popup> & {
    showClose?: boolean;
  }
>(({ className, children, showClose = true, ...props }, ref) => {
  const t = useT();
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Viewport className="fixed inset-0 z-50 grid place-items-center p-4">
        <DialogPrimitive.Popup
          ref={ref}
          className={cn(
            "ui-popover-surface text-fg relative w-full max-w-md rounded-xl p-5 transition-[opacity,transform] duration-150 outline-none data-[closed]:hidden data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
            className,
          )}
          {...props}
        >
          {children}
          {showClose ? (
            <DialogPrimitive.Close className="ui-icon-button absolute top-3 right-3 h-7 w-7 rounded-md">
              <X size={16} />
              <span className="sr-only">{t("common.close")}</span>
            </DialogPrimitive.Close>
          ) : null}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Viewport>
    </DialogPortal>
  );
});
DialogContent.displayName = "DialogContent";

const DialogHeader = ({ className, ...props }: ComponentPropsWithoutRef<"div">) => (
  <div className={cn("space-y-1.5 pr-7", className)} {...props} />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({ className, ...props }: ComponentPropsWithoutRef<"div">) => (
  <div className={cn("mt-5 flex justify-end gap-2", className)} {...props} />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = forwardRef<
  ElementRef<typeof DialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-fg text-[15px] font-semibold", className)}
    {...props}
  />
));
DialogTitle.displayName = "DialogTitle";

const DialogDescription = forwardRef<
  ElementRef<typeof DialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-muted text-[13px] leading-5", className)}
    {...props}
  />
));
DialogDescription.displayName = "DialogDescription";

function renderChild(children: ReactNode): ReactElement | undefined {
  return isValidElement(children) ? children : undefined;
}

function childContent(children: ReactNode): ReactNode {
  return isValidElement<{ children?: ReactNode }>(children) ? children.props.children : children;
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
