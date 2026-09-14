"use client";

import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type DemoPlayerProps = {
  poster: string;
  src: string;
};

export function DemoPlayer({ poster, src }: DemoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [mediaError, setMediaError] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting && !video.paused) {
          video.pause();
          setPlaying(false);
        }
      },
      { threshold: 0.15 },
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, []);

  const togglePlayback = async () => {
    const video = videoRef.current;
    if (!video || mediaError) return;

    if (video.paused) {
      try {
        await video.play();
        setPlaying(true);
      } catch {
        setMediaError(true);
      }
    } else {
      video.pause();
      setPlaying(false);
    }
  };

  return (
    <div className="demo-player relative aspect-video overflow-hidden bg-[#201d27]">
      <video
        ref={videoRef}
        className="size-full object-cover"
        muted={muted}
        loop
        playsInline
        preload="metadata"
        poster={poster}
        onError={() => setMediaError(true)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      >
        <source src={src} type="video/mp4" />
      </video>
      {mediaError ? (
        <div className="absolute inset-0 flex items-center justify-center bg-[#201d27]/55 px-6 text-center text-xs text-white/70">
          Poster preview — add a walkthrough recording at <code className="ml-1 font-mono text-white">/walkthrough.mp4</code>.
        </div>
      ) : null}
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/60 to-transparent px-4 pb-4 pt-10">
        <button
          type="button"
          className="inline-flex size-9 items-center justify-center rounded-full bg-white text-ink transition-transform duration-200 hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          onClick={togglePlayback}
          aria-label={playing ? "Pause product walkthrough" : "Play product walkthrough"}
        >
          {playing ? <Pause className="size-4 fill-current" /> : <Play className="ml-0.5 size-4 fill-current" />}
        </button>
        <button
          type="button"
          className="inline-flex size-9 items-center justify-center rounded-full text-white transition-colors hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          onClick={() => setMuted((current) => !current)}
          aria-label={muted ? "Unmute product walkthrough" : "Mute product walkthrough"}
        >
          {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
        </button>
      </div>
    </div>
  );
}
