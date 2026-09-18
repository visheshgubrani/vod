import { ArrowUpRight } from "lucide-react";

import { CodePanel } from "@/components/code-panel";
import { buttonVariants } from "@/components/ui/button";
import { bootstrapExample } from "@/lib/code-samples";
import type { SiteConfig } from "@/lib/site-config";

/**
 * One hosting story, not a comparison.
 *
 * The page used to weigh self-hosting against a managed tier and an enterprise
 * conversation. Neither is a product you can buy, so the section now says what
 * self-hosting actually is, what it costs, and how to start.
 */
export function HostingSection({ config }: { config: SiteConfig }) {
  return (
    <section id="hosting" className="section">
      <div className="content-width">
        <div className="section-header">
          <p className="section-label">Self-hosting</p>
          <h2 className="section-title">
            Start it on your own infrastructure.
          </h2>
          <p className="section-intro">
            Apache-2.0 with no feature gates and no licence fee. You pay your
            providers directly for storage, egress, Postgres, and GPU time.
          </p>
        </div>

        <div className="hosting-layout">
          <CodePanel example={bootstrapExample(config.githubUrl)} />

          <div className="hosting-action">
            <a
              className={buttonVariants({ size: "lg" })}
              href={config.quickstartUrl}
            >
              Start self-hosting
              <ArrowUpRight className="size-4" aria-hidden="true" />
            </a>
            <a className="text-link" href={config.docsUrl}>
              Read the documentation
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
