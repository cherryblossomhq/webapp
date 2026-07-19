import { test, expect } from "@playwright/test";

test.describe("editor smoke", () => {
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

  test("empty-schematic composer routes signed-out users to managed AI settings", async ({
    page,
  }) => {
    await page.goto("/");

    const composer = page.getByPlaceholder(/add an ESP32/i);
    await expect(composer).toBeVisible({ timeout: 15_000 });

    // Sending while signed out must not fire a doomed model request. It routes
    // the user to Settings → AI, where managed AI sign-in is explained.
    await composer.fill("add an ESP32 with a 3V3 regulator");
    await page.getByRole("button", { name: /send to ai/i }).click();

    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings.getByRole("heading", { name: "Premium" })).toBeVisible();
    await expect(settings.getByText(/sign in to unlock managed AI/i)).toBeVisible();
  });
});
