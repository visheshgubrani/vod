"use client";

import * as React from "react";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  busyLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  /** Shown inside the dialog when the action failed. */
  error?: string | null;
  tone?: "danger" | "default";
  onConfirm: () => void;
  onCancel: () => void;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/**
 * The confirmation used before anything destructive.
 *
 * A dialog that only closes by clicking the right pixel is a trap: this one
 * closes on Escape and on the backdrop, moves focus to the safe action when it
 * opens, keeps Tab inside it, and hands focus back to whatever opened it.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  busyLabel,
  cancelLabel = "Cancel",
  busy = false,
  error,
  tone = "danger",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const restoreFocusRef = React.useRef<HTMLElement | null>(null);
  const titleId = React.useId();

  React.useEffect(() => {
    if (!open) return;

    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    // Focus the safe action, never the destructive one.
    cancelRef.current?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        if (!busy) onCancel();
        return;
      }

      if (event.key !== "Tab") return;

      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus?.();
    };
  }, [open, busy, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60"
        aria-hidden="true"
        onClick={() => {
          if (!busy) onCancel();
        }}
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative w-full max-w-md rounded-2xl border border-border bg-panel p-6"
      >
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-xl border",
              tone === "danger"
                ? "border-failed/35 bg-failed/10"
                : "border-border bg-panel-strong",
            )}
          >
            <AlertTriangle
              className={cn(
                "size-5",
                tone === "danger" ? "text-danger" : "text-muted-foreground",
              )}
              aria-hidden="true"
            />
          </span>
          <h2 id={titleId} className="text-lg font-semibold text-foreground">
            {title}
          </h2>
        </div>

        <div className="dash-body mt-4 text-muted-foreground">{description}</div>

        {error ? (
          <p
            role="alert"
            className="mt-4 rounded-xl border border-failed/35 bg-failed/10 px-3.5 py-2.5 text-sm text-danger"
          >
            {error}
          </p>
        ) : null}

        <div className="mt-6 flex flex-col gap-2 sm:flex-row">
          <Button
            ref={cancelRef}
            variant="outline"
            onClick={onCancel}
            disabled={busy}
            className="flex-1"
          >
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "danger" ? "destructive" : "primary"}
            onClick={onConfirm}
            disabled={busy}
            className="flex-1"
          >
            {busy ? (busyLabel ?? "Working…") : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
