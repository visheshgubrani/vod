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
    className?: string;
}

interface DropdownMenuItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
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
}>({
    open: false,
    setOpen: () => {},
});

export function DropdownMenu({ children }: DropdownMenuProps) {
    const [open, setOpen] = React.useState(false);
    const containerRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setOpen(false);
            }
        };

        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setOpen(false);
            }
        };

        if (open) {
            document.addEventListener("mousedown", handleClickOutside);
            document.addEventListener("keydown", handleEscape);
        }

        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
            document.removeEventListener("keydown", handleEscape);
        };
    }, [open]);

    return (
        <DropdownMenuContext.Provider value={{ open, setOpen }}>
            <div ref={containerRef} className="relative inline-block">
                {children}
            </div>
        </DropdownMenuContext.Provider>
    );
}

export function DropdownMenuTrigger({ children, asChild }: DropdownMenuTriggerProps) {
    const { open, setOpen } = React.useContext(DropdownMenuContext);

    const handleClick = () => {
        setOpen(!open);
    };

    if (asChild && React.isValidElement(children)) {
        return React.cloneElement(children as React.ReactElement<{ onClick?: () => void }>, {
            onClick: handleClick,
        });
    }

    return (
        <button onClick={handleClick} type="button">
            {children}
        </button>
    );
}

export function DropdownMenuContent({ children, align = "end", className }: DropdownMenuContentProps) {
    const { open, setOpen } = React.useContext(DropdownMenuContext);

    if (!open) return null;

    return (
        <div
            className={cn(
                "absolute z-50 mt-2 min-w-[180px] overflow-hidden rounded-xl border border-border bg-card/95 backdrop-blur-xl p-1.5 shadow-xl",
                "animate-in fade-in-0 zoom-in-95 slide-in-from-top-2",
                align === "start" && "left-0",
                align === "center" && "left-1/2 -translate-x-1/2",
                align === "end" && "right-0",
                className
            )}
            onClick={() => setOpen(false)}
        >
            {children}
        </div>
    );
}

export function DropdownMenuItem({ children, className, destructive, ...props }: DropdownMenuItemProps) {
    return (
        <button
            className={cn(
                "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors",
                "hover:bg-muted/60 focus:bg-muted/60 focus:outline-none",
                destructive
                    ? "text-red-400 hover:text-red-300 hover:bg-red-500/10"
                    : "text-foreground",
                className
            )}
            {...props}
        >
            {children}
        </button>
    );
}

export function DropdownMenuSeparator({ className }: DropdownMenuSeparatorProps) {
    return <div className={cn("my-1 h-px bg-border", className)} />;
}

export function DropdownMenuLabel({ children, className }: DropdownMenuLabelProps) {
    return (
        <div className={cn("px-3 py-1.5 text-xs font-medium text-muted-foreground", className)}>
            {children}
        </div>
    );
}
