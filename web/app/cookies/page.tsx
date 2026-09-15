import Link from "next/link";

export default function CookiesPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-[68ch] px-6 py-14 md:py-20">
        <header className="mb-12">
          <p className="mb-3 text-[13px] text-muted-foreground">
            Last updated: September 5, 2026
          </p>
          <h1 className="mb-3 text-3xl font-bold tracking-[-0.025em] text-foreground md:text-4xl">
            Cookie Policy
          </h1>
          <p className="text-[15px] leading-[1.7] text-muted-foreground md:text-base">
            This Cookie Policy explains how ClipMux uses cookies and similar
            technologies on our website and product surfaces.
          </p>
          <div className="mt-5 flex items-center gap-5 text-[15px]">
            <Link
              href="/privacy"
              className="text-ember underline underline-offset-4 hover:text-ember-quiet"
            >
              Privacy
            </Link>
            <Link
              href="/terms"
              className="text-ember underline underline-offset-4 hover:text-ember-quiet"
            >
              Terms
            </Link>
          </div>
        </header>

        <div className="space-y-10 text-[15px] leading-[1.75] text-foreground/90 md:text-base">
          <section>
            <h2 className="mb-2.5 text-xl font-semibold tracking-[-0.015em] text-foreground">1. What Are Cookies</h2>
            <p>
              Cookies are small text files stored on your device to help websites
              and applications function, remember preferences, and analyze usage.
            </p>
          </section>

          <section>
            <h2 className="mb-2.5 text-xl font-semibold tracking-[-0.015em] text-foreground">2. How We Use Cookies</h2>
            <p>ClipMux uses cookies and similar technologies to:</p>
            <ul className="list-disc pl-5 mt-2 space-y-2">
              <li>Keep you signed in and maintain session security.</li>
              <li>Remember account and interface preferences.</li>
              <li>Measure product performance and reliability.</li>
              <li>Understand usage trends and improve user experience.</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2.5 text-xl font-semibold tracking-[-0.015em] text-foreground">3. Cookie Categories</h2>
            <ul className="list-disc pl-5 space-y-2">
              <li>
                <strong>Strictly Necessary:</strong> Required for authentication,
                security, and core platform functionality.
              </li>
              <li>
                <strong>Functional:</strong> Store preferences such as language or
                display settings.
              </li>
              <li>
                <strong>Analytics:</strong> Help us understand feature usage,
                performance, and error rates.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2.5 text-xl font-semibold tracking-[-0.015em] text-foreground">4. Third-Party Cookies</h2>
            <p>
              Some third-party services the operator integrated (for example
              auth or analytics) may set cookies. Their cookie use is governed
              by their own policies. This software does not include a payment
              processor.
            </p>
          </section>

          <section>
            <h2 className="mb-2.5 text-xl font-semibold tracking-[-0.015em] text-foreground">5. Managing Cookies</h2>
            <p>
              You can control cookies through your browser settings, including
              blocking or deleting existing cookies. Some core features may not
              work properly if strictly necessary cookies are disabled.
            </p>
          </section>

          <section>
            <h2 className="mb-2.5 text-xl font-semibold tracking-[-0.015em] text-foreground">6. Retention</h2>
            <p>
              Cookies may be session-based (deleted when the browser closes) or
              persistent (stored for a fixed period), depending on their purpose.
            </p>
          </section>

          <section>
            <h2 className="mb-2.5 text-xl font-semibold tracking-[-0.015em] text-foreground">7. Policy Updates</h2>
            <p>
              We may update this Cookie Policy from time to time to reflect legal,
              technical, or product changes.
            </p>
          </section>

          <section>
            <h2 className="mb-2.5 text-xl font-semibold tracking-[-0.015em] text-foreground">8. Contact</h2>
            <p>
              For questions about cookie use, contact{" "}
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
