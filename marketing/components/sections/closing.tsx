import { ArrowUpRight } from "lucide-react";

import { BrandMark } from "@/components/brand-mark";
import { buttonVariants } from "@/components/ui/button";
import type { SiteConfig } from "@/lib/site-config";

export function ClosingSection({ config }: { config: SiteConfig }) {
  return (
    <footer className="closing-section">
      <div className="content-width">
        <h2>
          Build something
          <span className="serif">worth watching.</span>
        </h2>

        <p>
          Start with the complete open-source platform. The infrastructure stays
          yours, and the product stays the thing people remember.
        </p>

        <div className="closing-actions">
          <a
            className={buttonVariants({ variant: "light", size: "lg" })}
            href={config.quickstartUrl}
          >
            Start self-hosting
            <ArrowUpRight className="size-4" aria-hidden="true" />
          </a>
          <a className="quiet-link" href={config.docsUrl}>
            Read the documentation
          </a>
        </div>

        <div className="footer">
          <div>
            <div className="footer-brand">
              <BrandMark invert className="size-7" />
              ClipMux
            </div>
            <small className="footer-note">
              Open-source video infrastructure · Apache-2.0
            </small>
          </div>

          <nav className="footer-links" aria-label="Footer navigation">
            <a href={config.docsUrl}>Docs</a>
            <a href={config.githubUrl} target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a
              href="https://www.apache.org/licenses/LICENSE-2.0"
              target="_blank"
              rel="noreferrer"
            >
              License
            </a>
            <a href={config.privacyUrl}>Privacy</a>
          </nav>
        </div>
      </div>
    </footer>
  );
}
