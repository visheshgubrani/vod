/**
 * Every image and video the marketing page references.
 *
 * The page has exactly one media asset: the hero recording. Everything below
 * the hero is typographic, so a checkout without `public/media` still renders a
 * complete, presentable page instead of a grid of broken thumbnails.
 *
 * The files themselves are supplied separately — this module is the single
 * place that names them. Paths are served from `marketing/public`.
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

/** The hero recording — the page's one visual moment. */
export const heroVideo: VideoAsset = {
  src: siteConfig.heroVideoUrl,
  mobileSrc: siteConfig.heroVideoMobileUrl,
  poster: siteConfig.heroPosterUrl,
  width: 1920,
  height: 1080,
  alt: "A coastal headland at golden hour, used as the demo asset throughout this page.",
  caption: "coastal-headland.mp4 · 1080p source",
};
