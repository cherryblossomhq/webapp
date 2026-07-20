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

  test("empty-schematic composer opens anonymous managed AI chat", async ({
    page,
  }) => {
    await page.goto("/");

    const composer = page.getByPlaceholder(/add an ESP32/i);
    await expect(composer).toBeVisible({ timeout: 15_000 });

    // Signed-out visitors can use the anonymous managed AI tier. Sending opens
    // the chat rail immediately; the server enforces the anonymous limits.
    await composer.fill("add an ESP32 with a 3V3 regulator");
    await page.getByRole("button", { name: /send to ai/i }).click();

    await expect(page.getByText("AI Assistant", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /managed model: auto model/i }),
    ).toBeVisible();
  });

  test("3D viewer recovers when its lazy module fails to load once", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem("cherryblossom:showCodeTab", "1");
    });
    let blockViewerModule = false;
    let blockedRequests = 0;

    await page.route("**/*3d-viewer*", async (route) => {
      if (blockViewerModule && blockedRequests === 0) {
        blockedRequests += 1;
        await route.abort("failed");
        return;
      }
      await route.continue();
    });

    await page.goto("/");
    await expect(page.getByText(/your schematic is empty/i)).toBeVisible({
      timeout: 15_000,
    });

    await page.getByText("Code", { exact: true }).click();
    const editor = page.locator(".cm-content");
    await editor.waitFor({ state: "visible", timeout: 15_000 });
    const source = await editor.innerText();
    await editor.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.insertText(source.replace('width="50mm"', 'width="51mm"'));
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(page.getByText("In sync", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () => localStorage.getItem("cherryblossom_autosave")?.includes("51mm") ?? false,
      ),
    ).toBe(false);

    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.insertText("\n// recovery-draft");
    await expect(page.getByText("Unsaved edits", { exact: true })).toBeVisible();

    blockViewerModule = true;
    await page.getByText("3D", { exact: true }).click();

    await expect.poll(() => blockedRequests).toBe(1);
    await expect(page.getByText("Engine: JSCAD", { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(/viewer crashed/i)).toHaveCount(0);

    await page.getByText("Code", { exact: true }).click();
    await expect(page.locator(".cm-content")).toContainText("51mm");
    await expect(page.locator(".cm-content")).toContainText("recovery-draft");
    await expect(page.getByText("Unsaved edits", { exact: true })).toBeVisible();
  });

  test("paused 3D recovery resumes after transient work is cleared", async ({
    page,
  }) => {
    let blockedRequests = 0;
    await page.route("**/*3d-viewer*", async (route) => {
      if (blockedRequests === 0) {
        blockedRequests += 1;
        await route.abort("failed");
        return;
      }
      await route.continue();
    });

    await page.goto("/");
    await expect(page.getByText(/your schematic is empty/i)).toBeVisible({
      timeout: 15_000,
    });
    await page.evaluate(() => {
      const draft = document.createElement("textarea");
      draft.id = "reload-guard-draft";
      draft.value = "work in progress";
      document.body.appendChild(draft);
    });

    await page.getByText("3D", { exact: true }).click();
    await expect(page.getByText(/reload was paused to protect/i)).toBeVisible({
      timeout: 15_000,
    });
    expect(blockedRequests).toBe(1);

    await page.locator("#reload-guard-draft").evaluate((draft) => draft.remove());
    await page.addInitScript(() => {
      if (
        sessionStorage.getItem("cherryblossom:cadImportReloaded") === "1"
      ) {
        sessionStorage.setItem("test:observedCadImportReload", "1");
      }
    });
    await page.getByRole("button", { name: "Reload app" }).click();

    await expect
      .poll(() =>
        page.evaluate(() =>
          sessionStorage.getItem("test:observedCadImportReload"),
        ),
      )
      .toBe("1");
    await expect(page.getByText("Engine: JSCAD", { exact: true })).toBeVisible({
      timeout: 20_000,
    });
  });

  test("3D viewer contains a repeated module failure without a reload loop", async ({
    page,
  }) => {
    let blockedRequests = 0;
    await page.route("**/*3d-viewer*", async (route) => {
      if (blockedRequests < 2) {
        blockedRequests += 1;
        await route.abort("failed");
        return;
      }
      await route.continue();
    });

    await page.goto("/");
    await expect(page.getByText(/your schematic is empty/i)).toBeVisible({
      timeout: 15_000,
    });
    await page.getByText("3D", { exact: true }).click();

    await expect.poll(() => blockedRequests).toBe(2);
    await expect(page.getByText(/could not be loaded after refreshing/i)).toBeVisible({
      timeout: 20_000,
    });
    await page.waitForTimeout(500);
    expect(blockedRequests).toBe(2);

    await page.getByText("Schematic", { exact: true }).click();
    await expect(page.getByText(/your schematic is empty/i)).toBeVisible();
  });
});
