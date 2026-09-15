"use client";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { VariantProps } from "class-variance-authority";

type TourLinkProps = {
  className?: string;
  variant?: VariantProps<typeof buttonVariants>["variant"];
  children: React.ReactNode;
};

/**
 * Anchors to the hero player and moves focus into it, so the same control works
 * for pointer, keyboard, and no-JavaScript visitors — the `href` alone scrolls
 * to the frame, and the click handler adds the focus move on top.
 */
export function TourLink({ className, variant = "secondary", children }: TourLinkProps) {
  return (
    <a
      href="#product-tour"
      className={cn(buttonVariants({ variant }), className)}
      onClick={(event) => {
        const frame = document.getElementById("product-tour");
        if (!frame) return;
        event.preventDefault();

        const reduceMotion = window.matchMedia(
          "(prefers-reduced-motion: reduce)",
        ).matches;
        frame.scrollIntoView({
          behavior: reduceMotion ? "auto" : "smooth",
          block: "center",
        });
        frame.focus({ preventScroll: true });
      }}
    >
      {children}
    </a>
  );
}
