import {
    Zap,
    Shield,
    Code2,
    Globe,
    Gauge,
    Wallet,
    Server,
    LineChart,
} from "lucide-react";

const features = [
    {
        icon: Wallet,
        title: "90% Cost Savings",
        description:
            "Pay only for what you use. No minimum commitments, no hidden fees. Start at $0.005/min encoding.",
        highlight: true,
    },
    {
        icon: Zap,
        title: "Instant Encoding",
        description:
            "Videos ready to stream in seconds, not hours. Our parallel processing delivers industry-leading speed.",
    },
    {
        icon: Globe,
        title: "Global CDN",
        description:
            "200+ edge locations worldwide. Your videos load fast everywhere, from Tokyo to Toronto.",
    },
    {
        icon: Code2,
        title: "Developer-First API",
        description:
            "Clean REST API, comprehensive SDKs, and webhooks. Integrate in minutes, not days.",
    },
    {
        icon: Shield,
        title: "Enterprise Security",
        description:
            "Signed URLs, DRM support, geo-restrictions, and domain-level access control.",
    },
    {
        icon: Gauge,
        title: "Adaptive Bitrate",
        description:
            "HLS and DASH streaming with automatic quality adjustment for every viewer's connection.",
    },
    {
        icon: Server,
        title: "99.99% Uptime SLA",
        description:
            "Enterprise-grade reliability with redundant infrastructure and 24/7 monitoring.",
    },
    {
        icon: LineChart,
        title: "Real-time Analytics",
        description:
            "Track views, engagement, quality metrics, and viewer behavior with detailed dashboards.",
    },
];

export function Features() {
    return (
        <section id="features" className="relative py-32 overflow-hidden">
            {/* Background */}
            <div className="absolute inset-0 bg-gradient-to-b from-background via-card/30 to-background" />

            <div className="relative z-10 max-w-7xl mx-auto px-6">
                {/* Section Header */}
                <div className="text-center mb-16">
                    <div className="inline-flex items-center gap-2 glass rounded-full px-4 py-2 mb-6">
                        <span className="text-sm text-muted-foreground">
                            Everything you need
                        </span>
                    </div>
                    <h2 className="text-4xl md:text-5xl font-bold mb-4">
                        Built for{" "}
                        <span className="gradient-text">Modern Developers</span>
                    </h2>
                    <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
                        All the features you'd expect from Mux or Cloudflare Stream,
                        at a fraction of the cost.
                    </p>
                </div>

                {/* Features Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                    {features.map((feature, index) => (
                        <FeatureCard key={index} {...feature} index={index} />
                    ))}
                </div>
            </div>
        </section>
    );
}

function FeatureCard({
    icon: Icon,
    title,
    description,
    highlight,
    index,
}: {
    icon: typeof Zap;
    title: string;
    description: string;
    highlight?: boolean;
    index: number;
}) {
    return (
        <div
            className={`group relative glass rounded-2xl p-6 hover:scale-[1.02] transition-all duration-300 ${highlight ? "md:col-span-2 lg:col-span-1" : ""
                }`}
            style={{ animationDelay: `${index * 0.1}s` }}
        >
            {/* Highlight glow for featured item */}
            {highlight && (
                <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-primary/20 to-accent/20 opacity-0 group-hover:opacity-100 transition-opacity" />
            )}

            <div className="relative z-10">
                {/* Icon */}
                <div
                    className={`w-12 h-12 rounded-xl flex items-center justify-center mb-4 transition-colors ${highlight
                            ? "bg-gradient-to-br from-primary to-accent text-white"
                            : "bg-muted text-primary group-hover:bg-primary group-hover:text-white"
                        }`}
                >
                    <Icon className="w-6 h-6" />
                </div>

                {/* Title */}
                <h3 className="text-lg font-semibold mb-2 flex items-center gap-2">
                    {title}
                    {highlight && (
                        <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-success/20 text-success">
                            Best Value
                        </span>
                    )}
                </h3>

                {/* Description */}
                <p className="text-muted-foreground text-sm leading-relaxed">
                    {description}
                </p>
            </div>
        </div>
    );
}
