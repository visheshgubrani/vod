import Link from "next/link";

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-[68ch] px-6 py-14 md:py-20">
        <header className="mb-12">
          <p className="mb-3 text-[13px] text-muted-foreground">
            Last updated: September 5, 2026
          </p>
          <h1 className="mb-3 text-3xl font-bold tracking-[-0.025em] text-foreground md:text-4xl">
            Terms of Service
          </h1>
          <p className="text-[15px] leading-[1.7] text-muted-foreground md:text-base">
            Sample terms for a self-hosted ClipMux deployment. Replace this page
            with your organization&apos;s own terms before exposing a public
            dashboard. The software is licensed under Apache-2.0; these Terms
            only describe how <em>your</em> instance is used.
          </p>
          <div className="mt-5 flex items-center gap-5 text-[15px]">
            <Link
              href="/privacy"
              className="text-ember underline underline-offset-4 hover:text-ember-quiet"
            >
              Privacy
            </Link>
            <Link
              href="/cookies"
              className="text-ember underline underline-offset-4 hover:text-ember-quiet"
            >
              Cookies
            </Link>
          </div>
        </header>

        <div className="space-y-10 text-[15px] leading-[1.75] text-foreground/90 md:text-base">
          <section>
            <h2 className="mb-2.5 text-xl font-semibold tracking-[-0.015em] text-foreground">1. Acceptance of Terms</h2>
            <p>
              By using this ClipMux instance, you agree to these Terms. If you
              use it on behalf of an organization, you represent that you have
              authority to bind that organization.
            </p>
          </section>

          <section>
            <h2 className="mb-2.5 text-xl font-semibold tracking-[-0.015em] text-foreground">2. Eligibility and Accounts</h2>
            <p>
              You must provide accurate registration information and keep your
              credentials secure. You are responsible for activity under your
              account.
            </p>
          </section>

          <section>
            <h2 className="mb-2.5 text-xl font-semibold tracking-[-0.015em] text-foreground">3. Service Use</h2>
            <p>
              ClipMux provides tools for video upload, processing, storage,
              delivery, and usage analytics on infrastructure the operator
              controls (Cloudflare R2, Modal, Postgres). Features may evolve.
            </p>
          </section>

          <section>
            <h2 className="mb-2.5 text-xl font-semibold tracking-[-0.015em] text-foreground">4. Customer Content</h2>
            <p>
              You retain ownership of your content. You grant the operator of
              this instance a limited license to host, process, transmit, and
              display content solely to run the software.
            </p>
          </section>

          <section>
            <h2 className="mb-2.5 text-xl font-semibold tracking-[-0.015em] text-foreground">5. Acceptable Use</h2>
            <p>You agree not to:</p>
            <ul className="list-disc pl-5 mt-2 space-y-2">
              <li>Use the service for unlawful, infringing, or abusive content.</li>
              <li>Attempt unauthorized access, scraping, or service disruption.</li>
              <li>Bypass limits, reverse engineer protected systems, or misuse APIs.</li>
              <li>Upload malware or content that threatens platform security.</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2.5 text-xl font-semibold tracking-[-0.015em] text-foreground">6. Infrastructure costs</h2>
            <p>
              ClipMux is open-source software. This instance does not sell paid
              plans or process payments. Storage, bandwidth, GPU transcoding,
              and related cloud costs are billed by the providers whose keys
              the operator configured (for example Cloudflare and Modal).
            </p>
          </section>

          <section>
            <h2 className="mb-2.5 text-xl font-semibold tracking-[-0.015em] text-foreground">7. Intellectual Property</h2>
            <p>
              The ClipMux software is licensed under Apache-2.0. Trademarks and
              this instance&apos;s branding remain with their owners. These Terms
              do not grant ownership of the software.
            </p>
          </section>

          <section>
            <h2 className="mb-2.5 text-xl font-semibold tracking-[-0.015em] text-foreground">8. Suspension and Termination</h2>
            <p>
              The operator may suspend or terminate access for violations, legal
              risk, or security concerns. You may stop using the service at any
              time.
            </p>
          </section>

          <section>
            <h2 className="mb-2.5 text-xl font-semibold tracking-[-0.015em] text-foreground">9. Disclaimers</h2>
            <p>
              The software is provided on an &quot;as is&quot; and &quot;as available&quot;
              basis. To the fullest extent permitted by law, implied warranties
              including merchantability, fitness for a particular purpose, and
              non-infringement are disclaimed.
            </p>
          </section>

          <section>
            <h2 className="mb-2.5 text-xl font-semibold tracking-[-0.015em] text-foreground">10. Limitation of Liability</h2>
            <p>
              To the maximum extent permitted by law, the operator is not liable
              for indirect, incidental, special, consequential, or punitive
              damages, or loss of profits, revenue, data, or goodwill.
            </p>
          </section>

          <section>
            <h2 className="mb-2.5 text-xl font-semibold tracking-[-0.015em] text-foreground">11. Indemnification</h2>
            <p>
              You agree to indemnify and hold the operator harmless from claims,
              liabilities, and expenses arising from your content, use of the
              service, or violation of these Terms.
            </p>
          </section>

          <section>
            <h2 className="mb-2.5 text-xl font-semibold tracking-[-0.015em] text-foreground">12. Governing Law</h2>
            <p>
              These Terms are governed by the laws of the jurisdiction chosen by
              the operator of this instance.
            </p>
          </section>

          <section>
            <h2 className="mb-2.5 text-xl font-semibold tracking-[-0.015em] text-foreground">13. Changes to Terms</h2>
            <p>
              The operator may update these Terms. Continued use after updates
              means you accept the revised Terms.
            </p>
          </section>

          <section>
            <h2 className="mb-2.5 text-xl font-semibold tracking-[-0.015em] text-foreground">14. Contact</h2>
            <p>
              Questions about these sample Terms can be sent to the operator of
              this instance, or to{" "}
              <a
                href="mailto:legal@clipmux.com"
                className="text-ember underline underline-offset-4 hover:text-ember-quiet"
              >
                legal@clipmux.com
              </a>{" "}
              for the upstream project.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
