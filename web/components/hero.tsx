import Link from "next/link";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { ArrowRight, Play } from "lucide-react";

export function Hero() {
  return (
    <section className="relative min-h-screen pt-10 md:pt-20 pb-8 flex items-center justify-center overflow-hidden">
      {/* Animated Background */}
      <div className="absolute inset-0 bg-gradient-to-b from-background via-card/25 to-background" />
      <div className="absolute inset-0 grid-pattern opacity-65" />
      <div className="absolute inset-0 radial-overlay" />

      {/* Content */}
      <div className="relative z-10 max-w-7xl mx-auto px-6 pt-28 pb-6 text-center">
        {/* Badge */}
        <div className="bg-mauve-600/40 px-4 py-2 inline-flex items-center gap-1.5 md:gap-2.5 rounded-full border-mauve-300/25 border mb-8 animate-fade-in-up">
          <span className="size-2 md:size-3 bg-lime-400/90 rounded-full animate-pulse" />
          <span className=" text-xs whitespace-nowrap md:text-sm font-medium">
            Now serving 50M+ video views monthly
          </span>
        </div>

        {/* Main Headline */}
        <h1
          className="text-4xl sm:text-5xl md:text-6xl font-semibold leading-[1.15] tracking-tight mb-5 animate-fade-in-up"
          style={{ animationDelay: "0.1s" }}
        >
          Stream Video at {""}
          <span className="gradient-text">90% Less Cost</span>
        </h1>

        {/* Subheadline */}
        <p
          className="text-base sm:text-lg text-white/70 max-w-3xl mx-auto mb-10 animate-fade-in-up"
          style={{ animationDelay: "0.2s" }}
        >
          The developer-first video platform that delivers Mux-quality streaming
          without the enterprise pricing. Simple API, global CDN, instant
          encoding.
        </p>

        {/* CTA Buttons */}
        <div
          className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16 animate-fade-in-up"
          style={{ animationDelay: "0.3s" }}
        >
          <Link href="/signup">
            <Button className="group py-3 px-8 rounded-full bg-[#704fd5] text-white cursor-pointer hover:bg-[#704fd5]/90">
              Start Free Trial
              <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
            </Button>
          </Link>
          <Button
            variant="ghost"
            className="group cursor-pointer h-auto py-3 px-8 bg-transparent decoration-2 underline-offset-4 font-semibold hover:bg-transparent"
          >
            <Play className="size-7 fill-primary/85 text-primary" />
            Watch Demo
          </Button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 lg:gap-8 gap-6 max-w-7xl mx-auto stagger-children">
          <StatCard
            imageSrc="/images/cdn1.svg"
            imageAlt="Global CDN"
            title="Global CDN"
            description="Deliver video smoothly worldwide with our high-coverage edge network built for fast, reliable streaming."
            badge="200+"
          />

          <StatCard
            imageSrc="/images/fast1.svg"
            imageAlt="Lightning fast delivery"
            title="Lightning Fast"
            description="Ultra-low latency delivery ensures fast startup times and responsive playback for every viewer."
            badge="<2s"
          />

          <StatCard
            imageSrc="/images/price1.svg"
            imageAlt="Affordable pricing"
            title="10x Cheaper"
            description="Per-minute encoding with simple, transparent pricing that keeps video streaming costs predictable."
            badge="$0.005"
          />
        </div>
      </div>

      {/* Bottom Gradient Fade */}
      <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-background to-transparent" />
    </section>
  );
}

function StatCard({
  imageSrc,
  imageAlt,
  title,
  description,
  badge,
}: {
  imageSrc: string;
  imageAlt: string;
  title: string;
  description: string;
  badge: string;
}) {
  return (
    <div className="bg-card/40 border border-card rounded-sm p-6 transition-transform cursor-default text-left max-w-md mx-auto">
      <div className="relative mb-6 w-full overflow-hidden">
        <Image
          src={imageSrc}
          alt={imageAlt}
          width={450}
          height={100}
          className="object-cover select-none mask-b-from-90% opacity-60"
        />
      </div>
      <div className="flex items-start gap-2 justify-between mb-4">
        <h3 className="text-xl font-medium text-mauve-200">{title}</h3>
        <span className="bg-mauve-600/40 px-4 inline-flex rounded-full border-mauve-300/25 border">
          {badge}
        </span>
      </div>
      <p className="text-muted-foreground text-sm">{description}</p>
    </div>
  );
}
