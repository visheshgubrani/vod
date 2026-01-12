"use client";

import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

interface SheetProps {
    open: boolean;
    onClose: () => void;
    children: React.ReactNode;
    side?: "left" | "right";
    className?: string;
}

interface SheetHeaderProps {
    children: React.ReactNode;
    className?: string;
}

interface SheetTitleProps {
    children: React.ReactNode;
    className?: string;
}

export function Sheet({ open, onClose, children, side = "right", className }: SheetProps) {
    React.useEffect(() => {
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };

        if (open) {
            document.addEventListener("keydown", handleEscape);
            document.body.style.overflow = "hidden";
        }

        return () => {
            document.removeEventListener("keydown", handleEscape);
            document.body.style.overflow = "";
        };
    }, [open, onClose]);

    if (!open) return null;

    return (
        <div className="fixed inset-0 z-50">
            {/* Backdrop */}
            <div
                className="fixed inset-0 bg-background/80 backdrop-blur-sm animate-in fade-in-0"
                onClick={onClose}
            />

            {/* Sheet */}
            <div
                className={cn(
                    "fixed top-0 bottom-0 w-full max-w-md border-border bg-card/95 backdrop-blur-xl shadow-2xl",
                    "flex flex-col",
                    side === "right"
                        ? "right-0 border-l animate-in slide-in-from-right"
                        : "left-0 border-r animate-in slide-in-from-left",
                    className
                )}
            >
                {/* Close Button */}
                <button
                    onClick={onClose}
                    className="absolute right-4 top-4 p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                    aria-label="Close"
                >
                    <X className="w-5 h-5" />
                </button>

                {children}
            </div>
        </div>
    );
}

export function SheetHeader({ children, className }: SheetHeaderProps) {
    return (
        <div className={cn("px-6 pt-6 pb-4 border-b border-border", className)}>
            {children}
        </div>
    );
}

export function SheetTitle({ children, className }: SheetTitleProps) {
    return (
        <h2 className={cn("text-lg font-semibold text-foreground", className)}>
            {children}
        </h2>
    );
}

export function SheetContent({ children, className }: { children: React.ReactNode; className?: string }) {
    return (
        <div className={cn("flex-1 overflow-auto p-6", className)}>
            {children}
        </div>
    );
}
