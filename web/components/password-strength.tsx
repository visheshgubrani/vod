"use client";

import { PasswordStrength, getPasswordStrength } from "@/types/auth";
import { cn } from "@/lib/utils";

interface PasswordStrengthIndicatorProps {
    password: string;
}

export function PasswordStrengthIndicator({ password }: PasswordStrengthIndicatorProps) {
    const strength = getPasswordStrength(password);

    const strengthConfig: Record<PasswordStrength, { label: string; color: string; bars: number }> = {
        weak: { label: "Weak", color: "bg-destructive", bars: 1 },
        medium: { label: "Medium", color: "bg-warning", bars: 2 },
        strong: { label: "Strong", color: "bg-success", bars: 3 },
    };

    const config = strengthConfig[strength];

    if (!password) return null;

    return (
        <div className="mt-2 space-y-1.5">
            <div className="flex gap-1">
                {[1, 2, 3].map((bar) => (
                    <div
                        key={bar}
                        className={cn(
                            "h-1 flex-1 rounded-full transition-all duration-300",
                            bar <= config.bars ? config.color : "bg-muted"
                        )}
                    />
                ))}
            </div>
            <p className={cn(
                "text-xs",
                strength === "weak" && "text-destructive",
                strength === "medium" && "text-warning",
                strength === "strong" && "text-success"
            )}>
                Password strength: {config.label}
            </p>
        </div>
    );
}
