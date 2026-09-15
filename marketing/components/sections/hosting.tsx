import { ArrowUpRight, Check, Minus } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import type { SiteConfig } from "@/lib/site-config";

export function HostingSection({ config }: { config: SiteConfig }) {
  return (
    <section id="hosting" className="section" data-reveal>
      <div className="content-width">
        <div className="section-header">
          <div>
            <p className="section-label">05 / Hosting</p>
            <h2 className="section-title">
              One platform. Choose who operates it.
            </h2>
          </div>
          <p className="section-intro">
            Self-hosting is the path that exists today, and the one this page is
            about. The other two are conversations, not products you can buy.
          </p>
        </div>

        <div className="hosting-grid">
          <article className="hosting-card hosting-card--primary">
            <span className="hosting-tag">Available now</span>
            <h3>Self-hosted</h3>
            <p>
              The complete ClipMux application running on accounts you own, with
              your buckets, your compute, and your database.
            </p>
            <ul>
              {[
                "Apache-2.0, no feature gates",
                "Upload, transcode, package, deliver",
                "Dashboard, webhooks, and SDKs",
                "Community support",
              ].map((item) => (
                <li key={item}>
                  <Check className="size-4" aria-hidden="true" />
                  {item}
                </li>
              ))}
            </ul>
            <div className="card-action">
              <a
                className={`${buttonVariants({ size: "lg" })} w-full`}
                href={config.quickstartUrl}
              >
                Start self-hosting
                <ArrowUpRight className="size-4" aria-hidden="true" />
              </a>
            </div>
          </article>

          <article className="hosting-card hosting-card--muted">
            <span className="hosting-tag">Planned</span>
            <h3>Managed</h3>
            <p>
              ClipMux running the same platform for you. There is no date and no
              price yet, so this is an interest list rather than an offer.
            </p>
            <ul>
              {[
                "Same platform foundation",
                "Operations handled for you",
                "No pricing announced",
              ].map((item) => (
                <li key={item}>
                  <Minus className="size-4" aria-hidden="true" />
                  {item}
                </li>
              ))}
            </ul>
            <div className="card-action">
              <a
                className={`${buttonVariants({ variant: "secondary" })} w-full`}
                href={config.managedFormUrl}
              >
                Join the interest list
              </a>
            </div>
          </article>

          <article className="hosting-card hosting-card--muted">
            <span className="hosting-tag">Deployment inquiry</span>
            <h3>Enterprise</h3>
            <p>
              A conversation about your environment: architecture, onboarding
              requirements, and the operational support you need around it.
            </p>
            <ul>
              {[
                "Architecture review",
                "Onboarding planning",
                "Support discussion",
              ].map((item) => (
                <li key={item}>
                  <Minus className="size-4" aria-hidden="true" />
                  {item}
                </li>
              ))}
            </ul>
            <div className="card-action">
              <a
                className={`${buttonVariants({ variant: "secondary" })} w-full`}
                href={config.enterpriseFormUrl}
              >
                Discuss your deployment
              </a>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}
