export type SiteConfig = {
  canonicalOrigin: string;
  docsUrl: string;
  quickstartUrl: string;
  githubUrl: string;
  managedFormUrl: string;
  enterpriseFormUrl: string;
  privacyUrl: string;
  walkthroughVideoUrl: string;
};

type SiteEnv = Record<string, string | undefined>;

const localDefaults: SiteConfig = {
  canonicalOrigin: "http://localhost:3004",
  docsUrl: "http://localhost:3002",
  quickstartUrl: "http://localhost:3002/quickstart",
  githubUrl: "https://github.com/visheshgubrani/vod",
  managedFormUrl:
    "mailto:hello@openvod.dev?subject=OpenVOD%20managed%20hosting%20waitlist",
  enterpriseFormUrl:
    "mailto:hello@openvod.dev?subject=OpenVOD%20enterprise%20deployment",
  privacyUrl: "http://localhost:3000/privacy",
  walkthroughVideoUrl: "/walkthrough.mp4",
};

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
    walkthroughVideoUrl:
      env.MARKETING_WALKTHROUGH_VIDEO_URL ?? localDefaults.walkthroughVideoUrl,
  };

  if (isProductionBuild(env)) {
    const missing = requiredEnv
      .filter(([, envName]) => !env[envName]?.trim())
      .map(([, envName]) => envName);

    if (missing.length > 0) {
      throw new Error(
        `[openvod-marketing] Missing required production destinations: ${missing.join(", ")}`,
      );
    }
  }

  return config;
}

export const siteConfig = getSiteConfig();
