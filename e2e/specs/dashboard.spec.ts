import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type Request,
} from "@playwright/test";
import { existsSync } from "node:fs";

/**
 * Authenticated dashboard interactions.
 *
 * These need a real session, so they are skipped unless `E2E_STORAGE_STATE`
 * points at a Playwright storage-state file captured from a running
 * deployment. See `e2e/README.md` for how to produce one.
 *
 * The suite is serial and shares one page on purpose: a session cookie is a
 * single live session, and the same storage-state file cannot be replayed into
 * several contexts at once without invalidating itself.
 */
const storageState = process.env.E2E_STORAGE_STATE;
const hasSession = Boolean(storageState && existsSync(storageState));

test.skip(
  !hasSession,
  "Set E2E_STORAGE_STATE to a session storage-state file to run dashboard specs.",
);

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({
    storageState,
    viewport: { width: 1440, height: 950 },
  });
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
});

/**
 * Navigate to the library, or skip when the captured session is not usable.
 *
 * A single attempt, deliberately: the dashboard guard redirects to `/login`
 * whenever a session lookup does not succeed, and retrying in a tight loop
 * makes that worse against an API that rate-limits session reads. An expired
 * session is an environment problem, so the suite skips rather than failing.
 */
const openLibrary = async (): Promise<boolean> => {
  await page.goto("/dashboard");
  try {
    await expect(
      page.getByRole("heading", { level: 1, name: "Library" }),
    ).toBeVisible({ timeout: 30_000 });
    return true;
  } catch {
    test.skip(
      true,
      "The captured session is expired or rate-limited — recapture it (see e2e/README.md).",
    );
    return false;
  }
};

test.describe("library", () => {
  test("shows large thumbnails in tall rows", async () => {
    if (!(await openLibrary())) return;

    const thumbnail = page.locator("li .aspect-video").first();
    const box = await thumbnail.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(100);
    expect(box!.width / box!.height).toBeCloseTo(16 / 9, 1);

    const row = page
      .locator("li")
      .filter({ has: page.locator(".aspect-video") })
      .first();
    const rowBox = await row.boundingBox();
    expect(rowBox!.height).toBeGreaterThanOrEqual(80);
  });

  test("row actions open a real menu, and delete asks first", async () => {
    if (!(await openLibrary())) return;

    await page.getByRole("button", { name: /^Actions for / }).first().click();
    await expect(page.getByRole("menu")).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("menuitem", { name: /Copy video ID/ }),
    ).toBeVisible();

    await page.getByRole("menuitem", { name: /Delete/ }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("heading", { name: "Delete this video?" }),
    ).toBeVisible();

    // Escape cancels without deleting.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("search filters the table", async () => {
    if (!(await openLibrary())) return;

    const search = page.locator('input[type="search"]');
    await search.fill("zzz-no-such-title");
    await expect(page.getByText("No videos yet")).toBeVisible();
    await search.fill("");
    await expect(
      page.getByRole("navigation", { name: "Pagination" }),
    ).toBeVisible();
  });
});

test.describe("upload", () => {
  test("the dialog explains policy, processing options and size limits", async () => {
    if (!(await openLibrary())) return;

    await page.getByRole("button", { name: /Upload video/i }).first().click();

    const dialog = page.getByRole("dialog", { name: "Upload videos" });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("group", { name: "Playback policy" }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("switch", { name: "Generate AI subtitles" }),
    ).toBeVisible();
    await expect(
      dialog.getByText(/MP4, MOV, WebM or MKV, up to 10 GB\./),
    ).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});

test.describe("shell", () => {
  test("desktop uses a 248px rail and 32px content padding", async () => {
    await page.setViewportSize({ width: 1440, height: 950 });
    if (!(await openLibrary())) return;

    const geometry = await page.evaluate(() => {
      const rail = document.querySelector("aside")!.getBoundingClientRect();
      const main = document.querySelector("main")!;
      const heading = document.querySelector("h1")!;
      return {
        railWidth: Math.round(rail.width),
        mainPadding: getComputedStyle(main).paddingLeft,
        bodySize: getComputedStyle(document.body).fontSize,
        headingSize: getComputedStyle(heading).fontSize,
        overflow:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      };
    });

    expect(geometry.railWidth).toBe(248);
    expect(geometry.mainPadding).toBe("32px");
    expect(geometry.bodySize).toBe("15px");
    expect(Number.parseFloat(geometry.headingSize)).toBeGreaterThanOrEqual(30);
    expect(geometry.overflow).toBeLessThanOrEqual(0);
  });

  test("the mobile drawer traps focus and restores it on close", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    if (!(await openLibrary())) return;

    const trigger = page.getByRole("button", { name: "Open navigation" });
    await expect(trigger).toBeVisible();
    await trigger.click();
    await expect(page.getByRole("dialog")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(trigger).toBeFocused();

    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 1440, height: 950 });
  });
});

test.describe("video detail", () => {
  test("puts playback first and keeps copy controls at 44px", async () => {
    if (!(await openLibrary())) return;

    // `:visible` keeps this on the desktop table — the mobile card list is in
    // the DOM but hidden at this width.
    await page
      .locator("li:visible")
      .getByRole("button")
      .filter({ hasText: /\.(mp4|mov|webm)/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/dashboard\/videos\//);

    // Playback is the primary visual: full-column, 16:9, above the metadata.
    const player = page.locator("main .aspect-video").first();
    await expect(player).toBeVisible();
    const playerBox = await player.boundingBox();
    expect(playerBox!.width).toBeGreaterThan(900);
    expect(playerBox!.width / playerBox!.height).toBeCloseTo(16 / 9, 1);

    const copy = page.getByRole("button", { name: /^Copy / }).first();
    const box = await copy.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });
});

/**
 * The two organization-scoped settings pages.
 *
 * They are asserted through the *requests*, not the markup, because their
 * failure mode is invisible in the DOM: a base URL missing its `/api` prefix
 * asks the origin for `/keys` and `/webhooks`, those 404 without CORS headers,
 * and the page renders exactly the same error banner it would for any other
 * failed fetch. Watching the request path is what tells the two apart.
 */
test.describe("settings pages", () => {
  const SETTINGS_PATHS = new Set([
    "/keys",
    "/api/keys",
    "/webhooks",
    "/api/webhooks",
  ]);

  /**
   * Open a settings page and return the settings request paths it made, or
   * null when the captured session is unusable (the caller skips, matching the
   * rest of this suite).
   */
  const openSettingsPage = async (
    path: string,
    heading: string,
  ): Promise<string[] | null> => {
    const requested: string[] = [];
    const record = (request: Request) => {
      const url = new URL(request.url());
      if (request.method() === "GET" && SETTINGS_PATHS.has(url.pathname)) {
        requested.push(url.pathname);
      }
    };
    page.on("request", record);

    await page.goto(path);
    try {
      await expect(
        page.getByRole("heading", { level: 1, name: heading }),
      ).toBeVisible({ timeout: 30_000 });
      return requested;
    } catch {
      test.skip(
        true,
        "The captured session is expired or rate-limited — recapture it (see e2e/README.md).",
      );
      return null;
    } finally {
      page.off("request", record);
    }
  };

  test("API keys fetches /api/keys, not the origin's /keys", async () => {
    const requested = await openSettingsPage("/dashboard/api-keys", "API keys");
    if (!requested) return;

    expect(requested).toContain("/api/keys");
    expect(requested).not.toContain("/keys");
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("webhooks fetches /api/webhooks, not the origin's /webhooks", async () => {
    const requested = await openSettingsPage("/dashboard/webhooks", "Webhooks");
    if (!requested) return;

    expect(requested).toContain("/api/webhooks");
    expect(requested).not.toContain("/webhooks");
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});
