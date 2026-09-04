import Link from "next/link";

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="max-w-4xl mx-auto px-6 py-14 md:py-20">
        <header className="mb-10">
          <p className="text-sm text-muted-foreground mb-3">
            Last updated: March 6, 2026
          </p>
          <h1 className="text-3xl md:text-4xl font-bold mb-3">Terms of Service</h1>
          <p className="text-muted-foreground">
            These Terms govern your access to and use of the OpenVOD platform,
            APIs, dashboard, and related services.
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
              By using OpenVOD, you agree to these Terms. If you use OpenVOD on
              behalf of an organization, you represent that you have authority to
              bind that organization.
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
              delivery, and analytics. Service features may evolve, and we may
              add, modify, or discontinue features.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">4. Customer Content</h2>
            <p>
              You retain ownership of your content. You grant OpenVOD a limited
              license to host, process, transmit, and display content solely to
              provide the service.
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
            <h2 className="text-xl font-semibold mb-2">6. Fees and Billing</h2>
            <p>
              Paid plans are billed according to your selected pricing terms and
              usage. You authorize us and our payment processors to charge
              applicable fees, taxes, and renewals.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">7. Intellectual Property</h2>
            <p>
              OpenVOD and its software, marks, and documentation are owned by
              OpenVOD or its licensors. These Terms do not grant ownership rights
              in OpenVOD IP.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">8. Suspension and Termination</h2>
            <p>
              We may suspend or terminate access for violations, legal risk,
              security concerns, or non-payment. You may stop using the service at
              any time.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">9. Disclaimers</h2>
            <p>
              The service is provided on an &quot;as is&quot; and &quot;as available&quot;
              basis. To the fullest extent permitted by law, we disclaim implied
              warranties including merchantability, fitness for a particular
              purpose, and non-infringement.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">10. Limitation of Liability</h2>
            <p>
              To the maximum extent permitted by law, OpenVOD is not liable for
              indirect, incidental, special, consequential, or punitive damages,
              or loss of profits, revenue, data, or goodwill.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">11. Indemnification</h2>
            <p>
              You agree to indemnify and hold OpenVOD harmless from claims,
              liabilities, and expenses arising from your content, use of the
              service, or violation of these Terms.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">12. Governing Law</h2>
            <p>
              These Terms are governed by applicable laws in the jurisdiction
              specified in your service agreement or, if none, the laws where
              OpenVOD is established.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">13. Changes to Terms</h2>
            <p>
              We may update these Terms periodically. Continued use of the service
              after updates means you accept the revised Terms.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">14. Contact</h2>
            <p>
              Questions about these Terms can be sent to{" "}
              <a
                href="mailto:legal@openvod.dev"
                className="text-primary hover:underline"
              >
                legal@openvod.dev
              </a>
              .
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
