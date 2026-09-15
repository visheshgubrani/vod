import { defineConfig, devices } from "@playwright/test";

/**
 * Focused browser coverage for the two front ends.
 *
 * The suite is deliberately small: it exercises the media fallback paths, the
 * integration tabs, anchor navigation, and the marketing page's
 * reduced-motion / no-JavaScript guarantees. Those are the behaviours a build
 * or a unit test cannot prove.
 *
 *   pnpm test:e2e              # both projects
 *   pnpm test:e2e -- --project=marketing
 *
 * Authenticated dashboard flows need a real session and are skipped unless
 * `E2E_STORAGE_STATE` points at a Playwright storage-state file — see
 * `e2e/README.md`.
 */
// Ports are overridable so a busy machine can move a server aside:
//   E2E_MARKETING_PORT=3005 pnpm test:e2e --project=marketing
const marketingPort = process.env.E2E_MARKETING_PORT ?? "3004";
const webPort = process.env.E2E_WEB_PORT ?? "3000";

export default defineConfig({
  testDir: "./specs",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    trace: "on-first-retry",
    // `localhost`, not `127.0.0.1`: a captured storage-state file scopes its
    // cookies to the host it was recorded against, and the two are not
    // interchangeable to a cookie jar.
    ...devices["Desktop Chrome"],
  },

  projects: [
    {
      name: "marketing",
      testMatch: /marketing\.spec\.ts/,
      use: { baseURL: `http://localhost:${marketingPort}` },
    },
    {
      name: "web",
      testMatch: /web-.*\.spec\.ts/,
      use: { baseURL: `http://localhost:${webPort}` },
    },
    {
      name: "dashboard",
      testMatch: /dashboard\.spec\.ts/,
      // One worker: these all share a single signed-in session, and firing them
      // concurrently trips the API's own session rate limit.
      fullyParallel: false,
      use: { baseURL: `http://localhost:${webPort}` },
    },
  ],

  webServer: [
    {
      command: `pnpm --filter clipmux-marketing exec next dev -p ${marketingPort}`,
      url: `http://localhost:${marketingPort}`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: {
        // The test run must not depend on real docs or hosted-form URLs.
        MARKETING_ALLOW_LOCAL_DEFAULTS: "1",
      },
    },
    {
      command: `pnpm --filter web exec next dev -p ${webPort}`,
      url: `http://localhost:${webPort}`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
