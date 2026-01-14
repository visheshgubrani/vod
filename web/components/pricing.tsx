"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Check, X, Calculator } from "lucide-react";

const tiers = [
    {
        name: "Starter",
        price: "Free",
        period: "",
        description: "Perfect for side projects and testing",
        features: [
            { text: "10 GB storage", included: true },
            { text: "100 GB bandwidth/month", included: true },
            { text: "720p encoding", included: true },
            { text: "Basic analytics", included: true },
            { text: "Community support", included: true },
            { text: "Custom player", included: false },
            { text: "API access", included: false },
        ],
        cta: "Start Free",
        highlighted: false,
    },
    {
        name: "Pro",
        price: "$29",
        period: "/month",
        description: "For growing businesses and creators",
        features: [
            { text: "500 GB storage", included: true },
            { text: "2 TB bandwidth/month", included: true },
            { text: "4K encoding", included: true },
            { text: "Advanced analytics", included: true },
            { text: "Priority support", included: true },
            { text: "Custom player", included: true },
            { text: "Full API access", included: true },
        ],
        cta: "Start Trial",
        highlighted: true,
    },
    {
        name: "Enterprise",
        price: "Custom",
        period: "",
        description: "For large-scale video operations",
        features: [
            { text: "Unlimited storage", included: true },
            { text: "Unlimited bandwidth", included: true },
            { text: "8K encoding", included: true },
            { text: "Custom analytics", included: true },
            { text: "24/7 dedicated support", included: true },
            { text: "White-label player", included: true },
            { text: "SLA guarantee", included: true },
        ],
        cta: "Contact Sales",
        highlighted: false,
    },
];

export function Pricing() {
    const [minutes, setMinutes] = useState(1000);

    const ourCost = minutes * 0.005;
    const muxCost = minutes * 0.05;
    const savings = muxCost - ourCost;
    const savingsPercent = ((savings / muxCost) * 100).toFixed(0);

    return (
        <section id="pricing" className="relative py-32 overflow-hidden">
            {/* Background */}
            <div className="absolute inset-0 radial-overlay" />

            <div className="relative z-10 max-w-7xl mx-auto px-6">
                {/* Section Header */}
                <div className="text-center mb-16">
                    <div className="inline-flex items-center gap-2 glass rounded-full px-4 py-2 mb-6">
                        <Calculator className="w-4 h-4 text-primary" />
                        <span className="text-sm text-muted-foreground">
                            Transparent pricing
                        </span>
                    </div>
                    <h2 className="text-4xl md:text-5xl font-bold mb-4">
                        Save <span className="gradient-text">More</span> as You Grow
                    </h2>
                    <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
                        Simple, predictable pricing with no surprises.
                        Pay only for what you use.
                    </p>
                </div>

                {/* Cost Calculator */}
                <div className="glass rounded-3xl p-8 mb-16 max-w-4xl mx-auto">
                    <h3 className="text-xl font-semibold mb-6 text-center">
                        Cost Comparison Calculator
                    </h3>

                    <div className="mb-8">
                        <label className="block text-sm text-muted-foreground mb-3">
                            Monthly encoding minutes: <span className="text-foreground font-semibold">{minutes.toLocaleString()}</span>
                        </label>
                        <input
                            type="range"
                            min="100"
                            max="100000"
                            step="100"
                            value={minutes}
                            onChange={(e) => setMinutes(Number(e.target.value))}
                            className="w-full h-2 bg-muted rounded-full appearance-none cursor-pointer
                         [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-6 [&::-webkit-slider-thumb]:h-6 
                         [&::-webkit-slider-thumb]:bg-gradient-to-r [&::-webkit-slider-thumb]:from-primary [&::-webkit-slider-thumb]:to-accent 
                         [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-lg"
                        />
                        <div className="flex justify-between text-xs text-muted-foreground mt-2">
                            <span>100 min</span>
                            <span>100,000 min</span>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        {/* Our Cost */}
                        <div className="rounded-2xl bg-gradient-to-br from-primary/20 to-accent/20 p-6 text-center border border-primary/30">
                            <div className="text-sm text-muted-foreground mb-2">ClipMux</div>
                            <div className="text-3xl font-bold text-primary">
                                ${ourCost.toFixed(2)}
                            </div>
                            <div className="text-xs text-muted-foreground mt-1">
                                @ $0.005/min
                            </div>
                        </div>

                        {/* Mux Cost */}
                        <div className="rounded-2xl bg-muted/50 p-6 text-center">
                            <div className="text-sm text-muted-foreground mb-2">Mux</div>
                            <div className="text-3xl font-bold text-muted-foreground line-through">
                                ${muxCost.toFixed(2)}
                            </div>
                            <div className="text-xs text-muted-foreground mt-1">
                                @ $0.05/min
                            </div>
                        </div>

                        {/* Savings */}
                        <div className="rounded-2xl bg-success/10 p-6 text-center border border-success/30">
                            <div className="text-sm text-muted-foreground mb-2">You Save</div>
                            <div className="text-3xl font-bold text-success">
                                ${savings.toFixed(2)}
                            </div>
                            <div className="text-xs text-success mt-1">
                                {savingsPercent}% savings
                            </div>
                        </div>
                    </div>
                </div>

                {/* Pricing Tiers */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                    {tiers.map((tier, index) => (
                        <div
                            key={index}
                            className={`relative glass rounded-3xl p-8 ${tier.highlighted
                                    ? "ring-2 ring-primary scale-105 shadow-xl"
                                    : ""
                                }`}
                        >
                            {tier.highlighted && (
                                <div className="absolute -top-4 left-1/2 -translate-x-1/2 px-4 py-1 rounded-full bg-gradient-to-r from-primary to-accent text-sm font-semibold text-white">
                                    Most Popular
                                </div>
                            )}

                            <div className="text-center mb-6">
                                <h3 className="text-xl font-semibold mb-2">{tier.name}</h3>
                                <div className="flex items-baseline justify-center gap-1">
                                    <span className="text-4xl font-bold">{tier.price}</span>
                                    <span className="text-muted-foreground">{tier.period}</span>
                                </div>
                                <p className="text-sm text-muted-foreground mt-2">
                                    {tier.description}
                                </p>
                            </div>

                            <ul className="space-y-3 mb-8">
                                {tier.features.map((feature, i) => (
                                    <li key={i} className="flex items-center gap-3">
                                        {feature.included ? (
                                            <Check className="w-5 h-5 text-success flex-shrink-0" />
                                        ) : (
                                            <X className="w-5 h-5 text-muted-foreground flex-shrink-0" />
                                        )}
                                        <span
                                            className={
                                                feature.included
                                                    ? "text-foreground"
                                                    : "text-muted-foreground"
                                            }
                                        >
                                            {feature.text}
                                        </span>
                                    </li>
                                ))}
                            </ul>

                            <Button
                                variant={tier.highlighted ? "primary" : "outline"}
                                className="w-full"
                            >
                                {tier.cta}
                            </Button>
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
}
