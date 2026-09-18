"use client";

import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import type { ReactNode } from "react";
import { useRef } from "react";

gsap.registerPlugin(useGSAP);

/**
 * Page-level motion. One effect only: a short entrance for the hero.
 *
 * Three deliberate constraints:
 *
 * 1. **Opacity, never `autoAlpha`.** `autoAlpha` toggles `visibility: hidden`,
 *    which removes an element from the accessibility tree. Opacity fades the
 *    same way without any of that.
 * 2. **Only the hero is animated.** The hero is the page's visual moment;
 *    everything below it is content you should be able to read the instant it
 *    scrolls into view, so those sections carry no entrance at all.
 * 3. **The rendered markup is the end state.** If this component never runs —
 *    no JavaScript, a failed chunk, reduced motion — the page is simply
 *    visible.
 */
export function MarketingMotion({ children }: { children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const media = gsap.matchMedia();

      media.add({ ok: "(prefers-reduced-motion: no-preference)" }, (context) => {
        const { ok } = context.conditions as { ok: boolean };
        if (!ok) return;

        gsap.from("[data-hero-item]", {
          opacity: 0,
          y: 10,
          duration: 0.5,
          ease: "power2.out",
          stagger: 0.07,
          clearProps: "opacity,transform",
        });
      });

      return () => media.revert();
    },
    { scope: rootRef },
  );

  return <div ref={rootRef}>{children}</div>;
}
