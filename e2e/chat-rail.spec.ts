import { test, expect } from "@playwright/test";

// Pin the viewport so the resize geometry (clamp max, snap presets) is
// deterministic regardless of the CI default — otherwise the drag-widen
// assertion can be sensitive to row width.
test.use({ viewport: { width: 1280, height: 800 } });

// Regression coverage for the resizable chat rail and the collapsible left
// components column. Width assertions use expect.poll so they settle past the
// open/close width transition.
test("chat rail opens, drag-resizes, and closes back to properties", async ({
  page,
}) => {
  await page.goto("/");

  // Open chat — it replaces the right rail (no Properties/Chat tabs).
  await page.getByRole("button", { name: /Open AI chat/i }).click();
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();

  const handle = page.getByRole("separator", { name: /Resize chat panel/i });
  await expect(handle).toBeVisible();

  const aside = page
    .locator("aside")
    .filter({ has: page.getByRole("button", { name: "Send message" }) });
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
  await page.getByRole("button", { name: "Close chat" }).click();
  await expect(page.getByRole("button", { name: "Send message" })).toBeHidden();
});

test("left components column collapses and expands", async ({ page }) => {
  await page.goto("/");

  // Library is visible by default.
  await expect(page.getByPlaceholder("Search components...")).toBeVisible();

  // Collapse it.
  await page.getByRole("button", { name: "Collapse components panel" }).click();
  await expect(page.getByPlaceholder("Search components...")).toBeHidden();

  // Expand it again.
  await page.getByRole("button", { name: "Expand components panel" }).click();
  await expect(page.getByPlaceholder("Search components...")).toBeVisible();
});
