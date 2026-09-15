import { FaqList } from "@/components/faq-list";
import { MarketingMotion } from "@/components/marketing-motion";
import { ClosingSection } from "@/components/sections/closing";
import { DeveloperSection } from "@/components/sections/developer";
import { HeroSection } from "@/components/sections/hero";
import { HostingSection } from "@/components/sections/hosting";
import { OwnershipSection } from "@/components/sections/ownership";
import { PlatformSection } from "@/components/sections/platform";
import { WorkflowSection } from "@/components/sections/workflow";
import { SiteNav } from "@/components/site-nav";
import { siteConfig } from "@/lib/site-config";

const faqs = [
  {
    question: "What do I actually have to run?",
    answer:
      "Four things, and you choose the shape of each. Storage: a Cloudflare R2 bucket for raw uploads and a second for transcoded output. State: Postgres. Compute: the API runtime, which is the same Hono app on Node or on Cloudflare Workers, plus the delivery Worker that serves media. Transcoding: Modal, or a self-hosted agent on machines you already have. The bootstrap wizard checks each requirement before it writes any configuration.",
  },
  {
    question: "Who owns the video files?",
    answer:
      "You do, in the most literal sense: the bytes live in your R2 buckets, under your account, readable with your credentials. ClipMux stores object keys and the video lifecycle state in Postgres. If you stop running the platform tomorrow, the originals and every transcoded rendition are still there.",
  },
  {
    question: "How does signed playback work?",
    answer:
      "Per video, playback is either public or signed. For signed videos your backend calls the API to mint a short-lived token bound to that viewer, and the delivery Worker verifies the token on every manifest and segment request. The player can refresh the token in place so a long session is not interrupted. Your API key stays on your server; the browser only ever receives a token scoped to one viewer.",
  },
  {
    question: "Can I transcode on my own hardware?",
    answer:
      "Yes. Modal GPU runners are the default and need no machines of your own. The self-hosted agent runs the same processing engine on hardware you operate and authenticates with an organization-scoped token — it holds no storage credentials, because transfers are presigned per artifact. The provider is recorded per job, so switching does not change how playback works.",
  },
  {
    question: "What does it cost?",
    answer:
      "The software is Apache-2.0 and free. You pay your infrastructure providers directly: storage and egress for R2, your Postgres host, whatever runs the API, and GPU time for transcoding. ClipMux adds no licence fee and no per-minute charge on top, and it reports the storage and bandwidth it measured so you can reconcile it against your own bills.",
  },
  {
    question: "Is managed hosting available?",
    answer:
      "Not yet. Managed hosting is planned with no date and no published price, so the interest list is a way to register a preference rather than a waitlist for something you can buy. Self-hosting is the supported path today and runs the same application.",
  },
];

export default function Home() {
  return (
    <MarketingMotion>
      <SiteNav config={siteConfig} />

      <main id="top">
        <HeroSection config={siteConfig} />
        <OwnershipSection />
        <WorkflowSection />
        <PlatformSection />
        <DeveloperSection config={siteConfig} />
        <HostingSection config={siteConfig} />

        <section id="faq" className="faq-section" data-reveal>
          <div className="content-width faq-layout">
            <div>
              <p className="section-label">06 / Questions</p>
              <h2 className="section-title">Clear answers before the first frame.</h2>
            </div>
            <FaqList items={faqs} />
          </div>
        </section>
      </main>

      <ClosingSection config={siteConfig} />
    </MarketingMotion>
  );
}
