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
            "flex h-12 w-full rounded-[10px] border bg-background px-4 text-[15px] text-foreground transition-colors duration-200",
            "placeholder:text-muted-foreground",
            "focus:outline-none focus:border-ember focus:ring-2 focus:ring-ember/30",
            "disabled:cursor-not-allowed disabled:opacity-50",
            error
              ? "border-destructive focus:border-destructive focus:ring-destructive/30"
              : "border-border hover:border-muted-foreground/40",
            className,
          )}
          ref={ref}
          {...props}
        />
        {error && (
          <p className="mt-2 text-[13px] leading-5 text-danger">{error}</p>
        )}
      </div>
    );
  },
);

Input.displayName = "Input";

export { Input };
