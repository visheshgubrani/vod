import {
  ArrowUpRight,
} from "lucide-react";

import { BrandMark } from "@/components/brand-mark";
import { CodeTabs } from "@/components/code-tabs";
import { DemoPlayer } from "@/components/demo-player";
import { FaqList } from "@/components/faq-list";
import { MarketingMotion } from "@/components/marketing-motion";
import { SiteNav } from "@/components/site-nav";
import { buttonVariants } from "@/components/ui/button";
import { siteConfig } from "@/lib/site-config";
import { cn } from "@/lib/utils";

const workflowStages = [
  {
    number: "01",
    title: "Resumable upload",
    description: "Windowed multipart uploads go directly to your raw storage bucket.",
    artClass: "scene-art-upload",
    label: "PARTS / 04 / 04",
  },
  {
    number: "02",
    title: "Adaptive transcode",
    description: "FFmpeg and Shaka prepare playback-ready HLS and DASH renditions.",
    artClass: "scene-art-transcode",
    label: "ENCODING / 68%",
  },
  {
    number: "03",
    title: "Signed playback",
    description: "The delivery Worker verifies access and serves the right stream at the edge.",
    artClass: "scene-art-playback",
    label: "PLAYBACK / READY",
  },
] as const;

const faqs = [
  {
    question: "Is OpenVOD free software?",
    answer:
      "Yes. The application is Apache-2.0 licensed and self-hosting is the primary path. You pay the infrastructure providers you choose: storage, database, compute, and delivery usage.",
  },
  {
    question: "What does the platform include?",
    answer:
      "The open-source application covers direct-to-storage uploads, video lifecycle state, transcoding, HLS/DASH packaging, signed or public playback, a dashboard, webhooks, and SDKs for the integration boundary.",
  },
  {
    question: "What infrastructure does self-hosting need?",
    answer:
      "The current delivery contract uses Cloudflare R2 for raw and transcoded objects and a Cloudflare Worker in front of the transcoded bucket. You also need Postgres, an API runtime, and a transcode provider. The quickstart walks through the supported combinations.",
  },
  {
    question: "Can transcoding run somewhere I control?",
    answer:
      "Yes. Modal GPU transcoding is supported, and a self-hosted agent can run the same processing flow on infrastructure you operate. The choice is stored per job, so the playback contract stays the same.",
  },
  {
    question: "When will managed hosting be available?",
    answer:
      "Managed hosting is planned and not priced or dated yet. Join the waitlist to register interest; the same application and platform capabilities are the starting point.",
  },
  {
    question: "How do enterprise deployments work?",
    answer:
      "Enterprise conversations are for deployment requirements, onboarding, and operational support. Use the inquiry destination to describe your environment and what you need to run video reliably.",
  },
];

function SectionNumber({ children }: { children: string }) {
  return <span className="hairline-label">{children}</span>;
}

function SceneCard({ stage }: { stage: (typeof workflowStages)[number] }) {
  return (
    <article className="scene-card">
      <div className="scene-card-top">
        <span>{stage.number} / workflow</span>
        <strong>{stage.label}</strong>
      </div>
      <div className="scene-body">
        <h3>{stage.title}</h3>
        <p>{stage.description}</p>
        <div className={cn("scene-art", stage.artClass)} aria-hidden="true" />
      </div>
    </article>
  );
}

export default function Home() {
  return (
    <MarketingMotion>
      <SiteNav config={siteConfig} />

      <main id="top">
        <section className="hero text-center">
          <div className="content-width">
            <div className="eyebrow" data-hero-item>
              Open-source video infrastructure
            </div>
            <h1 className="hero-title" data-hero-item>
              Your video.
              <br />
              <span className="serif-italic text-violet">Your platform.</span>
            </h1>
            <p className="hero-copy" data-hero-item>
              Upload, transcode, and stream with a complete open-source video platform. Run it on infrastructure you control—or join the waitlist for managed hosting.
            </p>
            <div className="hero-actions" data-hero-item>
              <a className={cn(buttonVariants())} href={siteConfig.quickstartUrl}>
                Start self-hosting <ArrowUpRight className="size-4" />
              </a>
              <a className={cn(buttonVariants({ variant: "secondary" }))} href={siteConfig.managedFormUrl}>
                Join managed waitlist
              </a>
            </div>
            <p className="hero-note" data-hero-item>
              Complete platform. Apache-2.0. Infrastructure costs apply.
            </p>

            <div className="hero-frame-wrap" data-hero-item>
              <div className="product-frame hero-frame text-left">
                <div className="product-frame-bar">
                  <div className="product-frame-dots"><span /><span /><span /></div>
                  <span>OpenVOD / video library</span>
                  <span>demo workspace</span>
                </div>
                <div className="dashboard-shell">
                  <aside className="dashboard-sidebar" aria-hidden="true">
                    <div className="dashboard-sidebar-brand"><span>▶</span> OpenVOD</div>
                    <div className="dashboard-sidebar-nav">
                      <div className="active">Library</div>
                      <div>Analytics</div>
                      <div>Webhooks</div>
                      <div>API keys</div>
                      <div>Settings</div>
                    </div>
                  </aside>
                  <div className="dashboard-main">
                    <div className="dashboard-heading">
                      <div>
                        <h3>Video library</h3>
                        <p>2 assets / updated just now</p>
                      </div>
                      <span className="dashboard-status">all systems ready</span>
                    </div>
                    <div className="dashboard-video-card">
                      <div className="dashboard-video-poster"><span>The quiet<br />frame</span></div>
                      <div className="dashboard-video-details">
                        <div>
                          <h4>the-quiet-frame.mp4</h4>
                          <p>ready · 00:42 · 1080p source</p>
                          <ul>
                            <li><span>HLS</span><span>ready</span></li>
                            <li><span>DASH</span><span>ready</span></li>
                            <li><span>Poster</span><span>generated</span></li>
                          </ul>
                        </div>
                        <p>last playback 00:12 ago</p>
                      </div>
                    </div>
                    <div className="dashboard-metrics">
                      <div className="dashboard-metric"><span>assets</span><strong>02</strong></div>
                      <div className="dashboard-metric"><span>bandwidth</span><strong>1.8 GB</strong></div>
                      <div className="dashboard-metric"><span>webhooks</span><strong>99.9%</strong></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="product" className="section-tight" data-reveal>
          <div className="content-width">
            <div className="section-header">
              <div>
                <SectionNumber>01 / product walkthrough</SectionNumber>
                <h2 className="section-title">A video platform that stays close to the metal.</h2>
              </div>
              <p className="section-intro">Bring the developer experience of a hosted platform to the accounts, buckets, and compute you already understand.</p>
            </div>

            <div className="product-frame overflow-hidden">
              <div className="product-frame-bar">
                <div className="product-frame-dots"><span /><span /><span /></div>
                <span>product walkthrough / seeded demo data</span>
                <span>00:42</span>
              </div>
              <div className="grid md:grid-cols-[1.4fr_.6fr]">
                <DemoPlayer poster="/poster-dashboard.svg" src={siteConfig.walkthroughVideoUrl} />
                <div className="flex flex-col justify-between border-t border-white/10 p-6 md:border-l md:border-t-0 md:p-8">
                  <div>
                    <span className="eyebrow !text-[#bca7ee]">Playback ready</span>
                    <h3 className="mt-5 text-2xl font-bold tracking-[-0.07em] text-white">From raw file to a stream your product can own.</h3>
                    <p className="mt-4 text-sm leading-7 text-white/50">A calm control plane for the parts of video that should be boring: ingest, processing state, access, and delivery.</p>
                  </div>
                  <div className="mt-10 border-t border-white/10 pt-5 font-mono text-[10px] uppercase tracking-[0.12em] text-white/40">
                    <div className="flex justify-between"><span>asset</span><span className="text-white/75">the-quiet-frame</span></div>
                    <div className="mt-3 flex justify-between"><span>delivery</span><span className="text-[#bca7ee]">signed / edge</span></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="workflow" className="workflow-section workflow-section overflow-hidden">
          <div className="content-width workflow-sticky">
            <div className="workflow-copy">
              <SectionNumber>02 / the flow</SectionNumber>
              <h2>From upload to playback.</h2>
              <p>One connected path from a file in your product to a protected stream in your player.</p>
              <div className="workflow-list">
                {workflowStages.map((stage) => (
                  <div key={stage.number} className="workflow-list-item">
                    <span className="workflow-list-number">{stage.number}</span>
                    <div><strong>{stage.title}</strong><p>{stage.description}</p></div>
                  </div>
                ))}
              </div>
            </div>
            <div className="workflow-visual" aria-hidden="true">
              <div className="workflow-progress-rail"><div className="workflow-progress" /></div>
              <div className="workflow-scenes">
                {workflowStages.map((stage) => <div key={stage.number} className="workflow-scene" data-workflow-scene><SceneCard stage={stage} /></div>)}
              </div>
            </div>
          </div>
          <div className="content-width workflow-mobile-stages">
            {workflowStages.map((stage) => (
              <article key={stage.number} className="workflow-mobile-stage" data-reveal>
                <div className="flex items-center justify-between"><span className="workflow-list-number">{stage.number}</span><span className="hairline-label">{stage.label}</span></div>
                <h3 className="mt-5 text-2xl font-bold tracking-[-0.07em]">{stage.title}</h3>
                <p className="mt-2 text-sm leading-7 text-muted">{stage.description}</p>
                <div className={cn("scene-art", stage.artClass)} aria-hidden="true" />
              </article>
            ))}
          </div>
        </section>

        <section id="capabilities" className="section" data-reveal>
          <div className="content-width">
            <div className="section-header">
              <div>
                <SectionNumber>03 / the platform</SectionNumber>
                <h2 className="section-title">Everything your video product needs.</h2>
              </div>
              <p className="section-intro">Keep your library, playback rules, and event stream in one place—then expose the experience through your own interface.</p>
            </div>
            <div className="capability-grid">
              <article className="capability-panel tall">
                <div className="capability-copy"><h3>Library management</h3><p>Know which assets are uploading, processing, ready, or failed. Keep the operational state visible.</p></div>
                <div className="library-art" aria-hidden="true">
                  <div className="library-list"><span className="active">All videos</span><span>Processing</span><span>Ready</span><span>Failed</span></div>
                  <div className="library-preview" />
                </div>
              </article>
              <div className="capability-side-stack">
                <article className="capability-panel">
                  <div className="capability-copy"><h3>Playback controls</h3><p>Public or signed playback, with tokens your backend can mint for a viewer.</p></div>
                  <div className="side-rows"><div className="side-row"><span>policy</span><strong>signed</strong></div><div className="side-row"><span>token</span><strong className="green">valid · 14m</strong></div><div className="side-row"><span>delivery</span><strong>edge worker</strong></div></div>
                </article>
                <article className="capability-panel dark">
                  <div className="capability-copy"><h3>Webhooks + usage</h3><p>Connect video events to your product and see the delivery surface that matters.</p></div>
                  <div className="webhook-art" aria-hidden="true" />
                </article>
              </div>
            </div>
          </div>
        </section>

        <section id="developers" className="section developer-section" data-reveal>
          <div className="content-width developer-grid">
            <div className="developer-copy">
              <SectionNumber>04 / developer experience</SectionNumber>
              <h2>Video belongs in your product.</h2>
              <p>Use the SDKs where they help, keep your backend in charge, and ship a player that feels like the rest of your application.</p>
              <a href={siteConfig.docsUrl}>Read the integration docs <ArrowUpRight className="size-4" /></a>
            </div>
            <CodeTabs />
          </div>
        </section>

        <section id="hosting" className="section hosting-section" data-reveal>
          <div className="content-width">
            <div className="section-header">
              <div>
                <SectionNumber>05 / hosting choices</SectionNumber>
                <h2 className="section-title">One complete platform. Choose who runs it.</h2>
              </div>
              <p className="section-intro">Self-host the full application today, register interest in managed operations, or talk through a deployment that needs more care.</p>
            </div>
            <div className="hosting-grid">
              <article className="hosting-card">
                <span className="price-label">Free software</span>
                <h3>Self-hosted</h3>
                <p>The complete OpenVOD application, running on accounts and infrastructure you control.</p>
                <ul><li>Apache-2.0 application</li><li>R2 + delivery Worker</li><li>Community resources</li></ul>
                <div className="card-action"><a className={cn(buttonVariants({ className: "w-full" }))} href={siteConfig.quickstartUrl}>Start self-hosting <ArrowUpRight className="size-4" /></a></div>
              </article>
              <article className="hosting-card featured">
                <span className="price-label">Planned / no date yet</span>
                <h3>Managed</h3>
                <p>OpenVOD hosting and operations, for teams that want the same platform without running every service.</p>
                <ul><li>Same platform foundation</li><li>Operations by OpenVOD</li><li>Join interest list</li></ul>
                <div className="card-action"><a className={cn(buttonVariants({ variant: "secondary", className: "w-full" }))} href={siteConfig.managedFormUrl}>Join managed waitlist</a></div>
              </article>
              <article className="hosting-card">
                <span className="price-label">Deployment conversation</span>
                <h3>Enterprise</h3>
                <p>Discuss deployment requirements, onboarding, and operational support around your environment.</p>
                <ul><li>Architecture conversation</li><li>Onboarding requirements</li><li>Support discussion</li></ul>
                <div className="card-action"><a className={cn(buttonVariants({ variant: "secondary", className: "w-full" }))} href={siteConfig.enterpriseFormUrl}>Discuss your deployment <ArrowUpRight className="size-4" /></a></div>
              </article>
            </div>
          </div>
        </section>

        <section className="faq-section" data-reveal>
          <div className="content-width faq-layout">
            <div>
              <SectionNumber>06 / questions</SectionNumber>
              <h2>Clear answers before the first frame.</h2>
            </div>
            <FaqList items={faqs} />
          </div>
        </section>
      </main>

      <footer className="closing-section">
        <div className="content-width closing-inner">
          <h2>Build something <em>worth watching.</em></h2>
          <p>Start with the complete open-source platform. Let the infrastructure stay yours, and let the product be the thing people remember.</p>
          <div className="closing-actions">
            <a className={cn(buttonVariants({ variant: "light" }))} href={siteConfig.quickstartUrl}>Start self-hosting <ArrowUpRight className="size-4" /></a>
            <a className="inline-flex h-12 items-center gap-2 rounded-[10px] border border-white/25 px-5 text-sm font-semibold text-paper transition duration-200 hover:border-white hover:bg-white/10" href={siteConfig.managedFormUrl}>Join managed waitlist</a>
          </div>
          <div className="footer">
            <div>
              <div className="footer-brand"><BrandMark invert className="size-7" /> OpenVOD</div>
              <small className="mt-3 block">Open-source video infrastructure · Apache-2.0</small>
            </div>
            <nav className="footer-links" aria-label="Footer navigation">
              <a href={siteConfig.docsUrl}>Docs</a>
              <a href={siteConfig.githubUrl} target="_blank" rel="noreferrer">GitHub</a>
              <a href="https://www.apache.org/licenses/LICENSE-2.0" target="_blank" rel="noreferrer">License</a>
              <a href={siteConfig.privacyUrl}>Privacy</a>
            </nav>
          </div>
        </div>
      </footer>
    </MarketingMotion>
  );
}
