import { expect, test } from "@playwright/test";

/**
 * Marketing page behaviour that a build cannot prove: the media fallback
 * policy, the integration tabs, anchor navigation under a sticky header, and
 * the reduced-motion / no-JavaScript guarantees.
 *
 * The `public/media` files are supplied separately, so most of these tests run
 * against the *missing asset* state on purpose — that is the state a fresh
 * checkout is in, and the page has to stay usable in it.
 */

test.describe("hero", () => {
  test("states the product and offers both calls to action", async ({ page }) => {
    await page.goto("/");

    await expect(
      page.getByRole("heading", { level: 1, name: /Your videos\.\s*Your infrastructure\./ }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Start self-hosting/ }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Watch the product tour/ }),
    ).toBeVisible();
    await expect(
      page.getByText("Apache-2.0 · Self-hostable · Infrastructure costs apply."),
    ).toBeVisible();
  });

  test("the tour link moves focus into the player", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /Watch the product tour/ }).click();
    await page.waitForTimeout(900);

    const focusedId = await page.evaluate(() => document.activeElement?.id);
    expect(focusedId).toBe("product-tour");
  });

  test("keeps the poster and offers a retry when the clip is missing", async ({
    page,
  }) => {
    await page.goto("/#product-tour");

    // The placeholder assets are absent, so the element reports an error.
    await expect(page.getByText("This clip could not load.")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();

    // The poster is still attached, and no implementation detail leaks into the
    // visitor-facing copy.
    const video = page.locator("#product-tour video");
    await expect(video).toHaveAttribute("poster", /hero-poster\.jpg$/);
    await expect(page.locator("#product-tour")).not.toContainText(
      /\/media\/|\.mp4`|public\//,
    );
  });

  test("treats a refused autoplay as 'press play', not as a broken file", async ({
    page,
  }) => {
    // Make every programmatic play() reject, the way a strict autoplay policy
    // would. The frame must fall back to the poster with a working control.
    await page.addInitScript(() => {
      HTMLMediaElement.prototype.play = function play() {
        return Promise.reject(new DOMException("NotAllowedError"));
      };
    });
    await page.goto("/#product-tour");
    await page.waitForTimeout(1200);

    await expect(
      page.getByRole("button", { name: "Play the product tour" }),
    ).toBeVisible();
    await expect(page.getByText("This clip could not load.")).toHaveCount(0);
  });
});

test.describe("integration tabs", () => {
  test("expose real tab semantics and swap code with the keyboard", async ({
    page,
  }) => {
    await page.goto("/#developers");
    await expect(page.getByRole("tablist", { name: "Integration steps" })).toBeVisible();

    const tokenTab = page.getByRole("tab", { name: "Create a token" });
    await expect(tokenTab).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".code-panel-file strong")).toHaveText(
      "app/api/upload-token/route.ts",
    );
    await expect(page.locator(".code-panel-scope")).toHaveText("Server");

    await tokenTab.focus();
    await page.keyboard.press("ArrowRight");

    const uploadTab = page.getByRole("tab", { name: "Upload" });
    await expect(uploadTab).toHaveAttribute("aria-selected", "true");
    await expect(uploadTab).toBeFocused();
    await expect(page.locator(".code-panel-file strong")).toHaveText(
      "app/upload-form.tsx",
    );
    await expect(page.locator(".code-panel-scope")).toHaveText("Browser");
    await expect(page.locator('[role="tabpanel"]')).toHaveAccessibleName(
      "Upload",
    );
  });

  test("every tab shows a filename, a surface and a result", async ({ page }) => {
    await page.goto("/#developers");
    await expect(page.getByRole("tablist", { name: "Integration steps" })).toBeVisible();

    for (const [tab, file, scope] of [
      ["Create a token", "app/api/upload-token/route.ts", "Server"],
      ["Upload", "app/upload-form.tsx", "Browser"],
      ["Play", "app/video-player.tsx", "Browser"],
      ["Receive events", "app/api/webhooks/clipmux/route.ts", "Server"],
    ] as const) {
      await page.getByRole("tab", { name: tab }).click();
      await expect(page.locator(".code-panel-file strong")).toHaveText(file);
      await expect(page.locator(".code-panel-scope")).toHaveText(scope);
      await expect(page.locator(".code-body code")).not.toBeEmpty();
      await expect(page.locator(".result-panel-head")).not.toBeEmpty();
    }
  });

  test("the copy control confirms without a page reload", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/#developers");
    await expect(page.getByRole("tablist", { name: "Integration steps" })).toBeVisible();

    const copy = page.getByRole("button", { name: "Copy this example" });
    await copy.click();
    await expect(
      page.getByRole("button", { name: "Code copied" }),
    ).toBeVisible();

    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain("uploads.createToken");
  });
});

test.describe("navigation and FAQ", () => {
  test("anchors land below the sticky header", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Platform", exact: true }).click();
    await page.waitForTimeout(1200);

    const geometry = await page.evaluate(() => ({
      header: document
        .querySelector(".site-header")!
        .getBoundingClientRect().height,
      label: document
        .querySelector("#platform .section-label")!
        .getBoundingClientRect().top,
    }));

    expect(geometry.label).toBeGreaterThan(geometry.header);
  });

  test("FAQ answers open and close, and stay in the DOM without JavaScript", async ({
    page,
    browser,
  }) => {
    await page.goto("/#faq");
    const first = page.locator(".faq-item").first();
    await first.locator("summary").click();
    await expect(first).toHaveAttribute("open", "");

    const noJs = await browser.newContext({ javaScriptEnabled: false });
    const bare = await noJs.newPage();
    await bare.goto("/");
    await expect(
      bare.getByRole("heading", { level: 1, name: /Your videos\./ }),
    ).toBeVisible();
    await expect(
      bare.getByRole("heading", { name: "Your files stay in your buckets." }),
    ).toBeVisible();

    // A native <details> needs no JavaScript: the answer is in the markup and
    // opens on the summary, which is the whole point of the noscript fallback.
    const item = bare.locator(".faq-item").first();
    await expect(item.locator(".faq-answer")).toBeHidden();
    await item.locator("summary").click();
    await expect(item.locator(".faq-answer")).toBeVisible();
    await noJs.close();
  });
});

test.describe("motion and layout", () => {
  test("reduced motion shows all three workflow scenes at once", async ({
    browser,
  }) => {
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto("/#workflow");

    const scenes = page.locator("[data-workflow-scene]");
    await expect(scenes).toHaveCount(3);
    for (let index = 0; index < 3; index += 1) {
      await expect(scenes.nth(index)).toBeVisible();
    }
    await expect(page.locator(".workflow-scenes")).not.toHaveAttribute(
      "data-animated",
      "true",
    );

    // Every explanation is available without scrolling through a sequence.
    await expect(
      page.getByRole("heading", { name: "One upload. Ready for playback." }),
    ).toBeVisible();
    await context.close();
  });

  test("no width overflows horizontally", async ({ page }) => {
    for (const width of [360, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await page.waitForTimeout(500);
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow, `overflow at ${width}px`).toBeLessThanOrEqual(0);
    }
  });

  test("reserves the hero frame so the page does not shift", async ({ page }) => {
    await page.goto("/");
    const box = await page.locator("#product-tour video").boundingBox();
    expect(box).not.toBeNull();
    // 16:9, set by the video's own width/height attributes.
    expect(box!.width / box!.height).toBeCloseTo(16 / 9, 1);
  });
});
