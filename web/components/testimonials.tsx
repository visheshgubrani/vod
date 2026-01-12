import { Star } from "lucide-react";

const testimonials = [
    {
        quote:
            "Switching from Mux saved us $15,000/month. The API is actually simpler and encoding is faster. No brainer.",
        author: "Sarah Chen",
        role: "CTO at EduStream",
        avatar: "SC",
        rating: 5,
    },
    {
        quote:
            "We were skeptical about the pricing, but the quality is identical to what we had before. Our viewers can't tell the difference.",
        author: "Marcus Johnson",
        role: "VP Engineering at MediaCorp",
        avatar: "MJ",
        rating: 5,
    },
    {
        quote:
            "The developer experience is fantastic. We integrated their API in half a day. Documentation is chef's kiss.",
        author: "Elena Rodriguez",
        role: "Lead Developer at CreatorHub",
        avatar: "ER",
        rating: 5,
    },
    {
        quote:
            "Finally, a video platform that doesn't require a finance degree to understand the pricing. Simple, predictable, affordable.",
        author: "David Kim",
        role: "Founder at VideoFirst",
        avatar: "DK",
        rating: 5,
    },
];

const logos = [
    "TechCrunch",
    "ProductHunt",
    "Vercel",
    "Shopify",
    "Linear",
    "Notion",
];

export function Testimonials() {
    return (
        <section id="testimonials" className="relative py-32 overflow-hidden">
            {/* Background */}
            <div className="absolute inset-0 radial-overlay" />

            <div className="relative z-10 max-w-7xl mx-auto px-6">
                {/* Section Header */}
                <div className="text-center mb-16">
                    <div className="inline-flex items-center gap-2 glass rounded-full px-4 py-2 mb-6">
                        <Star className="w-4 h-4 text-yellow-500 fill-yellow-500" />
                        <span className="text-sm text-muted-foreground">
                            Loved by developers
                        </span>
                    </div>
                    <h2 className="text-4xl md:text-5xl font-bold mb-4">
                        Trusted by{" "}
                        <span className="gradient-text">Thousands</span> of Teams
                    </h2>
                    <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
                        From startups to enterprises, developers choose StreamFlow
                        for reliable, affordable video streaming.
                    </p>
                </div>

                {/* Company Logos */}
                <div className="flex flex-wrap items-center justify-center gap-8 mb-16 opacity-50">
                    {logos.map((logo) => (
                        <div
                            key={logo}
                            className="text-xl font-bold text-muted-foreground tracking-tight"
                        >
                            {logo}
                        </div>
                    ))}
                </div>

                {/* Testimonials Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {testimonials.map((testimonial, index) => (
                        <div
                            key={index}
                            className="glass rounded-2xl p-8 hover:scale-[1.02] transition-transform"
                        >
                            {/* Stars */}
                            <div className="flex gap-1 mb-4">
                                {Array.from({ length: testimonial.rating }).map((_, i) => (
                                    <Star
                                        key={i}
                                        className="w-5 h-5 text-yellow-500 fill-yellow-500"
                                    />
                                ))}
                            </div>

                            {/* Quote */}
                            <blockquote className="text-lg leading-relaxed mb-6">
                                "{testimonial.quote}"
                            </blockquote>

                            {/* Author */}
                            <div className="flex items-center gap-4">
                                <div className="w-12 h-12 rounded-full bg-gradient-to-br from-primary to-accent flex items-center justify-center text-white font-semibold">
                                    {testimonial.avatar}
                                </div>
                                <div>
                                    <div className="font-semibold">{testimonial.author}</div>
                                    <div className="text-sm text-muted-foreground">
                                        {testimonial.role}
                                    </div>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>

                {/* Stats Banner */}
                <div className="mt-16 glass rounded-3xl p-8 md:p-12">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-8 text-center">
                        <div>
                            <div className="text-4xl md:text-5xl font-bold gradient-text">
                                2,500+
                            </div>
                            <div className="text-muted-foreground mt-2">Active customers</div>
                        </div>
                        <div>
                            <div className="text-4xl md:text-5xl font-bold gradient-text">
                                50M+
                            </div>
                            <div className="text-muted-foreground mt-2">Videos delivered</div>
                        </div>
                        <div>
                            <div className="text-4xl md:text-5xl font-bold gradient-text">
                                99.99%
                            </div>
                            <div className="text-muted-foreground mt-2">Uptime SLA</div>
                        </div>
                        <div>
                            <div className="text-4xl md:text-5xl font-bold gradient-text">
                                $2M+
                            </div>
                            <div className="text-muted-foreground mt-2">Customer savings</div>
                        </div>
                    </div>
                </div>
            </div>
        </section>
    );
}
