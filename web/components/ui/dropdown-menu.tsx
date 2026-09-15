"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface DropdownMenuProps {
  children: React.ReactNode;
}

interface DropdownMenuTriggerProps {
  children: React.ReactNode;
  asChild?: boolean;
}

interface DropdownMenuContentProps {
  children: React.ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom";
  className?: string;
  /** Accessible name for the menu. */
  label?: string;
}

interface DropdownMenuItemProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
  destructive?: boolean;
}

interface DropdownMenuSeparatorProps {
  className?: string;
}

interface DropdownMenuLabelProps {
  children: React.ReactNode;
  className?: string;
}

const DropdownMenuContext = React.createContext<{
  open: boolean;
  setOpen: (open: boolean) => void;
  contentId: string;
  registerTrigger: (node: HTMLButtonElement | null) => void;
}>({
  open: false,
  setOpen: () => {},
  contentId: "",
  registerTrigger: () => {},
});

const FOCUSABLE_ITEM = '[role="menuitem"]:not([disabled])';

export function DropdownMenu({ children }: DropdownMenuProps) {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const contentId = React.useId();

  // Menu semantics: Escape closes and returns focus to the trigger, and a click
  // anywhere else dismisses without stealing focus.
  React.useEffect(() => {
    if (!open) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  const registerTrigger = React.useCallback(
    (node: HTMLButtonElement | null) => {
      triggerRef.current = node;
    },
    [],
  );

  return (
    <DropdownMenuContext.Provider
      value={{ open, setOpen, contentId, registerTrigger }}
    >
      <div ref={containerRef} className="relative inline-block">
        {children}
      </div>
    </DropdownMenuContext.Provider>
  );
}

export function DropdownMenuTrigger({
  children,
  asChild,
}: DropdownMenuTriggerProps) {
  const { open, setOpen, contentId, registerTrigger } =
    React.useContext(DropdownMenuContext);

  const handleClick = () => {
    setOpen(!open);
  };

  const menuProps = {
    "aria-haspopup": "menu" as const,
    "aria-expanded": open,
    "aria-controls": open ? contentId : undefined,
  };

  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(
      children as React.ReactElement<Record<string, unknown>>,
      {
        onClick: handleClick,
        ref: registerTrigger,
        ...menuProps,
      },
    );
  }

  return (
    <button ref={registerTrigger} type="button" onClick={handleClick} {...menuProps}>
      {children}
    </button>
  );
}

export function DropdownMenuContent({
  children,
  align = "end",
  side = "bottom",
  className,
  label,
}: DropdownMenuContentProps) {
  const { open, setOpen, contentId } = React.useContext(DropdownMenuContext);
  const contentRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    contentRef.current?.querySelector<HTMLElement>(FOCUSABLE_ITEM)?.focus();
  }, [open]);

  if (!open) return null;

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key)) return;

    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(FOCUSABLE_ITEM),
    );
    if (items.length === 0) return;

    event.preventDefault();
    const currentIndex = items.findIndex(
      (item) => item === document.activeElement,
    );
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (currentIndex + 1 + items.length) % items.length
            : (currentIndex - 1 + items.length) % items.length;

    items[nextIndex]?.focus();
  };

  return (
    <div
      ref={contentRef}
      id={contentId}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn(
        "absolute z-50 min-w-[190px] overflow-hidden rounded-xl border border-border bg-popover p-1.5 shadow-xl",
        "animate-in fade-in-0 zoom-in-95",
        side === "bottom" && "mt-2 slide-in-from-top-2 top-full",
        side === "top" && "bottom-full mb-2 slide-in-from-bottom-2",
        align === "start" && "left-0",
        align === "center" && "left-1/2 -translate-x-1/2",
        align === "end" && "right-0",
        className,
      )}
      onClick={() => setOpen(false)}
    >
      {children}
    </div>
  );
}

export function DropdownMenuItem({
  children,
  className,
  destructive,
  ...props
}: DropdownMenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm transition-colors",
        "hover:bg-panel-strong focus:bg-panel-strong focus:outline-none",
        destructive
          ? "text-danger hover:bg-failed/10 focus:bg-failed/10"
          : "text-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function DropdownMenuSeparator({
  className,
}: DropdownMenuSeparatorProps) {
  return (
    <div role="separator" className={cn("my-1 h-px bg-border-soft", className)} />
  );
}

export function DropdownMenuLabel({
  children,
  className,
}: DropdownMenuLabelProps) {
  return (
    <div
      className={cn(
        "px-3 py-1.5 text-[13px] font-medium text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}
