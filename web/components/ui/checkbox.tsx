"use client";

import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export interface CheckboxProps extends React.InputHTMLAttributes<HTMLInputElement> {
    label?: React.ReactNode;
}

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
                className={cn("flex items-center gap-3 cursor-pointer group", className)}
            >
                <div className="relative">
                    <input
                        type="checkbox"
                        id={id}
                        ref={ref}
                        className="sr-only peer"
                        checked={checked}
                        onChange={handleChange}
                        {...props}
                    />
                    <div
                        className={cn(
                            "w-5 h-5 rounded-md border-2 transition-all duration-200 flex items-center justify-center",
                            checked
                                ? "bg-gradient-to-r from-primary to-accent border-primary"
                                : "border-border bg-muted/30 group-hover:border-muted-foreground/50"
                        )}
                    >
                        <Check
                            className={cn(
                                "w-3 h-3 text-white transition-all duration-200",
                                checked ? "scale-100 opacity-100" : "scale-0 opacity-0"
                            )}
                        />
                    </div>
                </div>
                {label && (
                    <span className="text-sm text-muted-foreground group-hover:text-foreground transition-colors">
                        {label}
                    </span>
                )}
            </label>
        );
    }
);

Checkbox.displayName = "Checkbox";

export { Checkbox };
