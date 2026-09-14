import type { NextConfig } from "next";

import { getSiteConfig } from "./lib/site-config";

if (process.env.NODE_ENV === "production") {
  getSiteConfig();
}

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
