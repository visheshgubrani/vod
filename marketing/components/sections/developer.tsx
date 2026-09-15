import { ArrowUpRight } from "lucide-react";

import { CodeTabs } from "@/components/code-tabs";
import type { SiteConfig } from "@/lib/site-config";

const checklist = [
  {
    title: "Check the machine",
    body: "The wizard verifies each requirement for the shape you pick — a Docker daemon, a Cloudflare login, a Modal token — instead of assuming them.",
  },
  {
    title: "Choose the infrastructure",
    body: "R2 buckets, Postgres, the API runtime, and whether transcoding runs on Modal or on hosts you operate.",
  },
  {
    title: "Collect credentials",
    body: "Storage keys, database URL, signing secrets. Existing values in the target file are reused rather than overwritten.",
  },
  {
    title: "Verify the deployment",
    body: "Deploying is a separate, explicit step. Afterwards `--check` confirms the API and delivery Worker answer before you trust them.",
  },
];

export function DeveloperSection({ config }: { config: SiteConfig }) {
  return (
    <section id="developers" className="developer-section section" data-reveal>
      <div className="content-width">
        <div className="section-header">
          <div>
            <p className="section-label">04 / Developer experience</p>
            <h2 className="section-title">
              From your first upload to your own player.
            </h2>
          </div>
          <p className="section-intro">
            Two halves: stand the platform up on infrastructure you control, then
            wire it into the product you are already building.
          </p>
        </div>

        {/* ── A. Start the platform ─────────────────────────────── */}
        <div className="developer-block">
          <h3 className="text-[19px] font-bold tracking-[-0.02em] sm:text-[22px]">
            Start the platform
          </h3>
          <p className="lede mt-3">
            Clone the repository and run the bootstrap wizard. It checks the
            toolchain, walks the configuration one decision at a time, and leaves
            deployment as a step you choose to run.
          </p>

          <div className="setup-grid">
            <div className="terminal">
              <div className="terminal-bar">
                <span>bash</span>
                <span>clipmux</span>
              </div>
              <div className="terminal-body">
                <div>
                  <span className="prompt">$ </span>
                  git clone https://github.com/visheshgubrani/vod.git
                </div>
                <div>
                  <span className="prompt">$ </span>cd vod
                </div>
                <div>
                  <span className="prompt">$ </span>./scripts/bootstrap.sh
                </div>
                <div className="comment">
                  # toolchain check, then the interactive wizard
                </div>
                <div>
                  <span className="prompt">$ </span>./scripts/bootstrap.sh --check
                </div>
                <div className="comment">
                  # verifies the configuration without printing secrets
                </div>
              </div>
            </div>

            <div className="setup-checklist">
              {checklist.map((item, index) => (
                <article key={item.title} className="checklist-item">
                  <span className="checklist-index" aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <h3>{item.title}</h3>
                    <p>{item.body}</p>
                  </div>
                </article>
              ))}

              <a
                className="inline-flex min-h-11 items-center gap-2 text-[15px] font-semibold text-[color:var(--brand)] hover:underline"
                href={config.quickstartUrl}
              >
                Read the quickstart
                <ArrowUpRight className="size-4" aria-hidden="true" />
              </a>
            </div>
          </div>
        </div>

        {/* ── B. Integrate the product ──────────────────────────── */}
        <div className="developer-block">
          <h3 className="text-[19px] font-bold tracking-[-0.02em] sm:text-[22px]">
            Integrate the product
          </h3>
          <p className="lede mt-3">
            Four steps, in the order you will need them. Each example is the same
            code the Next.js integration in the repository runs.
          </p>

          <CodeTabs />

          <p className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3 text-[15px]">
            <a
              className="inline-flex min-h-11 items-center gap-2 font-semibold text-[color:var(--brand)] hover:underline"
              href={config.docsUrl}
            >
              Full integration guides
              <ArrowUpRight className="size-4" aria-hidden="true" />
            </a>
            <a
              className="inline-flex min-h-11 items-center gap-2 font-semibold text-[color:var(--brand)] hover:underline"
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
