import Link from "next/link";
import Image from "next/image";

interface AuthLayoutProps {
  children: React.ReactNode;
  title: string;
  subtitle: string;
  topLink?: React.ReactNode;
}

/**
 * Shell for every signed-out form surface: a calm charcoal page, the brand
 * mark, then the form on a single `bg-panel` card. No gradient washes — the
 * only accent is the burnt-orange brand fill inside the form itself.
 */
export function AuthLayout({
  children,
  title,
  subtitle,
  topLink,
}: AuthLayoutProps) {
  return (
    <div className="min-h-screen bg-background">
      <div className="flex min-h-screen items-center justify-center px-5 py-12 sm:px-6 lg:py-16">
        <div className="w-full max-w-lg">
          {/* Brand mark */}
          <div className="mb-8 flex justify-center">
            <Link
              href="/"
              className="flex items-center gap-2.5 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <Image
                src="/logo.svg"
                alt="ClipMux logo"
                width={36}
                height={36}
                className="h-8 w-auto"
                priority
              />
              <span className="text-[17px] font-semibold tracking-[-0.02em] text-foreground">
                ClipMux
              </span>
            </Link>
          </div>

          {/* Header */}
          <div className="mb-8 text-center">
            <h1 className="dash-title text-foreground">{title}</h1>
            <p className="dash-body mt-2 text-muted-foreground">{subtitle}</p>
            {topLink && (
              <div className="dash-body mt-3 text-muted-foreground">
                {topLink}
              </div>
            )}
          </div>

          {/* Form content */}
          <div className="dash-panel p-5 sm:p-6 md:p-8">{children}</div>
        </div>
      </div>
    </div>
  );
}
