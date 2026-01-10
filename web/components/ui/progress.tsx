import * as React from "react";
import { cn } from "@/lib/utils";

export interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
    value: number;
    max?: number;
    showLabel?: boolean;
    variant?: "default" | "success" | "warning" | "danger";
}

const variantClasses = {
    default: "from-primary to-accent",
    success: "from-emerald-500 to-green-400",
    warning: "from-amber-500 to-yellow-400",
    danger: "from-red-500 to-rose-400",
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
            <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted/50">
                <div
                    className={cn(
                        "h-full rounded-full bg-gradient-to-r transition-all duration-500 ease-out",
                        variantClasses[variant]
                    )}
                    style={{ width: `${percentage}%` }}
                />
            </div>
            {showLabel && (
                <p className="mt-1 text-xs text-muted-foreground">{Math.round(percentage)}%</p>
            )}
        </div>
    );
}
