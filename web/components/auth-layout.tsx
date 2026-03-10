import Link from "next/link";
import Image from "next/image";

interface AuthLayoutProps {
  children: React.ReactNode;
  title: string;
  subtitle: string;
  topLink?: React.ReactNode;
}

export function AuthLayout({
  children,
  title,
  subtitle,
  topLink,
}: AuthLayoutProps) {
  return (
    <div className="relative min-h-screen overflow-hidden bg-mauve-900/40">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 hidden lg:block h-72 bg-top bg-cover opacity-20"
        style={{ backgroundImage: "url('/images/boxes.svg')" }}
      />

      <div className="relative z-10 flex min-h-screen items-center justify-center p-6 lg:p-10">
        <div className="w-full max-w-xl">
          {/* Top Logo */}
          <div className="mb-2">
            <Link href="/" className="flex items-center gap-1.5 justify-center">
              <Image
                src="/logo.svg"
                alt="ClipMux logo"
                width={36}
                height={36}
                className="h-8 w-auto"
                priority
              />
              <span className="text-2xl tracking-wider text-purple-200 font-dashboard-heading">
                ClipMux
              </span>
            </Link>
          </div>

          {/* Header */}
          <div className="text-center mt-6 mb-10">
            <h2 className="text-2xl font-medium mb-2">{title}</h2>
            <p className="text-muted-foreground">{subtitle}</p>
            {topLink && (
              <div className="mt-3 text-sm text-muted-foreground">
                {topLink}
              </div>
            )}
          </div>

          {/* Form Content */}
          <div className="rounded-xl p-4 md:p-8 bg-accent/10 border border-mauve-600/20 backdrop-blur-sm">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
