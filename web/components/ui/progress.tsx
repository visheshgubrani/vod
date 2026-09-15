import * as React from "react";
import { cn } from "@/lib/utils";

export interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value: number;
  max?: number;
  showLabel?: boolean;
  variant?: "default" | "success" | "warning" | "danger";
}

/* Flat fills, no gradients — status is carried by hue, and the value is always
 * repeated as text next to the bar rather than encoded in the width alone. */
const variantClasses = {
  default: "bg-ember",
  success: "bg-ready",
  warning: "bg-processing",
  danger: "bg-failed",
};

export function Progress({
  value,
  max = 100,
  showLabel,
  variant = "default",
  className,
  ...props
}: ProgressProps) {
  const percentage = Math.min(Math.max((value / max) * 100, 0), 100);

  return (
    <div className={cn("w-full", className)} {...props}>
      <div
        role="progressbar"
        aria-valuenow={Math.round(percentage)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="relative h-2 w-full overflow-hidden rounded-full bg-panel-strong"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-300 ease-out",
            variantClasses[variant],
          )}
          style={{ width: `${percentage}%` }}
        />
      </div>
      {showLabel && (
        <p className="mt-2 font-mono text-[13px] text-muted-foreground">
          {Math.round(percentage)}%
        </p>
      )}
    </div>
  );
}
