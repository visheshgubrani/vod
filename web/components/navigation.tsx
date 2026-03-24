"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
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
import Image from "next/image";

const navLinks = [
  { href: "#features", label: "Features" },
  { href: "#pricing", label: "Pricing" },
  { href: "#api", label: "API" },
  // { href: "#testimonials", label: "Customers" },
];

export function Navigation() {
  const [isScrolled, setIsScrolled] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const { data: session, isPending } = useSession();

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
        "fixed top-0 left-0 right-0 z-50 transition-all duration-300",
        isScrolled ? "py-2 bg-accent/10 backdrop-blur-xl" : "py-4"
      )}
    >
      <nav className="max-w-7xl mx-auto px-4 flex items-center justify-between">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2 justify-start group">
          <Image
            src="/logo.svg"
            alt="ClipMux logo"
            width={50}
            height={50}
            className="size-7.5 w-auto shrink-0"
            priority
          />
          <span className="mt-1 text-lg md:text-[1.27rem] font-dashboard-heading font-semibold tracking-wider text-foreground">
            ClipMux
          </span>
        </Link>

        {/* Desktop Navigation */}
        <div className="hidden lg:ml-12 md:flex items-center gap-12 xl:gap-14">
          {navLinks.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="text-foreground/75 hover:text-foreground transition-colors relative group font-medium"
            >
              {link.label}
              <span className="absolute -bottom-1 left-0 w-0 h-0.5 bg-gradient-to-r from-primary to-accent group-hover:w-full transition-all duration-300" />
            </a>
          ))}
        </div>

        {/* CTA Buttons */}
        <div className="hidden md:flex items-center gap-4">
          {isLoggedIn ? (
            <Link href="/dashboard">
              <Button
                size="sm"
                className="h-auto py-2.5 px-6 rounded-full bg-[#704fd5] text-white hover:bg-[#704fd5]/90"
              >
                <LayoutDashboard className="w-4 h-4 fill-foreground" />
                Dashboard
              </Button>
            </Link>
          ) : (
            <>
              <Link href="/login">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-auto cursor-pointer py-5 bg-transparent font-semibold hover:bg-transparent"
                >
                  Login
                </Button>
              </Link>
              <Link href="/signup">
                <Button
                  size="sm"
                  className="h-auto cursor-pointer py-2 px-6 rounded-full bg-[#704fd5] text-white hover:bg-[#704fd5]/90"
                >
                  Get Started
                </Button>
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
              className="md:hidden p-2 text-foreground"
              aria-label="Toggle menu"
            >
              {isMobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
            </button>
          </DrawerTrigger>

          <DrawerContent className="md:hidden border-b-0 border-none pb-2 bg-card/60 backdrop-blur-xl">
            <div className="mx-auto w-full max-w-7xl px-6 pt-4 pb-6">
              <div className="mb-4 border-b border-card pb-2 rounded-xl flex items-center justify-between">
                {/* Logo */}
                <Link
                  href="/"
                  className="flex items-center justify-start gap-2 group"
                >
                  <Image
                    src="/logo.svg"
                    alt="ClipMux logo"
                    width={34}
                    height={34}
                    className="size-7 w-auto shrink-0"
                    priority
                  />
                  <span className="mt-0.5 text-lg md:text-xl font-semibold tracking-wider font-dashboard-heading text-foreground">
                    ClipMux
                  </span>
                </Link>

                <DrawerClose asChild>
                  <button
                    aria-label="Close menu"
                    className="p-2 text-foreground"
                  >
                    <X size={22} />
                  </button>
                </DrawerClose>
              </div>

              <div className="flex flex-col items-center gap-4">
                {navLinks.map((link) => (
                  <a
                    key={link.href}
                    href={link.href}
                    className="text-foreground/80 hover:text-foreground transition-colors py-2 font-semibold"
                    onClick={() => setIsMobileMenuOpen(false)}
                  >
                    {link.label}
                  </a>
                ))}
                <div className="flex flex-col gap-3 w-full pt-4 border-t border-border">
                  {isLoggedIn ? (
                    <Link
                      href="/dashboard"
                      onClick={() => setIsMobileMenuOpen(false)}
                    >
                      <Button className="w-full cursor-pointer h-auto py-2.5 px-8 rounded-full bg-[#704fd5] text-white hover:bg-[#704fd5]/90">
                        <LayoutDashboard className="w-4 h-4 mr-1 fill-foreground" />
                        Dashboard
                      </Button>
                    </Link>
                  ) : (
                    <>
                      <Link
                        href="/login"
                        onClick={() => setIsMobileMenuOpen(false)}
                      >
                        <Button
                          variant="ghost"
                          className="w-full cursor-pointer h-auto py-5 bg-transparent font-semibold hover:bg-transparent"
                        >
                          Login
                        </Button>
                      </Link>
                      <Link
                        href="/signup"
                        onClick={() => setIsMobileMenuOpen(false)}
                      >
                        <Button className="w-full cursor-pointer h-auto py-3 rounded-full bg-[#704fd5] text-white font-semibold hover:bg-[#704fd5]/90">
                          Get Started
                        </Button>
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
