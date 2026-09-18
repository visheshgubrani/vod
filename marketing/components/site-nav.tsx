"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowUpRight, Menu, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { BrandMark } from "@/components/brand-mark";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SiteConfig } from "@/lib/site-config";

const navItems = [
  { href: "#ownership", label: "Ownership" },
  { href: "#workflow", label: "Workflow" },
  { href: "#platform", label: "Platform" },
  { href: "#developers", label: "Developers" },
  { href: "#hosting", label: "Self-hosting" },
];

type SiteNavProps = {
  config: SiteConfig;
};

export function SiteNav({ config }: SiteNavProps) {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const reduceMotion = useReducedMotion();
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const firstMobileLinkRef = useRef<HTMLAnchorElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (open) {
      firstMobileLinkRef.current?.focus();
    } else if (wasOpen.current) {
      menuButtonRef.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);

  return (
    <header className="site-header" data-scrolled={scrolled}>
      <div className="content-width">
        <Link href="#top" className="brand-lockup" aria-label="ClipMux home">
          <BrandMark className="size-7" />
          ClipMux
        </Link>

        <nav
          className="hidden items-center gap-7 lg:flex"
          aria-label="Primary navigation"
        >
          {navItems.map((item) => (
            <a key={item.href} href={item.href} className="nav-link">
              {item.label}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-6 lg:flex">
          <a
            className="nav-link inline-flex items-center gap-1"
            href={config.docsUrl}
          >
            Docs <ArrowUpRight className="size-3.5" aria-hidden="true" />
          </a>
          <a
            className={buttonVariants({ size: "default" })}
            href={config.quickstartUrl}
          >
            Start self-hosting
          </a>
        </div>

        <button
          ref={menuButtonRef}
          type="button"
          className="inline-flex size-11 items-center justify-center rounded-[10px] border border-[color:var(--hairline-strong)] text-[color:var(--ink)] lg:hidden"
          aria-expanded={open}
          aria-controls="mobile-nav"
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((current) => !current)}
        >
          {open ? (
            <X className="size-5" aria-hidden="true" />
          ) : (
            <Menu className="size-5" aria-hidden="true" />
          )}
        </button>
      </div>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            id="mobile-nav"
            className="border-t border-[color:var(--hairline)] bg-[color:var(--paper)] lg:hidden"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.18, ease: "easeOut" }}
            onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
              if (event.key === "Escape") setOpen(false);
            }}
          >
            <nav
              className="content-width flex flex-col gap-1 py-4"
              aria-label="Mobile navigation"
            >
              {navItems.map((item, index) => (
                <a
                  key={item.href}
                  ref={index === 0 ? firstMobileLinkRef : undefined}
                  href={item.href}
                  className="mobile-nav-link"
                  onClick={() => setOpen(false)}
                >
                  {item.label}
                </a>
              ))}
              <a
                href={config.docsUrl}
                className="mobile-nav-link"
                onClick={() => setOpen(false)}
              >
                Docs <ArrowUpRight className="size-4" aria-hidden="true" />
              </a>
              <a
                href={config.quickstartUrl}
                className={cn(buttonVariants({ size: "lg" }), "mt-3 w-full")}
                onClick={() => setOpen(false)}
              >
                Start self-hosting
              </a>
            </nav>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <noscript>
        <nav
          className="content-width flex flex-col gap-2 border-t border-[color:var(--hairline)] py-4 lg:hidden"
          aria-label="No-script navigation"
        >
          {navItems.map((item) => (
            <a key={item.href} href={item.href} className="mobile-nav-link">
              {item.label}
            </a>
          ))}
          <a
            href={config.quickstartUrl}
            className={cn(buttonVariants({ size: "lg" }), "w-full")}
          >
            Start self-hosting
          </a>
        </nav>
      </noscript>
    </header>
  );
}
