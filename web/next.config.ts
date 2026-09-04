import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone server output: supports both Vercel (auto-detected) and the
  // VPS Docker image (web/Dockerfile copies .next/standalone).
  output: "standalone",
};

export default nextConfig;
