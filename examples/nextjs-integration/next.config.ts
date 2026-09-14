import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Monorepo: the workspace packages live two levels up, so trace against the
  // repo root (`output: "standalone"` would otherwise bundle only this folder).
  outputFileTracingRoot: path.join(__dirname, "..", ".."),
  // `next build` must not need the OpenVOD API. Every route that talks to it is
  // dynamic and reads its config at request time — see `lib/openvod.ts`.
  output: "standalone",
  // The OpenVOD packages ship ESM from `dist/` and `@openvod/player` inlines its
  // CSS into the JS bundle; transpiling keeps both working under Turbopack.
  transpilePackages: ["@openvod/player", "@openvod/uploader", "@openvod/server"],
};

export default nextConfig;
