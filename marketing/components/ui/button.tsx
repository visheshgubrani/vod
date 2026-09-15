import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

/*
 * Shared button surface. Every size clears a 44px minimum height. The primary
 * action is the only place the burnt orange is used as a large fill.
 */
export const buttonVariants = cva(
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] px-5 text-[15px] font-semibold transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--paper)] disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary:
          "bg-brand text-brand-foreground hover:bg-brand-hover focus-visible:ring-brand",
        secondary:
          "border border-ink/20 bg-transparent text-ink hover:border-brand hover:text-brand focus-visible:ring-brand",
        light:
          "bg-brand text-brand-foreground hover:bg-brand-hover focus-visible:ring-ember focus-visible:ring-offset-[color:var(--charcoal)]",
        outlineLight:
          "border border-white/25 bg-transparent text-[color:var(--on-charcoal)] hover:border-white hover:bg-white/10 focus-visible:ring-ember focus-visible:ring-offset-[color:var(--charcoal)]",
        ghost: "text-ink hover:bg-brand-tint focus-visible:ring-brand",
      },
      size: {
        default: "",
        lg: "min-h-12 px-6 text-base",
        sm: "px-4 text-sm",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return (
    <button
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}
