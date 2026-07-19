import { test, expect } from "@playwright/test";

// Pin the viewport so the resize geometry (clamp max, snap presets) is
// deterministic regardless of the CI default — otherwise the drag-widen
// assertion can be sensitive to row width.
test.use({ viewport: { width: 1280, height: 800 } });

// Regression coverage for the resizable chat rail. Width assertions use
// expect.poll so they settle past the open/close width transition.
test("chat rail opens, drag-resizes, and closes back to properties", async ({
  page,
}) => {
  await page.goto("/");

  // Open chat — it replaces the right rail (no Properties/Chat tabs).
  await page.getByRole("button", { name: /Open AI chat/i }).click();
  const closeButton = page.getByRole("button", { name: "Close chat" });
  await expect(closeButton).toBeVisible();

  const handle = page.getByRole("separator", { name: /Resize chat panel/i });
  await expect(handle).toBeVisible();

  const aside = page
    .locator("aside")
    .filter({ has: closeButton });
  const widthOf = async () => (await aside.boundingBox())!.width;
  await expect.poll(widthOf).toBeGreaterThan(400);
  const opened = await widthOf();

  // Drag the handle left to widen the rail.
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x - 220, hb.y + hb.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect.poll(widthOf).toBeGreaterThan(opened + 100);

  // Closing chat returns the rail to the Properties panel.
  await closeButton.click();
  await expect(closeButton).toBeHidden();
  await expect(page.getByText("Properties", { exact: true })).toBeVisible();
});
