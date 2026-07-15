import { test, expect } from "@playwright/test";

// Phase 0 smoke: prove the editor mounts in a browser and the foundational
// stores wire up cleanly. Anything richer is a Phase 1+ E2E concern (those
// tests live in this file's siblings).

test.describe("Phase 0 smoke", () => {
  test("editor loads and shows the empty board placeholder", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("pageerror", (err) => consoleErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto("/");

    // The read-only schematic's empty state shows an AI composer ("Your
    // schematic is empty" + a prompt box) until the user builds something —
    // that's enough to prove the UI is alive.
    await expect(page.getByText(/your schematic is empty/i)).toBeVisible({
      timeout: 15_000,
    });

    // Ignore noisy resource/preload errors from lazy chunks still streaming
    // in. Anything else is a real regression.
    const ignorable = [
      /Failed to load resource/i,
      /preload/i,
    ];
    const realErrors = consoleErrors.filter(
      (e) => !ignorable.some((re) => re.test(e))
    );
    expect(realErrors, `unexpected page errors: ${realErrors.join("\n")}`).toEqual([]);
  });

  test("empty-schematic composer routes to Settings when no API key is set", async ({
    page,
  }) => {
    await page.goto("/");

    const composer = page.getByPlaceholder(/add an ESP32/i);
    await expect(composer).toBeVisible({ timeout: 15_000 });

    // With no API key configured, sending must not fire a doomed request — it
    // routes the first-timer to Settings → AI to add their key instead.
    await composer.fill("add an ESP32 with a 3V3 regulator");
    await page.getByRole("button", { name: /send to ai/i }).click();

    // Settings → AI is now open (unique to that tab: the console key button).
    await expect(
      page.getByRole("button", { name: /anthropic console/i })
    ).toBeVisible();
  });
});
