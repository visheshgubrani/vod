import { ArrowUpRight } from "lucide-react";

import { CodePanel } from "@/components/code-panel";
import { uploadExample } from "@/lib/code-samples";
import type { SiteConfig } from "@/lib/site-config";

/**
 * One example, from the integration the repository compiles on every commit.
 *
 * The tabbed four-step tutorial, the response panels and the setup checklist
 * were three ways of saying the same thing at three different sizes. Standing
 * the platform up belongs to the self-hosting section; this section is only
 * about wiring ClipMux into a product.
 */
export function DeveloperSection({ config }: { config: SiteConfig }) {
  return (
    <section id="developers" className="section section--band">
      <div className="content-width">
        <div className="section-header">
          <p className="section-label">Developer experience</p>
          <h2 className="section-title">
            From your first upload to your own player.
          </h2>
          <p className="section-intro">
            The browser uploads straight to your bucket with a short-lived token
            your backend mints. The API key never leaves the server.
          </p>
        </div>

        <CodePanel example={uploadExample} />

        <div className="section-footer">
          <p>
            The upload token comes from a backend route of your own —{" "}
            <code>app/api/upload-token/route.ts</code> in the integration
            example — so the API key stays on the server.
          </p>

          <p className="section-links">
            <a
              className="text-link"
              href={config.quickstartUrl}
            >
              Read the quickstart
              <ArrowUpRight className="size-4" aria-hidden="true" />
            </a>
            <a
              className="text-link"
              href={config.githubUrl}
              target="_blank"
              rel="noreferrer"
            >
              examples/nextjs-integration
              <ArrowUpRight className="size-4" aria-hidden="true" />
            </a>
          </p>
        </div>
      </div>
    </section>
  );
}
