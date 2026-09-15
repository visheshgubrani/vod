import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Monorepo: the workspace packages live two levels up, so trace against the
  // repo root (`output: "standalone"` would otherwise bundle only this folder).
  outputFileTracingRoot: path.join(__dirname, "..", ".."),
  // `next build` must not need the ClipMux API. Every route that talks to it is
  // dynamic and reads its config at request time — see `lib/clipmux.ts`.
  output: "standalone",
  // The ClipMux packages ship ESM from `dist/` and `@clipmux/player` inlines its
  // CSS into the JS bundle; transpiling keeps both working under Turbopack.
  transpilePackages: ["@clipmux/player", "@clipmux/uploader", "@clipmux/server"],
};

export default nextConfig;
