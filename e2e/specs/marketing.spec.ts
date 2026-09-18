import { expect, test } from "@playwright/test";

/**
 * Marketing page behaviour that a build cannot prove: the media fallback
 * policy, the single code example, anchor navigation under a sticky header,
 * the no-JavaScript guarantees, and the shape of the redesign — no imagery
 * below the hero, no entrance animations, and no managed or enterprise offer.
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

test.describe("developer example", () => {
  test("shows one browser example with its filename and surface", async ({
    page,
  }) => {
    await page.goto("/#developers");

    const panel = page.locator("#developers .code-panel");
    await expect(panel.locator(".code-panel-file strong")).toHaveText(
      "app/upload-form.tsx",
    );
    await expect(panel.locator(".code-panel-scope")).toHaveText("Browser");
    await expect(panel.locator(".code-body code")).not.toBeEmpty();
    await expect(panel.locator(".code-body code")).toContainText("startUpload");

    // Where the upload token comes from is the point of the section.
    await expect(page.locator("#developers")).toContainText(
      "app/api/upload-token/route.ts",
    );

    // The tabbed tutorial is gone: one example, one panel.
    await expect(panel).toHaveCount(1);
    await expect(page.getByRole("tablist")).toHaveCount(0);
  });

  test("the copy control confirms without a page reload", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/#developers");

    const section = page.locator("#developers");
    await section
      .getByRole("button", { name: "Copy this example" })
      .click();
    await expect(
      section.getByRole("button", { name: "Code copied" }),
    ).toBeVisible();

    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain("startUpload");
  });
});

test.describe("self-hosting and offers", () => {
  test("shows the bootstrap command and the single hosting path", async ({
    page,
  }) => {
    await page.goto("/#hosting");

    await expect(page.locator("#hosting .code-panel-file strong")).toHaveText(
      "scripts/bootstrap.sh",
    );
    await expect(page.locator("#hosting .code-panel-scope")).toHaveText("Shell");
    await expect(page.locator("#hosting .code-body code")).toContainText(
      "./scripts/bootstrap.sh",
    );
    await expect(
      page.locator("#hosting").getByRole("link", { name: /Start self-hosting/ }),
    ).toBeVisible();
  });

  test("no managed or enterprise offer is on the page", async ({ page }) => {
    await page.goto("/");

    await expect(page.locator("body")).not.toContainText(/managed hosting/i);
    await expect(page.locator("body")).not.toContainText(/enterprise/i);
    await expect(page.locator("body")).not.toContainText(/interest list/i);
    await expect(page.locator('a[href*="managed"], a[href*="enterprise"]')).toHaveCount(0);
  });

  test("the architecture diagram and the hosting comparison are gone", async ({
    page,
  }) => {
    await page.goto("/#ownership");

    await expect(page.locator("#ownership svg")).toHaveCount(0);
    await expect(page.locator("#ownership")).toContainText(
      "Your files stay in your buckets.",
    );

    // One comparison-free hosting section.
    await expect(page.locator("#hosting .hosting-card")).toHaveCount(0);
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

  test("the renamed self-hosting anchor still lands below the header", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Self-hosting", exact: true }).click();
    await page.waitForTimeout(1200);

    const geometry = await page.evaluate(() => ({
      header: document
        .querySelector(".site-header")!
        .getBoundingClientRect().height,
      label: document
        .querySelector("#hosting .section-label")!
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

test.describe("the redesign's shape", () => {
  test("ships no imagery below the hero", async ({ page }) => {
    await page.goto("/");

    // Every image below the hero is gone, so the missing-asset state of a fresh
    // checkout cannot render broken thumbnails.
    await expect(page.locator("main img")).toHaveCount(0);
    await expect(page.locator("main video")).toHaveCount(1);
    await expect(page.locator("#platform .library-row")).toHaveCount(3);
  });

  test("carries no below-hero entrance animation", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("[data-reveal]")).toHaveCount(0);
    await expect(page.locator("[data-workflow-scene]")).toHaveCount(0);
  });

  test("every workflow step is readable at once, with motion reduced", async ({
    browser,
  }) => {
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto("/#workflow");

    for (const step of ["Upload", "Process", "Play"]) {
      await expect(
        page.locator("#workflow").getByRole("heading", { name: step, exact: true }),
      ).toBeVisible();
    }

    await expect(
      page.getByRole("heading", { name: "One upload. Ready for playback." }),
    ).toBeVisible();
    await context.close();
  });

  test("no width overflows horizontally", async ({ page }) => {
    for (const width of [320, 360, 390, 768, 1024, 1280, 1440]) {
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
