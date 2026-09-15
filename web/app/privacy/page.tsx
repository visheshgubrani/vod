import Link from "next/link";

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-[68ch] px-6 py-14 md:py-20">
        <header className="mb-12">
          <p className="mb-3 text-[13px] text-muted-foreground">
            Last updated: September 5, 2026
          </p>
          <h1 className="mb-3 text-3xl font-bold tracking-[-0.025em] text-foreground md:text-4xl">
            Privacy Policy
          </h1>
          <p className="text-[15px] leading-[1.7] text-muted-foreground md:text-base">
            Sample privacy text for a self-hosted ClipMux deployment. Replace
            this page with your organization&apos;s own policy before exposing a
            public dashboard. The operator of <em>this instance</em> (not the
            upstream ClipMux project) decides how data on their servers is
            handled.
          </p>
          <div className="mt-5 flex items-center gap-5 text-[15px]">
            <Link
              href="/terms"
              className="text-ember underline underline-offset-4 hover:text-ember-quiet"
            >
              Terms
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
            <h2 className="mb-2.5 text-xl font-semibold tracking-[-0.015em] text-foreground">1. Information collected</h2>
            <p>
              This instance may collect information you provide directly, such as
              account details, support requests, and uploaded media metadata. It
              may also collect technical usage data such as API logs, request
              timing, IP address, device/browser signals, and playback analytics
              events. ClipMux does not collect payment or billing details.
            </p>
          </section>

          <section>
            <h2 className="mb-2.5 text-xl font-semibold tracking-[-0.015em] text-foreground">2. How information is used</h2>
            <ul className="list-disc pl-5 space-y-2">
              <li>Operate and secure this ClipMux instance.</li>
              <li>Process uploads, transcoding, playback delivery, and usage metering.</li>
              <li>Respond to support requests and service communications.</li>
              <li>Improve reliability and performance of the deployment.</li>
              <li>Comply with legal obligations the operator is subject to.</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2.5 text-xl font-semibold tracking-[-0.015em] text-foreground">3. Legal bases</h2>
            <p>
              Where required, personal data is processed on the basis of contract
              performance, legitimate interests, consent, and legal compliance
              as determined by the operator of this instance.
            </p>
          </section>

          <section>
            <h2 className="mb-2.5 text-xl font-semibold tracking-[-0.015em] text-foreground">4. Data sharing</h2>
            <p>The operator may share information with:</p>
            <ul className="list-disc pl-5 space-y-2 mt-2">
              <li>
                Cloud infrastructure they configured (for example Cloudflare R2,
                Modal, and Postgres), solely to run the software.
              </li>
              <li>Professional advisors under confidentiality duties.</li>
              <li>Authorities where required by law, subpoena, or court order.</li>
            </ul>
            <p className="mt-2">
              Personal information is not sold. There is no payment processor
              in this software.
            </p>
          </section>

          <section>
            <h2 className="mb-2.5 text-xl font-semibold tracking-[-0.015em] text-foreground">5. Data retention</h2>
            <p>
              Data is retained as long as needed to operate the instance, satisfy
              legal requirements, resolve disputes, and enforce the operator&apos;s
              terms. You may request deletion of your account data from the
              operator, subject to legal retention requirements.
            </p>
          </section>

          <section>
            <h2 className="mb-2.5 text-xl font-semibold tracking-[-0.015em] text-foreground">6. Security</h2>
            <p>
              The operator should use administrative, technical, and
              organizational safeguards. No system is completely secure, and you
              are responsible for keeping account credentials confidential.
            </p>
          </section>

          <section>
            <h2 className="mb-2.5 text-xl font-semibold tracking-[-0.015em] text-foreground">7. Your rights</h2>
            <p>
              Depending on your location, you may have rights to access, correct,
              delete, restrict, or port your personal data, and to object to
              certain processing. Exercise those rights with the operator of
              this instance.
            </p>
          </section>

          <section>
            <h2 className="mb-2.5 text-xl font-semibold tracking-[-0.015em] text-foreground">8. International transfers</h2>
            <p>
              Information may be processed in countries other than your own,
              depending on where the operator hosts Postgres, R2, and Modal.
            </p>
          </section>

          <section>
            <h2 className="mb-2.5 text-xl font-semibold tracking-[-0.015em] text-foreground">9. Children&apos;s privacy</h2>
            <p>
              ClipMux is not directed to children under 13. Operators should not
              knowingly collect personal information from children under 13.
            </p>
          </section>

          <section>
            <h2 className="mb-2.5 text-xl font-semibold tracking-[-0.015em] text-foreground">10. Changes</h2>
            <p>
              The operator may update this policy. Material changes should be
              posted on this page with a revised effective date.
            </p>
          </section>

          <section>
            <h2 className="mb-2.5 text-xl font-semibold tracking-[-0.015em] text-foreground">11. Contact</h2>
            <p>
              For privacy questions about <em>this instance</em>, contact its
              operator. For the upstream project,{" "}
              <a
                href="mailto:privacy@clipmux.com"
                className="text-ember underline underline-offset-4 hover:text-ember-quiet"
              >
                privacy@clipmux.com
              </a>
              .
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
