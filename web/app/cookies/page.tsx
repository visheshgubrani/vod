import Link from "next/link";

export default function CookiesPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="max-w-4xl mx-auto px-6 py-14 md:py-20">
        <header className="mb-10">
          <p className="text-sm text-muted-foreground mb-3">
            Last updated: September 5, 2026
          </p>
          <h1 className="text-3xl md:text-4xl font-bold mb-3">Cookie Policy</h1>
          <p className="text-muted-foreground">
            This Cookie Policy explains how OpenVOD uses cookies and similar
            technologies on our website and product surfaces.
          </p>
          <div className="mt-4 flex items-center gap-4 text-sm">
            <Link href="/privacy" className="text-primary hover:underline">
              Privacy
            </Link>
            <Link href="/terms" className="text-primary hover:underline">
              Terms
            </Link>
          </div>
        </header>

        <div className="space-y-8 text-sm md:text-base leading-7 text-foreground/90">
          <section>
            <h2 className="text-xl font-semibold mb-2">1. What Are Cookies</h2>
            <p>
              Cookies are small text files stored on your device to help websites
              and applications function, remember preferences, and analyze usage.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">2. How We Use Cookies</h2>
            <p>OpenVOD uses cookies and similar technologies to:</p>
            <ul className="list-disc pl-5 mt-2 space-y-2">
              <li>Keep you signed in and maintain session security.</li>
              <li>Remember account and interface preferences.</li>
              <li>Measure product performance and reliability.</li>
              <li>Understand usage trends and improve user experience.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">3. Cookie Categories</h2>
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
            <h2 className="text-xl font-semibold mb-2">4. Third-Party Cookies</h2>
            <p>
              Some third-party services the operator integrated (for example
              auth or analytics) may set cookies. Their cookie use is governed
              by their own policies. This software does not include a payment
              processor.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">5. Managing Cookies</h2>
            <p>
              You can control cookies through your browser settings, including
              blocking or deleting existing cookies. Some core features may not
              work properly if strictly necessary cookies are disabled.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">6. Retention</h2>
            <p>
              Cookies may be session-based (deleted when the browser closes) or
              persistent (stored for a fixed period), depending on their purpose.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">7. Policy Updates</h2>
            <p>
              We may update this Cookie Policy from time to time to reflect legal,
              technical, or product changes.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-2">8. Contact</h2>
            <p>
              For questions about cookie use, contact{" "}
              <a
                href="mailto:privacy@openvod.dev"
                className="text-primary hover:underline"
              >
                privacy@openvod.dev
              </a>
              .
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
