import * as React from "react";
import { cn } from "@/lib/utils";

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "outline" | "destructive";
  size?: "sm" | "md" | "lg";
  asChild?: boolean;
}

/*
 * Every size clears the 44px minimum touch target, including `sm` — a compact
 * button is narrower, not shorter.
 */
const sizeStyles = {
  sm: "h-11 gap-1.5 px-4 text-sm",
  md: "h-11 gap-2 px-5 text-[15px]",
  lg: "h-12 gap-2 px-6 text-base",
} as const;

const variantStyles = {
  primary:
    "bg-brand text-brand-foreground hover:bg-brand-hover active:bg-brand-hover",
  secondary:
    "border border-border bg-panel-strong text-foreground hover:border-muted-foreground/40",
  ghost: "text-foreground hover:bg-panel-strong",
  outline:
    "border border-border bg-transparent text-foreground hover:border-muted-foreground/40 hover:bg-panel-strong/60",
  destructive:
    "bg-destructive text-destructive-foreground hover:bg-destructive/90",
} as const;

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "md", children, ...props }, ref) => {
    return (
      <button
        className={cn(
          "inline-flex items-center justify-center rounded-[10px] font-semibold whitespace-nowrap transition-colors duration-200",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "disabled:pointer-events-none disabled:opacity-45",
          variantStyles[variant],
          sizeStyles[size],
          className,
        )}
        ref={ref}
        {...props}
      >
        {children}
      </button>
    );
  },
);

Button.displayName = "Button";

export { Button };
