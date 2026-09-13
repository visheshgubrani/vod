import Link from "next/link";

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="max-w-4xl mx-auto px-6 py-14 md:py-20">
        <header className="mb-10">
          <p className="text-sm text-muted-foreground mb-3">
            Last updated: September 5, 2026
          </p>
          <h1 className="text-3xl md:text-4xl font-bold mb-3">Terms of Service</h1>
          <p className="text-muted-foreground">
            Sample terms for a self-hosted OpenVOD deployment. Replace this page
            with your organization&apos;s own terms before exposing a public
            dashboard. The software is licensed under Apache-2.0; these Terms
            only describe how <em>your</em> instance is used.
          </p>
          <div className="mt-4 flex items-center gap-4 text-sm">
            <Link href="/privacy" className="text-primary hover:underline">
              Privacy
            </Link>
            <Link href="/cookies" className="text-primary hover:underline">
              Cookies
            </Link>
          </div>
        </header>

        <div className="space-y-8 text-sm md:text-base leading-7 text-foreground/90">
          <section>
            <h2 className="text-xl font-semibold mb-2">1. Acceptance of Terms</h2>
            <p>
              By using this OpenVOD instance, you agree to these Terms. If you
              use it on behalf of an organization, you represent that you have
              authority to bind that organization.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">2. Eligibility and Accounts</h2>
            <p>
              You must provide accurate registration information and keep your
              credentials secure. You are responsible for activity under your
              account.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">3. Service Use</h2>
            <p>
              OpenVOD provides tools for video upload, processing, storage,
              delivery, and usage analytics on infrastructure the operator
              controls (Cloudflare R2, Modal, Postgres). Features may evolve.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">4. Customer Content</h2>
            <p>
              You retain ownership of your content. You grant the operator of
              this instance a limited license to host, process, transmit, and
              display content solely to run the software.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">5. Acceptable Use</h2>
            <p>You agree not to:</p>
            <ul className="list-disc pl-5 mt-2 space-y-2">
              <li>Use the service for unlawful, infringing, or abusive content.</li>
              <li>Attempt unauthorized access, scraping, or service disruption.</li>
              <li>Bypass limits, reverse engineer protected systems, or misuse APIs.</li>
              <li>Upload malware or content that threatens platform security.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">6. Infrastructure costs</h2>
            <p>
              OpenVOD is open-source software. This instance does not sell paid
              plans or process payments. Storage, bandwidth, GPU transcoding,
              and related cloud costs are billed by the providers whose keys
              the operator configured (for example Cloudflare and Modal).
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">7. Intellectual Property</h2>
            <p>
              The OpenVOD software is licensed under Apache-2.0. Trademarks and
              this instance&apos;s branding remain with their owners. These Terms
              do not grant ownership of the software.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">8. Suspension and Termination</h2>
            <p>
              The operator may suspend or terminate access for violations, legal
              risk, or security concerns. You may stop using the service at any
              time.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">9. Disclaimers</h2>
            <p>
              The software is provided on an &quot;as is&quot; and &quot;as available&quot;
              basis. To the fullest extent permitted by law, implied warranties
              including merchantability, fitness for a particular purpose, and
              non-infringement are disclaimed.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">10. Limitation of Liability</h2>
            <p>
              To the maximum extent permitted by law, the operator is not liable
              for indirect, incidental, special, consequential, or punitive
              damages, or loss of profits, revenue, data, or goodwill.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">11. Indemnification</h2>
            <p>
              You agree to indemnify and hold the operator harmless from claims,
              liabilities, and expenses arising from your content, use of the
              service, or violation of these Terms.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">12. Governing Law</h2>
            <p>
              These Terms are governed by the laws of the jurisdiction chosen by
              the operator of this instance.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">13. Changes to Terms</h2>
            <p>
              The operator may update these Terms. Continued use after updates
              means you accept the revised Terms.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">14. Contact</h2>
            <p>
              Questions about these sample Terms can be sent to the operator of
              this instance, or to{" "}
              <a
                href="mailto:legal@openvod.dev"
                className="text-primary hover:underline"
              >
                legal@openvod.dev
              </a>{" "}
              for the upstream project.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
