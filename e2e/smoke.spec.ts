import { test, expect } from "@playwright/test";

test.describe("editor smoke", () => {
  test("editor loads and shows the empty board placeholder", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("pageerror", (err) => consoleErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto("/");

    // The read-only schematic's empty state shows a placeholder ("Your
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

  test("the empty state hands off to the Code tab", async ({ page }) => {
    await page.goto("/");

    const openCode = page.getByRole("button", { name: /open the code tab/i });
    await expect(openCode).toBeVisible({ timeout: 15_000 });

    // The Code tab is where a circuit is authored, so the empty state routes
    // there. This asserts the hand-off lands on a mounted editor, not just that
    // the tab button flips state.
    await openCode.click();

    await expect(page.getByRole("tab", { name: "Code", selected: true })).toBeVisible();
    await expect(page.locator(".cm-content")).toBeVisible({ timeout: 15_000 });
  });
});
