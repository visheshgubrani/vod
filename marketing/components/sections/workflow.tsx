"use client";

import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useRef, useState } from "react";

import {
  PlayScene,
  ProcessScene,
  UploadScene,
} from "@/components/process-scenes";

gsap.registerPlugin(useGSAP, ScrollTrigger);

const STEPS = [
  {
    number: "01",
    title: "Upload",
    body: "The browser uploads windowed multipart parts straight to your raw bucket, with progress you can pause and resume.",
  },
  {
    number: "02",
    title: "Process",
    body: "A transcoder turns the source into rendition rows and packages them as HLS and DASH outputs.",
  },
  {
    number: "03",
    title: "Play",
    body: "The delivery Worker verifies the request and serves the right stream, so the same asset plays in your player.",
  },
] as const;

/**
 * One asset moving through a visible process.
 *
 * Desktop gets a single bounded scroll sequence: the active step, the visible
 * scene, and the progress rail all advance from the same scrubbed timeline.
 * Mobile and reduced motion get the three scenes stacked vertically — every
 * explanation is readable without completing (or even seeing) an animation.
 */
export function WorkflowSection() {
  const sectionRef = useRef<HTMLElement>(null);
  const scenesRef = useRef<HTMLDivElement>(null);
  const [activeStep, setActiveStep] = useState(0);

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

          if (!desktop || reduceMotion) return;

          const scenes = scenesRef.current;
          if (!scenes) return;

          const panels = gsap.utils.toArray<HTMLElement>(
            "[data-workflow-scene]",
            scenes,
          );
          if (panels.length === 0) return;

          /**
           * Size the stack to its tallest card. `scrollHeight` reports the
           * content height even while the panels are absolutely positioned and
           * hidden, so this stays correct on resize.
           */
          const fit = () => {
            const tallest = Math.max(
              ...panels.map((panel) => panel.scrollHeight),
            );
            scenes.style.minHeight = `${tallest}px`;
          };

          fit();
          ScrollTrigger.addEventListener("refreshInit", fit);

          // Absolute stacking is opt-in, so a page without JavaScript (or
          // without this timeline) shows the three scenes in normal flow
          // instead of overlapping them.
          scenes.dataset.animated = "true";

          gsap.set(panels.slice(1), { autoAlpha: 0, y: 18 });
          gsap.set(panels[0], { autoAlpha: 1, y: 0 });

          const timeline = gsap.timeline({
            scrollTrigger: {
              trigger: sectionRef.current,
              start: "top 68%",
              end: "bottom 62%",
              scrub: 0.5,
              invalidateOnRefresh: true,
              onUpdate: (self) => {
                const next = Math.min(
                  panels.length - 1,
                  Math.floor(self.progress * panels.length),
                );
                setActiveStep((current) => (current === next ? current : next));
              },
            },
          });

          // The rail advances one segment per step and reaches full exactly as
          // the last step is reached, so the bar and the step count agree.
          panels.forEach((_, index) => {
            timeline.to(
              "[data-workflow-progress]",
              {
                scaleX: (index + 1) / panels.length,
                ease: "none",
                duration: 1,
              },
              index,
            );
          });

          // Sequential, not a crossfade: one card is fully gone before the next
          // arrives, so two blocks of text are never stacked on top of one
          // another. The hand-off is a fraction of a step.
          const HANDOFF = 0.24;
          panels.forEach((panel, index) => {
            if (index === 0) {
              timeline.to(
                panel,
                {
                  autoAlpha: 0,
                  y: -18,
                  duration: HANDOFF,
                  ease: "power1.in",
                },
                1 - HANDOFF / 2,
              );
              return;
            }

            timeline.to(
              panel,
              { autoAlpha: 1, y: 0, duration: HANDOFF, ease: "power1.out" },
              index - HANDOFF / 2,
            );

            if (index < panels.length - 1) {
              timeline.to(
                panel,
                {
                  autoAlpha: 0,
                  y: -18,
                  duration: HANDOFF,
                  ease: "power1.in",
                },
                index + 1 - HANDOFF / 2,
              );
            }
          });

          return () => {
            ScrollTrigger.removeEventListener("refreshInit", fit);
          };
        },
      );

      return () => media.revert();
    },
    { scope: sectionRef },
  );

  return (
    <section
      id="workflow"
      ref={sectionRef}
      className="workflow-section section"
      data-reveal
    >
      <div className="content-width">
        <div className="section-header">
          <div>
            <p className="section-label">02 / Workflow</p>
            <h2 className="section-title">One upload. Ready for playback.</h2>
          </div>
          <p className="section-intro">
            The same asset from the hero clip, followed from the moment it leaves
            the browser to the moment a viewer presses play.
          </p>
        </div>

        <div className="workflow-layout">
          <div className="workflow-copy">
            <ol className="workflow-steps">
              {STEPS.map((step, index) => (
                <li
                  key={step.number}
                  className="workflow-step"
                  data-active={activeStep === index}
                >
                  <span className="workflow-step-index" aria-hidden="true">
                    {step.number}
                  </span>
                  <div>
                    <h3>{step.title}</h3>
                    <p>{step.body}</p>
                  </div>
                </li>
              ))}
            </ol>

            <div className="mt-10">
              <div className="workflow-progress" aria-hidden="true">
                <span data-workflow-progress />
              </div>
              <p className="mt-3 font-mono text-[13px] text-[color:var(--muted)]">
                Step {activeStep + 1} of {STEPS.length} · {STEPS[activeStep].title}
              </p>
            </div>
          </div>

          <div className="workflow-stage">
            <div className="workflow-scenes" ref={scenesRef}>
              {[UploadScene, ProcessScene, PlayScene].map((Scene, index) => (
                <div
                  key={STEPS[index].number}
                  className="workflow-scene"
                  data-workflow-scene
                  aria-hidden={activeStep !== index}
                >
                  <Scene />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Stacked fallback: mobile, reduced motion, and no-JavaScript. */}
        <div className="workflow-mobile">
          {[UploadScene, ProcessScene, PlayScene].map((Scene, index) => (
            <article key={STEPS[index].number}>
              <div className="mb-4 flex items-center gap-3">
                <span className="font-mono text-[13px] text-[color:var(--brand)]">
                  {STEPS[index].number}
                </span>
                <h3 className="text-[19px] font-bold tracking-[-0.02em]">
                  {STEPS[index].title}
                </h3>
              </div>
              <p className="mb-4 max-w-[58ch] text-[16px] leading-[1.6] text-[color:var(--muted)]">
                {STEPS[index].body}
              </p>
              <Scene />
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
