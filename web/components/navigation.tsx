"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { Menu, X, LayoutDashboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { cn } from "@/lib/utils";
import { useSession } from "@/lib/auth-client";
import { APP_NAME, GITHUB_URL } from "@/lib/site";

interface NavLink {
  href: string;
  label: string;
  external?: boolean;
}

const navLinks: NavLink[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: GITHUB_URL, label: "GitHub", external: true },
];

export function Navigation() {
  const [isScrolled, setIsScrolled] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const { data: session, isPending } = useSession();
  const pathname = usePathname();

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 20);
    };
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const isLoggedIn = !isPending && session;

  return (
    <header
      className={cn(
        "fixed top-0 left-0 right-0 z-50 border-b transition-all duration-300",
        isScrolled
          ? "border-border-soft bg-background/85 py-2 backdrop-blur-xl"
          : "border-transparent py-4"
      )}
    >
      <nav className="mx-auto flex max-w-7xl items-center justify-between px-4">
        {/* Logo */}
        <Link
          href="/"
          className="group flex items-center gap-2.5 justify-start rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <Image
            src="/logo.svg"
            alt="ClipMux logo"
            width={50}
            height={50}
            className="size-7.5 w-auto shrink-0"
            priority
          />
          <span className="text-[17px] font-semibold tracking-[-0.02em] text-foreground">
            {APP_NAME}
          </span>
        </Link>

        {/* Desktop Navigation */}
        <div className="hidden items-center gap-8 md:flex lg:ml-12 xl:gap-10">
          {navLinks.map((link) => {
            const isActive = !link.external && pathname === link.href;
            const linkClassName = cn(
              "text-[15px] font-medium transition-colors",
              isActive
                ? "text-ember"
                : "text-muted-foreground hover:text-foreground"
            );
            return link.external ? (
              <a key={link.href} href={link.href} className={linkClassName}>
                {link.label}
              </a>
            ) : (
              <Link
                key={link.href}
                href={link.href}
                className={linkClassName}
                aria-current={isActive ? "page" : undefined}
              >
                {link.label}
              </Link>
            );
          })}
        </div>

        {/* CTA Buttons */}
        <div className="hidden items-center gap-3 md:flex">
          {isLoggedIn ? (
            <Link href="/dashboard">
              <Button size="sm">
                <LayoutDashboard className="size-4" aria-hidden="true" />
                Dashboard
              </Button>
            </Link>
          ) : (
            <>
              <Link href="/login">
                <Button variant="ghost" size="sm">
                  Login
                </Button>
              </Link>
              <Link href="/signup">
                <Button size="sm">Get Started</Button>
              </Link>
            </>
          )}
        </div>

        {/* Mobile Menu Drawer */}
        <Drawer
          direction="top"
          open={isMobileMenuOpen}
          onOpenChange={setIsMobileMenuOpen}
        >
          <DrawerTrigger asChild>
            <button
              className="flex size-11 items-center justify-center rounded-[10px] text-foreground transition-colors hover:bg-panel-strong md:hidden"
              aria-label="Toggle menu"
            >
              {isMobileMenuOpen ? (
                <X size={24} aria-hidden="true" />
              ) : (
                <Menu size={24} aria-hidden="true" />
              )}
            </button>
          </DrawerTrigger>

          <DrawerContent className="border-none border-b-0 bg-background/95 pb-2 backdrop-blur-xl md:hidden">
            <div className="mx-auto w-full max-w-7xl px-6 pt-4 pb-6">
              <div className="mb-4 flex items-center justify-between rounded-xl border-b border-border-soft pb-2">
                {/* Logo */}
                <Link
                  href="/"
                  className="group flex items-center justify-start gap-2"
                >
                  <Image
                    src="/logo.svg"
                    alt="ClipMux logo"
                    width={34}
                    height={34}
                    className="size-7 w-auto shrink-0"
                    priority
                  />
                  <span className="text-[17px] font-semibold tracking-[-0.02em] text-foreground">
                    {APP_NAME}
                  </span>
                </Link>

                <DrawerClose asChild>
                  <button
                    aria-label="Close menu"
                    className="flex size-11 items-center justify-center rounded-[10px] text-foreground transition-colors hover:bg-panel-strong"
                  >
                    <X size={22} aria-hidden="true" />
                  </button>
                </DrawerClose>
              </div>

              <div className="flex flex-col items-center gap-4">
                {navLinks.map((link) => {
                  const isActive = !link.external && pathname === link.href;
                  const linkClassName = cn(
                    "py-2 text-[15px] font-semibold transition-colors",
                    isActive
                      ? "text-ember"
                      : "text-foreground/80 hover:text-foreground"
                  );
                  const handleClick = () => setIsMobileMenuOpen(false);
                  return link.external ? (
                    <a
                      key={link.href}
                      href={link.href}
                      className={linkClassName}
                      onClick={handleClick}
                    >
                      {link.label}
                    </a>
                  ) : (
                    <Link
                      key={link.href}
                      href={link.href}
                      className={linkClassName}
                      onClick={handleClick}
                      aria-current={isActive ? "page" : undefined}
                    >
                      {link.label}
                    </Link>
                  );
                })}
                <div className="flex w-full flex-col gap-3 border-t border-border pt-4">
                  {isLoggedIn ? (
                    <Link
                      href="/dashboard"
                      onClick={() => setIsMobileMenuOpen(false)}
                    >
                      <Button className="w-full">
                        <LayoutDashboard className="size-4" aria-hidden="true" />
                        Dashboard
                      </Button>
                    </Link>
                  ) : (
                    <>
                      <Link
                        href="/login"
                        onClick={() => setIsMobileMenuOpen(false)}
                      >
                        <Button variant="ghost" className="w-full">
                          Login
                        </Button>
                      </Link>
                      <Link
                        href="/signup"
                        onClick={() => setIsMobileMenuOpen(false)}
                      >
                        <Button className="w-full">Get Started</Button>
                      </Link>
                    </>
                  )}
                </div>
              </div>
            </div>
          </DrawerContent>
        </Drawer>
      </nav>
    </header>
  );
}
