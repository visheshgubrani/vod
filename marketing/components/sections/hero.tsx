import { ArrowUpRight } from "lucide-react";

import { HeroMedia } from "@/components/hero-media";
import { TourLink } from "@/components/tour-link";
import { buttonVariants } from "@/components/ui/button";
import { heroVideo } from "@/lib/media";
import type { SiteConfig } from "@/lib/site-config";

export function HeroSection({ config }: { config: SiteConfig }) {
  return (
    <section className="hero">
      <div className="content-width">
        <h1 className="hero-title" data-hero-item>
          Your videos.
          <span className="serif">Your infrastructure.</span>
        </h1>

        <p className="hero-copy" data-hero-item>
          Upload, transcode, and stream with an open-source video platform. Keep
          your files in your R2 buckets, choose your transcode compute, and build
          playback into your product.
        </p>

        <div className="hero-actions" data-hero-item>
          <a
            className={buttonVariants({ size: "lg" })}
            href={config.quickstartUrl}
          >
            Start self-hosting
            <ArrowUpRight className="size-4" aria-hidden="true" />
          </a>
          <TourLink variant="secondary">
            Watch the product tour
          </TourLink>
        </div>

        <p className="hero-note" data-hero-item>
          Apache-2.0 · Self-hostable · Infrastructure costs apply.
        </p>

        <div className="hero-media" data-hero-item>
          <div id="product-tour" tabIndex={-1} className="outline-none">
            <HeroMedia
              source={{
                src: heroVideo.src,
                mobileSrc: heroVideo.mobileSrc,
                poster: heroVideo.poster,
                width: heroVideo.width,
                height: heroVideo.height,
                label:
                  "Product tour: a coastal clip is uploaded, transcoded, and played back in the ClipMux dashboard.",
                caption: "coastal-headland.mp4",
              }}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
