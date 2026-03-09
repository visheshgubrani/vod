import type { IconType } from "react-icons";
import { BiSolidServer } from "react-icons/bi";
import { FaBolt, FaCode, FaGlobe } from "react-icons/fa";
import { FaHandHoldingDollar } from "react-icons/fa6";
import { HiMiniAdjustmentsHorizontal } from "react-icons/hi2";
import { MdOutlineSecurity } from "react-icons/md";
import { SiGoogleanalytics } from "react-icons/si";
import { IoMdCheckmarkCircleOutline } from "react-icons/io";

const features = [
  {
    icon: FaHandHoldingDollar,
    title: "90% Cost Savings",
    description:
      "Pay only for what you use. No hidden fees. Start at $0.005/min encoding.",
    highlight: true,
  },
  {
    icon: FaBolt,
    title: "Instant Encoding",
    description:
      "Videos ready to stream in seconds. Our parallel processing delivers industry-leading speed.",
  },
  {
    icon: FaGlobe,
    title: "Global CDN",
    description:
      "200+ edge locations worldwide. Your videos load fast everywhere, from Tokyo to Toronto.",
  },
  {
    icon: FaCode,
    title: "Developer-First API",
    description:
      "Clean REST API, comprehensive SDKs, and webhooks. Integrate in minutes, not days.",
  },
  {
    icon: MdOutlineSecurity,
    title: "Enterprise Security",
    description:
      "Signed URLs, DRM support, geo-restrictions, and domain-level access control.",
  },
  {
    icon: HiMiniAdjustmentsHorizontal,
    title: "Adaptive Bitrate",
    description:
      "HLS and DASH streaming with automatic quality adjustment for every viewer's connection.",
  },
  {
    icon: BiSolidServer,
    title: "99.99% Uptime SLA",
    description:
      "Enterprise-grade reliability with redundant infrastructure and 24/7 monitoring.",
  },
  {
    icon: SiGoogleanalytics,
    title: "Real-time Analytics",
    description:
      "Track views, engagement, quality metrics, and viewer behavior with detailed dashboards.",
  },
];

export function Features() {
  return (
    <section id="features" className="relative pt-24 pb-20 overflow-hidden">
      {/* Background */}
      <div className="absolute inset-0 bg-gradient-to-b from-background via-card/30 to-background" />

      <div className="relative z-10 max-w-7xl mx-auto px-6">
        {/* Section Header */}
        <div className="text-center mb-16">
          <div className="bg-mauve-600/40 px-4  py-2 flex items-center gap-1.5 inline-flex rounded-full border-mauve-300/25 border mb-6">
            <IoMdCheckmarkCircleOutline className="size-5" />
            <span className="text-sm">Everything you need</span>
          </div>
          <h2 className="text-3xl md:text-4xl lg:text-5xl font-bold mb-4">
            Built for <span className="gradient-text">Modern Developers</span>
          </h2>
          <p className="text-base md:text-lg text-muted-foreground max-w-2xl mx-auto">
            All the features you&apos;d expect from Mux or Cloudflare Stream, at
            a fraction of the cost.
          </p>
        </div>

        {/* Features Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
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
  icon: IconType;
  title: string;
  description: string;
  highlight?: boolean;
  index: number;
}) {
  return (
    <div
      className="group relative bg-card/40 border border-card rounded-sm p-4 transition-all duration-300"
      style={{ animationDelay: `${index * 0.1}s` }}
    >
      <div className="relative z-10 flex flex-col justify-between h-full">
        {/* Icon */}
        <div
          className={`w-12 h-12 rounded-sm flex items-center justify-center mb-8 transition-colors ${
            highlight
              ? "bg-gradient-to-br from-primary/80 to-accent/70 text-white"
              : "text-accent group-hover:scale-105 transition-all duration-300 ease-in-out"
          }`}
        >
          <Icon className="w-6 h-6" />
        </div>

        <div className="flex flex-col">
          {/* Title */}
          <h3 className="text-lg font-semibold mb-2 flex items-center gap-2">
            {title}
          </h3>

          {/* Description */}
          <p className="text-muted-foreground text-sm leading-relaxed">
            {description}
          </p>
        </div>
      </div>
    </div>
  );
}
