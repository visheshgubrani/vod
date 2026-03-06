import Link from "next/link";

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="max-w-4xl mx-auto px-6 py-14 md:py-20">
        <header className="mb-10">
          <p className="text-sm text-muted-foreground mb-3">
            Last updated: March 6, 2026
          </p>
          <h1 className="text-3xl md:text-4xl font-bold mb-3">Privacy Policy</h1>
          <p className="text-muted-foreground">
            This Privacy Policy explains how ClipMux collects, uses, and protects
            personal information when you use our video infrastructure platform.
          </p>
          <div className="mt-4 flex items-center gap-4 text-sm">
            <Link href="/terms" className="text-primary hover:underline">
              Terms
            </Link>
            <Link href="/cookies" className="text-primary hover:underline">
              Cookies
            </Link>
          </div>
        </header>

        <div className="space-y-8 text-sm md:text-base leading-7 text-foreground/90">
          <section>
            <h2 className="text-xl font-semibold mb-2">1. Information We Collect</h2>
            <p>
              We collect information you provide directly, such as account
              details, billing details, support requests, and uploaded media
              metadata. We also collect technical usage data such as API logs,
              request timing, IP address, device/browser signals, and product
              analytics events.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">2. How We Use Information</h2>
            <ul className="list-disc pl-5 space-y-2">
              <li>Provide, operate, and secure the ClipMux services.</li>
              <li>Process uploads, transcoding, playback delivery, and analytics.</li>
              <li>Manage subscriptions, invoices, and fraud prevention.</li>
              <li>Respond to support requests and service communications.</li>
              <li>Improve reliability, performance, and product experience.</li>
              <li>Comply with legal obligations and enforce our terms.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">3. Legal Bases</h2>
            <p>
              Where required, we process personal data on the basis of contract
              performance, legitimate interests, consent, and legal compliance.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">4. Data Sharing</h2>
            <p>We may share information with:</p>
            <ul className="list-disc pl-5 space-y-2 mt-2">
              <li>Cloud infrastructure, payment, and support service providers.</li>
              <li>Professional advisors and auditors under confidentiality duties.</li>
              <li>Authorities where required by law, subpoena, or court order.</li>
              <li>
                Successor entities in connection with merger, acquisition, or sale.
              </li>
            </ul>
            <p className="mt-2">
              We do not sell personal information in the ordinary course of
              business.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">5. Data Retention</h2>
            <p>
              We retain data for as long as needed to provide the service,
              satisfy legal and accounting requirements, resolve disputes, and
              enforce agreements. You may request deletion of your account data,
              subject to legal retention requirements.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">6. Security</h2>
            <p>
              We use administrative, technical, and organizational safeguards to
              protect data. No system is completely secure, and you are
              responsible for maintaining the confidentiality of account
              credentials.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">7. Your Rights</h2>
            <p>
              Depending on your location, you may have rights to access, correct,
              delete, restrict, or port your personal data, and to object to
              certain processing. You may also have the right to withdraw consent
              where consent is used.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">8. International Transfers</h2>
            <p>
              Your information may be processed in countries other than your own.
              Where required, we use appropriate safeguards for cross-border data
              transfers.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">9. Children&apos;s Privacy</h2>
            <p>
              ClipMux is not directed to children under 13, and we do not
              knowingly collect personal information from children under 13.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">10. Changes to This Policy</h2>
            <p>
              We may update this policy from time to time. Material changes will
              be posted on this page with a revised effective date.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">11. Contact</h2>
            <p>
              For privacy questions or requests, contact{" "}
              <a
                href="mailto:privacy@clipmux.io"
                className="text-primary hover:underline"
              >
                privacy@clipmux.io
              </a>
              .
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
