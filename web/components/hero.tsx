import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowRight, Play, Zap, DollarSign, Globe } from "lucide-react";

export function Hero() {
    return (
        <section className="relative min-h-screen flex items-center justify-center overflow-hidden">
            {/* Animated Background */}
            <div className="absolute inset-0 gradient-bg" />
            <div className="absolute inset-0 grid-pattern opacity-30" />
            <div className="absolute inset-0 radial-overlay" />

            {/* Floating Orbs */}
            <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-primary/20 rounded-full blur-3xl animate-float" />
            <div className="absolute bottom-1/4 right-1/4 w-80 h-80 bg-accent/20 rounded-full blur-3xl animate-float" style={{ animationDelay: "1s" }} />

            {/* Content */}
            <div className="relative z-10 max-w-7xl mx-auto px-6 py-32 text-center">
                {/* Badge */}
                <div className="inline-flex items-center gap-2 glass rounded-full px-4 py-2 mb-8 animate-fade-in-up">
                    <span className="w-2 h-2 bg-success rounded-full animate-pulse" />
                    <span className="text-sm text-muted-foreground">
                        Now serving 50M+ video views monthly
                    </span>
                </div>

                {/* Main Headline */}
                <h1 className="text-5xl md:text-7xl lg:text-8xl font-bold tracking-tight mb-6 animate-fade-in-up" style={{ animationDelay: "0.1s" }}>
                    Stream Video at{" "}
                    <span className="gradient-text">90% Less Cost</span>
                </h1>

                {/* Subheadline */}
                <p className="text-xl md:text-2xl text-muted-foreground max-w-3xl mx-auto mb-10 animate-fade-in-up" style={{ animationDelay: "0.2s" }}>
                    The developer-first video platform that delivers Mux-quality streaming
                    without the enterprise pricing. Simple API, global CDN, instant encoding.
                </p>

                {/* CTA Buttons */}
                <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16 animate-fade-in-up" style={{ animationDelay: "0.3s" }}>
                    <Link href="/signup">
                        <Button size="lg" className="group">
                            Start Free Trial
                            <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                        </Button>
                    </Link>
                    <Button variant="outline" size="lg" className="group">
                        <Play className="w-5 h-5" />
                        Watch Demo
                    </Button>
                </div>

                {/* Stats */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 max-w-4xl mx-auto stagger-children">
                    <StatCard
                        icon={<DollarSign className="w-6 h-6" />}
                        value="$0.005"
                        label="per minute encoded"
                        highlight="10x cheaper"
                    />
                    <StatCard
                        icon={<Globe className="w-6 h-6" />}
                        value="200+"
                        label="edge locations"
                        highlight="Global CDN"
                    />
                    <StatCard
                        icon={<Zap className="w-6 h-6" />}
                        value="<2s"
                        label="average latency"
                        highlight="Lightning fast"
                    />
                </div>
            </div>

            {/* Bottom Gradient Fade */}
            <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-background to-transparent" />
        </section>
    );
}

function StatCard({
    icon,
    value,
    label,
    highlight,
}: {
    icon: React.ReactNode;
    value: string;
    label: string;
    highlight: string;
}) {
    return (
        <div className="glass rounded-2xl p-6 hover:scale-105 transition-transform cursor-default">
            <div className="flex items-center justify-center gap-2 text-primary mb-2">
                {icon}
                <span className="text-xs font-semibold uppercase tracking-wider">
                    {highlight}
                </span>
            </div>
            <div className="text-4xl font-bold mb-1">{value}</div>
            <div className="text-muted-foreground text-sm">{label}</div>
        </div>
    );
}
