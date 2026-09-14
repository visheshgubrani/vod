"use client";

import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import type { ReactNode } from "react";
import { useRef } from "react";

gsap.registerPlugin(useGSAP, ScrollTrigger);

export function MarketingMotion({ children }: { children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const media = gsap.matchMedia();

      media.add(
        {
          desktop: "(min-width: 1024px)",
          reduceMotion: "(prefers-reduced-motion: reduce)",
        },
        (context) => {
          const { desktop, reduceMotion } = context.conditions as {
            desktop: boolean;
            reduceMotion: boolean;
          };

          if (reduceMotion) {
            return;
          }

          const intro = gsap.timeline({ defaults: { ease: "power3.out" } });
          intro.from("[data-hero-item]", {
            autoAlpha: 0,
            y: 12,
            duration: 0.6,
            stagger: 0.08,
          });

          gsap.utils.toArray<HTMLElement>("[data-reveal]").forEach((element) => {
            gsap.from(element, {
              autoAlpha: 0,
              y: 20,
              duration: 0.45,
              ease: "power2.out",
              scrollTrigger: {
                trigger: element,
                start: "top 88%",
                once: true,
              },
            });
          });

          if (!desktop) {
            return;
          }

          gsap.fromTo(
            ".hero-frame",
            { scale: 0.92 },
            {
              scale: 1,
              ease: "none",
              scrollTrigger: {
                trigger: ".hero-frame-wrap",
                start: "top bottom",
                end: "+=400",
                scrub: 1,
              },
            },
          );

          const workflowTimeline = gsap.timeline({
            scrollTrigger: {
              trigger: ".workflow-section",
              start: "top top",
              end: "+=120%",
              pin: ".workflow-sticky",
              scrub: 1,
              anticipatePin: 1,
            },
          });

          workflowTimeline.to(".workflow-progress", { scaleY: 1, ease: "none" }, 0);
          const scenes = gsap.utils.toArray<HTMLElement>("[data-workflow-scene]");
          scenes.forEach((scene, index) => {
            workflowTimeline.to(
              scene,
              { autoAlpha: 1, y: 0, duration: 0.28, ease: "power2.out" },
              index * 0.62,
            );
            if (index < scenes.length - 1) {
              workflowTimeline.to(
                scene,
                { autoAlpha: 0, y: -18, duration: 0.2, ease: "power2.in" },
                index * 0.62 + 0.42,
              );
            }
          });

          const lenis = new Lenis({
            duration: 1.1,
            smoothWheel: true,
            syncTouch: false,
          });
          const onScroll = () => ScrollTrigger.update();
          const onTick = (time: number) => lenis.raf(time * 1000);
          lenis.on("scroll", onScroll);
          gsap.ticker.add(onTick);
          gsap.ticker.lagSmoothing(0);

          return () => {
            lenis.off("scroll", onScroll);
            gsap.ticker.remove(onTick);
            lenis.destroy();
            gsap.ticker.lagSmoothing(1000, 33);
          };
        },
      );

      return () => media.revert();
    },
    { scope: rootRef },
  );

  return <div ref={rootRef}>{children}</div>;
}
