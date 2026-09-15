import { expect, test } from "@playwright/test";

/**
 * The dashboard shell and shared surfaces, exercised without a session.
 *
 * These cover what the redesign changed structurally — the palette and type
 * scale reaching every surface, the responsive shell, and the route guard — and
 * are the parts of the dashboard that can be verified without an API, a
 * database, and a signed-in user.
 */

const MIN_TARGET = 44;

test.describe("public surfaces", () => {
  for (const [name, path] of [
    ["welcome", "/"],
    ["setup", "/setup"],
    ["login", "/login"],
    ["signup", "/signup"],
    ["privacy", "/privacy"],
  ] as const) {
    test(`${name} renders and keeps a readable measure`, async ({ page }) => {
      await page.goto(path);
      await expect(page.locator("body")).toBeVisible();
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow, `overflow on ${path}`).toBeLessThanOrEqual(0);
    });
  }

  test("login fields are labelled and every control clears 44px", async ({
    page,
  }) => {
    await page.goto("/login");

    for (const field of ["email", "password"]) {
      const input = page.locator(`#${field}`);
      await expect(input).toBeVisible();
      const box = await input.boundingBox();
      expect(box!.height, `${field} height`).toBeGreaterThanOrEqual(MIN_TARGET);
    }

    const labels = await page.evaluate(() =>
      Array.from(document.querySelectorAll("input")).map((input) => ({
        id: input.id,
        labelled: Boolean(
          input.labels?.length ||
            document.querySelector(`label[for="${input.id}"]`) ||
            input.getAttribute("aria-label"),
        ),
      })),
    );
    for (const { id, labelled } of labels) {
      expect(labelled, `input #${id} has no label`).toBe(true);
    }

    // Every interactive control, including links styled as buttons. The
    // Next.js dev-tools overlay is excluded: it is not part of the product and
    // does not exist in a production build.
    const controls = await page
      .locator(
        'main button, main a[class*="h-"], main input[type="submit"], form button',
      )
      .all();
    const tooSmall: string[] = [];
    for (const control of controls) {
      const box = await control.boundingBox();
      if (!box || box.width === 0 || box.height === 0) continue;
      if (box.height < MIN_TARGET) {
        tooSmall.push(
          `${(await control.getAttribute("aria-label")) ?? (await control.textContent())?.trim().slice(0, 24)} = ${Math.round(box.height)}px`,
        );
      }
    }
    expect(tooSmall, "controls under 44px").toEqual([]);
  });
});

test.describe("shell", () => {
  test("sends an unauthenticated visitor to the login page", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForURL(/\/login/, { timeout: 20_000 });
    expect(page.url()).toContain("/login");
  });

  test("does not carry the retired palette anywhere in the built CSS", async ({
    request,
  }) => {
    const html = await (await request.get("/")).text();
    const hrefs = Array.from(
      html.matchAll(/href="([^"]+\.css[^"]*)"/g),
      (match) => match[1],
    );
    expect(hrefs.length).toBeGreaterThan(0);

    for (const href of hrefs) {
      const css = await (await request.get(href)).text();
      for (const banned of [
        "704fd5",
        "9666ea",
        "mauve",
        "lavender",
        "gradient-text",
        "font-dashboard-heading",
      ]) {
        expect(css, `${banned} in ${href}`).not.toContain(banned);
      }
      // The new tokens must actually be present.
      expect(css).toContain("#171715");
      expect(css).toContain("#c2410c");
    }
  });
});
