import * as React from "react";
import { cn } from "@/lib/utils";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
    error?: string;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
    ({ className, type, error, ...props }, ref) => {
        return (
            <div className="w-full">
                <input
                    type={type}
                    className={cn(
                        "flex h-12 w-full rounded-xl border bg-muted/30 px-4 py-3 text-base transition-all duration-200",
                        "placeholder:text-muted-foreground/50",
                        "focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary",
                        "disabled:cursor-not-allowed disabled:opacity-50",
                        error
                            ? "border-destructive focus:ring-destructive/50 focus:border-destructive"
                            : "border-border hover:border-muted-foreground/30",
                        className
                    )}
                    ref={ref}
                    {...props}
                />
                {error && (
                    <p className="mt-1.5 text-sm text-destructive">{error}</p>
                )}
            </div>
        );
    }
);

Input.displayName = "Input";

export { Input };
