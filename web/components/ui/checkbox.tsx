"use client";

import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export interface CheckboxProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: React.ReactNode;
}

/**
 * Flat brand fill when checked — no gradient — with the state also carried by
 * the icon, so it is not signalled by colour alone. The whole label is the hit
 * area, and the visual box is 24px inside a 44px row.
 */
const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, label, id, ...props }, ref) => {
    const [checked, setChecked] = React.useState(props.defaultChecked || false);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      setChecked(e.target.checked);
      props.onChange?.(e);
    };

    return (
      <label
        htmlFor={id}
        className={cn(
          "group flex min-h-11 cursor-pointer items-center gap-3",
          className,
        )}
      >
        <span className="relative inline-flex items-center justify-center">
          <input
            type="checkbox"
            id={id}
            ref={ref}
            className="peer sr-only"
            checked={checked}
            onChange={handleChange}
            {...props}
          />
          <span
            className={cn(
              "flex size-6 items-center justify-center rounded-md border-2 transition-colors",
              checked
                ? "border-brand bg-brand"
                : "border-border bg-panel-strong group-hover:border-muted-foreground/50",
              "peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background",
            )}
          >
            <Check
              className={cn(
                "size-3.5 text-brand-foreground transition-transform duration-200",
                checked ? "scale-100" : "scale-0",
              )}
              aria-hidden="true"
            />
          </span>
        </span>
        {label && (
          <span className="text-[15px] text-muted-foreground transition-colors group-hover:text-foreground">
            {label}
          </span>
        )}
      </label>
    );
  },
);

Checkbox.displayName = "Checkbox";

export { Checkbox };
