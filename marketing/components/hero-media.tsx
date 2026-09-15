"use client";

import { Pause, Play, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

type PlaybackState = "poster" | "playing" | "paused" | "error";

export type MediaSource = {
  src: string;
  mobileSrc?: string;
  poster: string;
  /** Intrinsic dimensions — reserve the box so nothing shifts on load. */
  width: number;
  height: number;
  caption?: string;
  /** Describes the clip for assistive technology. */
  label: string;
};

type HeroMediaProps = {
  source: MediaSource;
  className?: string;
  /** Rendered inside the frame, above the controls. */
  children?: React.ReactNode;
  /** Disable the automatic inline attempt entirely (used in small previews). */
  controlsOnly?: boolean;
};

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * `navigator.connection.saveData` is not in the DOM typings, and is only
 * implemented by Chromium. Absent means "no signal", not "no saving".
 */
function prefersDataSaver() {
  const connection = (
    navigator as Navigator & { connection?: { saveData?: boolean } }
  ).connection;
  return connection?.saveData === true;
}

/**
 * The page's one video frame.
 *
 * Playback policy, in order:
 * 1. reduced motion, a data-saving connection, or a narrow viewport → stay on
 *    the poster and let the visitor press play;
 * 2. otherwise attempt a muted inline play the first time the frame is
 *    substantially visible;
 * 3. a rejected `play()` is a *policy* outcome, not a failure — the poster stays
 *    and the control reads "Play";
 * 4. a media error keeps the poster and offers a retry.
 *
 * It always pauses when scrolled out of view or when the tab is hidden, and a
 * deliberate pause is never overridden.
 */
export function HeroMedia({
  source,
  className,
  children,
  controlsOnly = false,
}: HeroMediaProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const userPausedRef = useRef(false);
  const autoStartedRef = useRef(false);
  const [state, setState] = useState<PlaybackState>("poster");

  const pause = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.paused) return;
    video.pause();
    setState("paused");
  }, []);

  const start = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;

    try {
      video.muted = true;
      await video.play();
      autoStartedRef.current = true;
      setState("playing");
    } catch {
      // Autoplay refused. Show the poster with a working Play control rather
      // than reporting a broken file.
      setState("poster");
    }
  }, []);

  const toggle = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      userPausedRef.current = false;
      void start();
    } else {
      userPausedRef.current = true;
      pause();
    }
  }, [pause, start]);

  const retry = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setState("poster");
    video.load();
    void start();
  }, [start]);

  /*
   * Detect an unloadable clip.
   *
   * With more than one `<source>`, a failed resource fires `error` on the
   * *source element* — the media element only reports NETWORK_NO_SOURCE once
   * the whole candidate list is exhausted, and its own `error` property stays
   * null. React's `onError` does not reliably reach `<source>`, so the
   * listeners are attached directly.
   *
   * The state is only marked failed when nothing is left to try, so a missing
   * narrow-viewport cut still falls through to the full-size one.
   */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let pending = 0;
    const check = () => {
      window.clearTimeout(pending);
      pending = window.setTimeout(() => {
        if (
          videoRef.current?.networkState ===
          HTMLMediaElement.NETWORK_NO_SOURCE
        ) {
          setState("error");
        }
      }, 0);
    };

    const sources = Array.from(video.querySelectorAll("source"));
    sources.forEach((element) => element.addEventListener("error", check));
    video.addEventListener("error", check);

    // The sources are in the server-rendered HTML, so a missing file can fail
    // while the browser is still parsing — before this effect attaches. Check
    // the current state once on mount as well as on every later error.
    check();

    return () => {
      window.clearTimeout(pending);
      sources.forEach((element) => element.removeEventListener("error", check));
      video.removeEventListener("error", check);
    };
  }, [source.src, source.mobileSrc]);

  // Attempt inline playback only when the policy allows it and the frame is
  // actually being looked at.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || controlsOnly) return;

    if (prefersReducedMotion() || prefersDataSaver()) return;

    const wideEnough = window.matchMedia("(min-width: 1024px)");

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!wideEnough.matches) {
          pause();
          return;
        }

        if (entry.isIntersecting && entry.intersectionRatio >= 0.4) {
          if (!userPausedRef.current && !autoStartedRef.current) {
            void start();
          } else if (autoStartedRef.current && !userPausedRef.current) {
            void video.play().then(
              () => setState("playing"),
              () => setState("paused"),
            );
          }
        } else {
          pause();
        }
      },
      { threshold: [0, 0.4, 0.75] },
    );

    observer.observe(video);

    const onVisibilityChange = () => {
      if (document.hidden) pause();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [controlsOnly, pause, start]);

  const isPlaying = state === "playing";
  const hasFailed = state === "error";

  return (
    <div className={cn("media-frame", className)}>
      <video
        ref={videoRef}
        poster={source.poster}
        width={source.width}
        height={source.height}
        muted
        loop
        playsInline
        preload="metadata"
        aria-label={source.label}
        onPlaying={() => setState("playing")}
        onPause={() =>
          setState((current) => (current === "error" ? current : "paused"))
        }
      >
        {source.mobileSrc ? (
          <source
            src={source.mobileSrc}
            media="(max-width: 767px)"
            type="video/mp4"
              />
        ) : null}
        <source src={source.src} type="video/mp4" />
      </video>

      {children}

      {hasFailed ? (
        <div className="media-notice">
          <p className="text-[15px] font-semibold">This clip could not load.</p>
          <button
            type="button"
            className="media-button media-button--primary w-auto gap-2 px-5"
            onClick={retry}
          >
            <RotateCcw className="size-4" aria-hidden="true" />
            Try again
          </button>
        </div>
      ) : null}

      <div className="media-scrim">
        <div className="media-controls">
          <button
            type="button"
            className="media-button media-button--primary"
            onClick={toggle}
            disabled={hasFailed}
            aria-label={
              isPlaying ? "Pause the product tour" : "Play the product tour"
            }
          >
            {isPlaying ? (
              <Pause className="size-4 fill-current" aria-hidden="true" />
            ) : (
              <Play
                className="ml-0.5 size-4 fill-current"
                aria-hidden="true"
              />
            )}
          </button>
        </div>

        {source.caption ? (
          <p className="media-caption">
            {source.caption}
            <br />
            Demo recording — processing time condensed.
          </p>
        ) : null}
      </div>
    </div>
  );
}
