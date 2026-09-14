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
  { href: "#product", label: "Product" },
  { href: "#developers", label: "Developers" },
  { href: "#hosting", label: "Hosting" },
];

type SiteNavProps = {
  config: SiteConfig;
};

export function SiteNav({ config }: SiteNavProps) {
  const [open, setOpen] = useState(false);
  const reduceMotion = useReducedMotion();
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const firstMobileLinkRef = useRef<HTMLAnchorElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open) {
      firstMobileLinkRef.current?.focus();
    } else if (wasOpen.current) {
      menuButtonRef.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);

  const closeMenu = () => setOpen(false);

  return (
    <header className="site-header sticky top-0 z-50 border-b border-transparent bg-paper/90 backdrop-blur-xl">
      <div className="content-width flex h-[76px] items-center justify-between">
        <Link href="#top" className="group flex items-center gap-2.5" aria-label="OpenVOD home">
          <BrandMark className="size-7 transition-transform duration-200 group-hover:rotate-12" />
          <span className="text-[17px] font-extrabold tracking-[-0.05em]">OpenVOD</span>
        </Link>

        <nav className="hidden items-center gap-7 lg:flex" aria-label="Primary navigation">
          {navItems.map((item) => (
            <a key={item.href} href={item.href} className="nav-link">
              {item.label}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-5 lg:flex">
          <a className="nav-link inline-flex items-center gap-1" href={config.docsUrl}>
            Docs <ArrowUpRight className="size-3.5" />
          </a>
          <a
            className="nav-link inline-flex items-center gap-1"
            href={config.githubUrl}
            target="_blank"
            rel="noreferrer"
          >
            GitHub <ArrowUpRight className="size-3.5" />
          </a>
          <a className={cn(buttonVariants({ variant: "primary", size: "sm" }))} href={config.quickstartUrl}>
            Start self-hosting
          </a>
        </div>

        <button
          ref={menuButtonRef}
          className="inline-flex size-10 items-center justify-center rounded-lg border border-ink/15 lg:hidden"
          type="button"
          aria-expanded={open}
          aria-controls="mobile-nav"
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((current) => !current)}
        >
          {open ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
      </div>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            id="mobile-nav"
            className="border-t border-hairline bg-paper lg:hidden"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.2, ease: "easeOut" }}
            onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
              if (event.key === "Escape") setOpen(false);
            }}
          >
            <nav className="content-width flex flex-col gap-1 py-4" aria-label="Mobile navigation">
              {navItems.map((item, index) => (
                <a key={item.href} ref={index === 0 ? firstMobileLinkRef : undefined} href={item.href} className="mobile-nav-link" onClick={closeMenu}>
                  {item.label}
                </a>
              ))}
              <a href={config.docsUrl} className="mobile-nav-link" onClick={closeMenu}>
                Docs <ArrowUpRight className="size-4" />
              </a>
              <a href={config.githubUrl} className="mobile-nav-link" onClick={closeMenu}>
                GitHub <ArrowUpRight className="size-4" />
              </a>
              <a href={config.quickstartUrl} className={cn(buttonVariants({ className: "mt-3 w-full" }))} onClick={closeMenu}>
                Start self-hosting
              </a>
            </nav>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <noscript>
        <nav className="content-width flex flex-col gap-3 border-t border-hairline py-4 lg:hidden" aria-label="No-script navigation">
          {navItems.map((item) => (
            <a key={item.href} href={item.href} className="mobile-nav-link">
              {item.label}
            </a>
          ))}
          <a href={config.quickstartUrl} className={cn(buttonVariants({ className: "w-full" }))}>
            Start self-hosting
          </a>
        </nav>
      </noscript>
    </header>
  );
}
