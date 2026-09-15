"use client";

import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import type { ReactNode } from "react";
import { useRef } from "react";

gsap.registerPlugin(useGSAP, ScrollTrigger);

/**
 * Page-level motion. Two effects only: a short hero entrance, and one reveal per
 * section, played once.
 *
 * Three deliberate constraints:
 *
 * 1. **Opacity, never `autoAlpha`.** `autoAlpha` toggles `visibility: hidden`,
 *    which removes an element from the accessibility tree — a section that has
 *    not been scrolled to yet would be invisible to a screen reader, to
 *    find-in-page, and to anything else that reads the DOM. Opacity fades the
 *    same way without any of that.
 * 2. **Sections already on screen are skipped.** `gsap.from` writes its start
 *    state immediately, so applying it to something already in view would blank
 *    it and then animate it back. Above-the-fold content is never touched.
 * 3. **The rendered markup is the end state.** If this component never runs —
 *    no JavaScript, a failed chunk, reduced motion — every section is simply
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

        gsap.utils.toArray<HTMLElement>("[data-reveal]").forEach((element) => {
          if (element.getBoundingClientRect().top < window.innerHeight) {
            return;
          }

          gsap.from(element, {
            opacity: 0,
            y: 16,
            duration: 0.4,
            ease: "power2.out",
            clearProps: "opacity,transform",
            scrollTrigger: {
              trigger: element,
              start: "top 88%",
              once: true,
            },
          });
        });
      });

      return () => media.revert();
    },
    { scope: rootRef },
  );

  return <div ref={rootRef}>{children}</div>;
}
