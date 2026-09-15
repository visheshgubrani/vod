/**
 * Every image and video the marketing page references.
 *
 * The assets themselves are supplied separately — this module is the single
 * place that names them, so swapping a clip or a still never means hunting
 * through components. Paths are served from `marketing/public`.
 *
 * `width`/`height` are the intrinsic pixel dimensions: they are written into
 * `width`/`height` attributes and CSS `aspect-ratio` so media reserves its box
 * before it loads and the page does not shift.
 */
import { siteConfig } from "@/lib/site-config";

export type MediaAsset = {
  src: string;
  poster: string;
  width: number;
  height: number;
  alt: string;
  /** Shown in the small mono caption under a media frame. */
  caption: string;
};

export type VideoAsset = MediaAsset & {
  /** Optional tighter edit for narrow viewports. */
  mobileSrc?: string;
};

/** The coastal hero clip — also the asset the whole page tells a story about. */
export const heroVideo: VideoAsset = {
  src: siteConfig.heroVideoUrl,
  mobileSrc: siteConfig.heroVideoMobileUrl,
  poster: siteConfig.heroPosterUrl,
  width: 1920,
  height: 1080,
  alt: "A coastal headland at golden hour, used as the demo asset throughout this page.",
  caption: "coastal-headland.mp4 · 1080p source",
};

/** Supporting footage for the library and workflow examples. */
export const supportingClips: VideoAsset[] = [
  {
    src: "/media/clips/woodland.mp4",
    poster: "/media/clips/woodland-poster.jpg",
    width: 1920,
    height: 1080,
    alt: "Sunlight through a woodland canopy.",
    caption: "woodland-canopy.mp4",
  },
  {
    src: "/media/clips/architecture.mp4",
    poster: "/media/clips/architecture-poster.jpg",
    width: 1920,
    height: 1080,
    alt: "A concrete building facade with repeating windows.",
    caption: "facade-study.mp4",
  },
  {
    src: "/media/clips/craft.mp4",
    poster: "/media/clips/craft-poster.jpg",
    width: 1920,
    height: 1080,
    alt: "Hands shaping clay on a potter's wheel.",
    caption: "wheel-throwing.mp4",
  },
];

/**
 * 16:9 stills used as library thumbnails and poster stand-ins. These are
 * marketing and demo-fixture only — the dashboard always shows real customer
 * thumbnails.
 */
export const thumbnails = {
  coastal: "/media/thumbs/coastal.jpg",
  woodland: "/media/thumbs/woodland.jpg",
  architecture: "/media/thumbs/architecture.jpg",
  craft: "/media/thumbs/craft.jpg",
} as const;

/**
 * Every file the page expects, in one list. `marketing/public/media/README.md`
 * documents the provenance fields each entry needs before launch.
 */
export const requiredMediaFiles: string[] = [
  heroVideo.src,
  heroVideo.mobileSrc!,
  heroVideo.poster,
  ...supportingClips.flatMap((clip) => [
    clip.src,
    clip.poster,
    ...(clip.mobileSrc ? [clip.mobileSrc] : []),
  ]),
  ...Object.values(thumbnails),
];
