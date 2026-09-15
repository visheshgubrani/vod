export type SiteConfig = {
  canonicalOrigin: string;
  docsUrl: string;
  quickstartUrl: string;
  githubUrl: string;
  managedFormUrl: string;
  enterpriseFormUrl: string;
  privacyUrl: string;
  /** The 24-second hero recording, in a 1080p desktop cut… */
  heroVideoUrl: string;
  /** …and a tighter 720p cut for narrow viewports. */
  heroVideoMobileUrl: string;
  heroPosterUrl: string;
};

type SiteEnv = Record<string, string | undefined>;

/**
 * Defaults are written as literals rather than imported from `lib/media`,
 * because `next.config.ts` evaluates this module outside the app's module
 * resolver. `lib/media.ts` reads the resulting config, so this stays the single
 * source of truth for the hero paths.
 */
const localDefaults: SiteConfig = {
  canonicalOrigin: "http://localhost:3004",
  docsUrl: "http://localhost:3002",
  quickstartUrl: "http://localhost:3002/quickstart",
  githubUrl: "https://github.com/visheshgubrani/vod",
  managedFormUrl:
    "mailto:hello@clipmux.com?subject=ClipMux%20managed%20hosting%20waitlist",
  enterpriseFormUrl:
    "mailto:hello@clipmux.com?subject=ClipMux%20enterprise%20deployment",
  privacyUrl: "http://localhost:3000/privacy",
  heroVideoUrl: "/media/hero-1080.mp4",
  heroVideoMobileUrl: "/media/hero-720.mp4",
  heroPosterUrl: "/media/hero-poster.jpg",
};

/**
 * Destinations that must be configured explicitly for a production build. The
 * media paths are deliberately *not* required: they default to the files shipped
 * in `public/media`, so a deployment without a CDN still renders.
 */
const requiredEnv: Array<[keyof SiteConfig, string]> = [
  ["canonicalOrigin", "MARKETING_CANONICAL_ORIGIN"],
  ["docsUrl", "MARKETING_DOCS_URL"],
  ["quickstartUrl", "MARKETING_QUICKSTART_URL"],
  ["githubUrl", "MARKETING_GITHUB_URL"],
  ["managedFormUrl", "MARKETING_MANAGED_FORM_URL"],
  ["enterpriseFormUrl", "MARKETING_ENTERPRISE_FORM_URL"],
  ["privacyUrl", "MARKETING_PRIVACY_URL"],
];

function isProductionBuild(env: SiteEnv) {
  return env.NODE_ENV === "production" && env.MARKETING_ALLOW_LOCAL_DEFAULTS !== "1";
}

export function getSiteConfig(env: SiteEnv = process.env): SiteConfig {
  const config: SiteConfig = {
    canonicalOrigin: env.MARKETING_CANONICAL_ORIGIN ?? localDefaults.canonicalOrigin,
    docsUrl: env.MARKETING_DOCS_URL ?? localDefaults.docsUrl,
    quickstartUrl: env.MARKETING_QUICKSTART_URL ?? localDefaults.quickstartUrl,
    githubUrl: env.MARKETING_GITHUB_URL ?? localDefaults.githubUrl,
    managedFormUrl: env.MARKETING_MANAGED_FORM_URL ?? localDefaults.managedFormUrl,
    enterpriseFormUrl:
      env.MARKETING_ENTERPRISE_FORM_URL ?? localDefaults.enterpriseFormUrl,
    privacyUrl: env.MARKETING_PRIVACY_URL ?? localDefaults.privacyUrl,
    heroVideoUrl: env.MARKETING_HERO_VIDEO_URL ?? localDefaults.heroVideoUrl,
    heroVideoMobileUrl:
      env.MARKETING_HERO_VIDEO_MOBILE_URL ?? localDefaults.heroVideoMobileUrl,
    heroPosterUrl: env.MARKETING_HERO_POSTER_URL ?? localDefaults.heroPosterUrl,
  };

  if (isProductionBuild(env)) {
    const missing = requiredEnv
      .filter(([, envName]) => !env[envName]?.trim())
      .map(([, envName]) => envName);

    if (missing.length > 0) {
      throw new Error(
        `[clipmux-marketing] Missing required production destinations: ${missing.join(", ")}`,
      );
    }
  }

  return config;
}

export const siteConfig = getSiteConfig();
