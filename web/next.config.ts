import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Monorepo: trace standalone output against the workspace root so `next`
  // and friends are included in .next/standalone.
  outputFileTracingRoot: path.join(__dirname, ".."),
  // Standalone server output: supports both Vercel (auto-detected) and the
  // VPS Docker image (web/Dockerfile copies .next/standalone).
  output: "standalone",
  // TODO(openvod): recharts 2.15 types drift against @types/react 19 on the
  // analytics pages; fix or bump recharts v3 rather than living with this.
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
