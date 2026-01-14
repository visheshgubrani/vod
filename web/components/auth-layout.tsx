import Link from "next/link";
import { Play, Zap, Shield, Globe } from "lucide-react";

interface AuthLayoutProps {
    children: React.ReactNode;
    title: string;
    subtitle: string;
}

const features = [
    { icon: Zap, text: "Instant video encoding" },
    { icon: Shield, text: "Enterprise-grade security" },
    { icon: Globe, text: "Global CDN delivery" },
];

export function AuthLayout({ children, title, subtitle }: AuthLayoutProps) {
    return (
        <div className="min-h-screen flex">
            {/* Left Panel - Branding */}
            <div className="hidden lg:flex lg:w-1/2 relative overflow-hidden">
                {/* Background */}
                <div className="absolute inset-0 gradient-bg" />
                <div className="absolute inset-0 grid-pattern opacity-20" />
                <div className="absolute inset-0 radial-overlay" />

                {/* Floating Orbs */}
                <div className="absolute top-1/4 left-1/4 w-64 h-64 bg-primary/20 rounded-full blur-3xl animate-float" />
                <div className="absolute bottom-1/3 right-1/4 w-48 h-48 bg-accent/20 rounded-full blur-3xl animate-float" style={{ animationDelay: "1.5s" }} />

                {/* Content */}
                <div className="relative z-10 flex flex-col justify-between p-12 w-full">
                    {/* Logo */}
                    <Link href="/" className="flex items-center gap-2 group">
                        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform">
                            <Play className="w-5 h-5 text-white fill-white" />
                        </div>
                        <span className="text-xl font-bold text-white">ClipMux</span>
                    </Link>

                    {/* Main Content */}
                    <div className="space-y-8">
                        <div>
                            <h1 className="text-4xl font-bold text-white mb-4">
                                Stream video at <span className="gradient-text">90% less cost</span>
                            </h1>
                            <p className="text-lg text-white/70">
                                Join thousands of developers building with the most cost-effective video platform.
                            </p>
                        </div>

                        {/* Features */}
                        <div className="space-y-4">
                            {features.map((feature, index) => (
                                <div key={index} className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-lg bg-white/10 flex items-center justify-center">
                                        <feature.icon className="w-5 h-5 text-primary" />
                                    </div>
                                    <span className="text-white/80">{feature.text}</span>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Testimonial */}
                    <div className="glass rounded-2xl p-6">
                        <p className="text-white/90 mb-4">
                            "Switching to ClipMux cut our video costs by 85%. The migration took less than a day."
                        </p>
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-primary to-accent flex items-center justify-center text-white font-semibold text-sm">
                                SC
                            </div>
                            <div>
                                <p className="text-white font-medium text-sm">Sarah Chen</p>
                                <p className="text-white/60 text-xs">CTO at EduStream</p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Right Panel - Form */}
            <div className="flex-1 flex items-center justify-center p-6 lg:p-12 bg-background">
                <div className="w-full max-w-md">
                    {/* Mobile Logo */}
                    <div className="lg:hidden mb-8">
                        <Link href="/" className="flex items-center gap-2 justify-center">
                            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center">
                                <Play className="w-5 h-5 text-white fill-white" />
                            </div>
                            <span className="text-xl font-bold gradient-text">ClipMux</span>
                        </Link>
                    </div>

                    {/* Header */}
                    <div className="text-center lg:text-left mb-8">
                        <h2 className="text-3xl font-bold mb-2">{title}</h2>
                        <p className="text-muted-foreground">{subtitle}</p>
                    </div>

                    {/* Form Content */}
                    <div className="glass rounded-2xl p-8">
                        {children}
                    </div>
                </div>
            </div>
        </div>
    );
}
