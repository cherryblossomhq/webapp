import { test, expect, type Page } from "@playwright/test";

/**
 * Two people on one project, as two tabs of this build: its projects are this
 * browser's, its tabs share them through `localStorage` and see each other
 * through a `BroadcastChannel`, so the live sync and presence run here exactly
 * as they do between two accounts, with no backend. What the hosted app adds
 * (access, invitations) is tested there.
 */

/** The editor's own dashboard: this build mounts the editor at the site's root. */
const HOME = "/";

type Hook = {
  __cherryblossom: {
    projectApi: () => {
      project: { name: string; components: { id: string; ref: string }[] };
      commit: (fn: (p: unknown) => unknown) => void;
      undo: () => void;
    };
    uiApi: () => { select: (ids: string[]) => void; view: string };
    projectStore: { setState: (s: { role: string }) => void };
  };
};

const hook = (page: Page) => page.waitForFunction(() => "__cherryblossom" in window);

async function openTwice(page: Page) {
  await page.goto(HOME);
  await page.getByRole("button", { name: "New project" }).click();
  await expect(page.getByRole("textbox", { name: "Project name" })).toBeVisible();
  await hook(page);
  const other = await page.context().newPage();
  await other.goto(page.url());
  await expect(other.getByRole("textbox", { name: "Project name" })).toBeVisible();
  await hook(other);
  return other;
}

const addResistor = (page: Page, id: string) =>
  page.evaluate((id) => {
    (window as unknown as Hook).__cherryblossom.projectApi().commit((p) => {
      const project = p as { components: unknown[] };
      return {
        ...project,
        components: [
          ...project.components,
          { id, partId: "resistor", ref: "R1", props: { value: "10k" }, footprint: "0603", sch: { x: 0, y: 0, rot: 0 }, pcb: { x: 0, y: 0, rot: 0, side: "top", placed: false } },
        ],
      };
    });
  }, id);

test.describe("working on one project together", () => {
  test("each sees the other's edits, cursor and selection, and undo takes back only your own", async ({ page }) => {
    test.slow();
    const other = await openTwice(page);
    await expect(page.getByLabel("People on this project")).toBeVisible({ timeout: 10_000 });
    await expect(other.getByLabel("People on this project")).toBeVisible();

    await addResistor(page, "c_e2e");
    await expect.poll(() => other.evaluate(() => (window as unknown as Hook).__cherryblossom.projectApi().project.components.length)).toBe(1);

    // A pointer moving over one tab's canvas is a cursor on the other's.
    await page.evaluate(() => (window as unknown as Hook).__cherryblossom.uiApi().select(["c:c_e2e"]));
    const canvas = (await page.locator("main").first().boundingBox())!;
    for (let i = 0; i < 8; i++) {
      await page.mouse.move(canvas.x + canvas.width / 2 + i * 10, canvas.y + canvas.height / 2);
      await page.waitForTimeout(50);
    }
    await expect(other.locator("[data-peer-cursor]")).toHaveCount(1);

    // A rename in the other tab lands here.
    await other.getByRole("textbox", { name: "Project name" }).fill("Shared board");
    await other.getByRole("textbox", { name: "Project name" }).press("Enter");
    await expect(page.getByRole("textbox", { name: "Project name" })).toHaveValue("Shared board");

    // Undo here takes back this tab's resistor and leaves the other's rename.
    await page.evaluate(() => (window as unknown as Hook).__cherryblossom.projectApi().undo());
    await expect.poll(() => other.evaluate(() => (window as unknown as Hook).__cherryblossom.projectApi().project.components.length)).toBe(0);
    await expect(other.getByRole("textbox", { name: "Project name" })).toHaveValue("Shared board");
  });

  test("a part someone else deletes leaves your selection, and you're told", async ({ page }) => {
    const other = await openTwice(page);
    await addResistor(page, "c_gone");
    await expect.poll(() => other.evaluate(() => (window as unknown as Hook).__cherryblossom.projectApi().project.components.length)).toBe(1);
    await page.evaluate(() => (window as unknown as Hook).__cherryblossom.uiApi().select(["c:c_gone"]));
    await other.evaluate(() =>
      (window as unknown as Hook).__cherryblossom.projectApi().commit((p) => ({ ...(p as object), components: [] })),
    );
    await expect(page.getByText(/deleted R1, which you had selected/)).toBeVisible();
  });

  test("following someone takes you to their view", async ({ page }) => {
    const other = await openTwice(page);
    await expect(other.getByRole("button", { name: /^Follow / })).toBeVisible({ timeout: 10_000 });
    await other.getByRole("button", { name: /^Follow / }).click();
    await expect(other.getByText(/^Following /)).toBeVisible();
    await page.getByRole("tab", { name: "PCB" }).click();
    await expect.poll(() => other.evaluate(() => (window as unknown as Hook).__cherryblossom.uiApi().view)).toBe("pcb");
    // Esc hands the view back.
    await other.keyboard.press("Escape");
    await expect(other.getByText(/^Following /)).toHaveCount(0);
  });
});

// The Share dialog and a signed-out visitor need an account, which this build has none of: the
// hosted app's own suite covers them.
test.describe("viewers", () => {
  test("a viewer looks, and is told when they try to change something", async ({ page }) => {
    await page.goto(HOME);
    await page.getByRole("button", { name: "New project" }).click();
    await expect(page.getByRole("textbox", { name: "Project name" })).toBeVisible();
    await hook(page);
    await page.evaluate(() => (window as unknown as Hook).__cherryblossom.projectStore.setState({ role: "viewer" }));
    await expect(page.getByText("View only")).toBeVisible();
    await expect(page.getByRole("button", { name: "Wire", exact: true })).toBeDisabled();
    await page.evaluate(() => (window as unknown as Hook).__cherryblossom.projectApi().commit((p) => ({ ...(p as object), name: "Changed" })));
    await expect(page.getByText(/You can view this project, not change it/)).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Project name" })).not.toHaveValue("Changed");
  });
});
