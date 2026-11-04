import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";

/** The editor's own dashboard: this build mounts the editor at the site's root. */
const HOME = "/";

/** The slice of the editor's development-only `window.__cherryblossom` hook these specs read. */
type EditorProject = ReturnType<EditorHook["__cherryblossom"]["projectApi"]>["project"];

type EditorHook = {
  __cherryblossom: {
    projectApi: () => {
      transientBase: unknown;
      commit: (fn: (p: EditorProject) => EditorProject) => void;
      project: {
        components: {
          id: string;
          ref: string;
          partId: string;
          props: Record<string, string>;
          footprint: string;
          sch: { x: number; y: number };
        }[];
        parts?: { id: string; name: string; footprint: string; source?: { pins: string; land: string; supplier?: { lcsc: string } } }[];
        blocks?: { id: string; name: string; components: string[] }[];
        wires: { id: string; points: { x: number; y: number }[] }[];
        labels: { id: string; name: string; x: number; y: number }[];
        models?: { part: string; footprint: string; model: { name: string } }[];
      };
    };
    getConnectivity: (project: EditorProject) => { pinNet: Map<string, string> };
    connectManagedAi: (host: {
      getAccessToken: () => Promise<string>;
      upgradeUrl?: string;
      accountUrl?: string;
      assistantsUrl?: string;
      assistantGuides?: Record<string, string>;
    }) => void;
    connectSupplierParts: (source: { search: (q: string) => Promise<unknown>; part: (id: string) => Promise<unknown> }) => void;
  };
};

const project = (page: Page) =>
  page.evaluate(() => (window as unknown as EditorHook).__cherryblossom.projectApi().project);

async function newProject(page: Page) {
  await page.goto(HOME);
  await page.getByRole("button", { name: "New project" }).click();
  await expect(page.getByRole("textbox", { name: "Project name" })).toBeVisible();
  await page.waitForFunction(() => "__cherryblossom" in window);
}

/** The parts library is closed when a project opens (Sakura is open): its tab on the canvas's edge opens it. */
async function openLibrary(page: Page) {
  await page.getByRole("button", { name: "Parts", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Parts library" })).toBeVisible();
}

/**
 * Opens the 3D tab and waits for the scene's canvas. The scene draws on a canvas or says WebGL
 * is off, so wait for either: a browser without WebGL then fails saying so, not as a canvas
 * that never came. 30 s, because the dev server may still be compiling the lazy 3D chunk.
 */
async function open3d(page: Page) {
  await page.getByRole("tab", { name: "3D" }).click();
  const noWebGL = page.getByText("The 3D view needs WebGL");
  await expect(page.locator("canvas").or(noWebGL).first()).toBeVisible({ timeout: 30_000 });
  await expect(noWebGL, "the 3D view found no WebGL in this browser").toHaveCount(0);
}

// The editor as it ships: bundled by Vite and mounted by `host/main.tsx`.
// What can break there is bundling, not editing — the
// stylesheet, the lazy 3D chunk, the examples' JSON — and none of it is
// visible to the package's own unit tests.
test.describe("editor smoke", () => {
  test("boots with its examples drawn, and opens a project", async ({ page }) => {
    // The first spec to reach the page: the dev server compiles it and then the 3D
    // chunk on demand, which can take most of the default 30 s on a CI runner.
    test.slow();
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.goto(HOME);
    await expect(page.getByRole("heading", { name: "Projects", level: 1 })).toBeVisible({
      timeout: 15_000,
    });

    // The examples ship routed, so every card's board is drawn with the page: in the preview worker, as an SVG
    // shown as an image once the card nears view (`LazyPreview`), and decoded, not a broken image.
    const examples = page.getByRole("button", { name: /\d+ parts · / });
    await expect(examples).toHaveCount(5);
    for (const card of await examples.all()) {
      await card.scrollIntoViewIfNeeded();
      const drawn = card.locator("img");
      await expect(drawn).toHaveAttribute("src", /^blob:/, { timeout: 15_000 });
      await expect.poll(() => drawn.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    }

    await page.getByRole("button", { name: "New project" }).click();
    await expect(page.getByRole("textbox", { name: "Project name" })).toBeVisible();
    await open3d(page);

    expect(pageErrors, `unexpected page errors: ${pageErrors.join("\n")}`).toEqual([]);
  });

  test("an example opens at once, as a copy of its own", async ({ page }) => {
    await page.goto(HOME);
    await page.getByRole("button", { name: /ESP32 robot controller/ }).click();
    await expect(page.getByRole("textbox", { name: "Project name" })).toHaveValue(/ESP32/i, {
      timeout: 5_000,
    });
    await page.goto(HOME);
    await expect(page.getByRole("list").getByRole("button", { name: "Open ESP32 robot controller" })).toBeVisible();
  });

  test("the dashboard's logo leads back to the site", async ({ page }) => {
    await page.goto(HOME);
    await expect(page.getByRole("link", { name: "Cherry Blossom" })).toHaveAttribute("href", "/");
  });

  test("without an account there is no account menu, and the dashboard is the editor's own", async ({ page }) => {
    await page.goto(HOME);
    await page.getByRole("button", { name: /555 LED blinker/ }).click();
    await expect(page.getByRole("textbox", { name: "Project name" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Account" })).toHaveCount(0);
    await page.getByRole("button", { name: "All projects" }).click();
    await expect(page.getByRole("heading", { name: "Projects", level: 1 })).toBeVisible();
    await expect(page).toHaveURL(HOME);
    // Back is the project again, without a page load.
    await page.goBack();
    await expect(page.getByRole("textbox", { name: "Project name" })).toHaveValue(/555/);
  });

  test("a part dragged off the canvas and released over a panel stays where it was dropped", async ({
    page,
  }) => {
    await page.goto(HOME);
    await page.getByRole("button", { name: /555 LED blinker/ }).click();
    await expect(page.getByRole("textbox", { name: "Project name" })).toBeVisible();
    // The hook (src/index.ts) and the canvas's world transform locate a part.
    await page.waitForFunction(() => "__cherryblossom" in window);
    const part = await page.evaluate(() => {
      const api = (window as unknown as EditorHook).__cherryblossom.projectApi();
      const c = api.project.components.find((x) => !x.ref.startsWith("#"))!;
      const g = document.querySelector('svg > g[transform^="matrix"]')!;
      const m = g.getAttribute("transform")!.match(/matrix\(([^)]+)\)/)![1].split(",").map(Number);
      const host = g.closest("div")!.getBoundingClientRect();
      return { id: c.id, x: host.left + c.sch.x * m[0] + m[4], y: host.top + c.sch.y * m[3] + m[5] };
    });
    const state = () =>
      page.evaluate((id) => {
        const api = (window as unknown as EditorHook).__cherryblossom.projectApi();
        return { dragging: !!api.transientBase, at: api.project.components.find((c) => c.id === id)!.sch };
      }, part.id);

    await page.mouse.move(part.x, part.y);
    await page.mouse.down();
    await page.mouse.move(part.x + 40, part.y + 10, { steps: 5 });
    await page.mouse.move(page.viewportSize()!.width - 20, part.y, { steps: 10 });
    await page.mouse.up();
    const dropped = await state();
    expect(dropped.dragging).toBe(false);

    await page.mouse.move(part.x - 60, part.y - 60, { steps: 5 });
    expect((await state()).at).toEqual(dropped.at);
  });

  test("the net label tool names a pin's net on a click", async ({ page }) => {
    await newProject(page);
    await page.evaluate(() =>
      (window as unknown as EditorHook).__cherryblossom.projectApi().commit((p) => ({
        ...p,
        components: [
          ...p.components,
          {
            id: "c_r1",
            ref: "R1",
            partId: "resistor",
            props: { resistance: "10k" },
            footprint: "0603",
            sch: { x: 0, y: 0, rot: 0 },
            pcb: { x: 0, y: 0, rot: 0, side: "top" },
          } as (typeof p.components)[number],
        ],
      })),
    );
    await page.keyboard.press("f");
    await page.keyboard.press("l");
    // The resistor's pin 1 is at (-0.3, 0).
    const pin = await page.evaluate(() => {
      const g = document.querySelector('svg > g[transform^="matrix"]')!;
      const m = g.getAttribute("transform")!.match(/matrix\(([^)]+)\)/)![1].split(",").map(Number);
      const host = g.closest("div")!.getBoundingClientRect();
      return { x: host.left - 0.3 * m[0] + m[4], y: host.top + m[5] };
    });
    // The name box opened on the press used to lose its focus to the canvas at once, and close.
    await page.mouse.click(pin.x, pin.y);
    const name = page.getByPlaceholder("Net name");
    await expect(name).toBeFocused();
    await name.fill("VCC");
    await name.press("Enter");

    await expect.poll(async () => (await project(page)).labels.map((l) => [l.name, l.x, l.y])).toEqual([["VCC", -0.3, 0]]);
    const net = await page.evaluate(() => {
      const h = (window as unknown as EditorHook).__cherryblossom;
      return h.getConnectivity(h.projectApi().project).pinNet.get("c_r1:1");
    });
    expect(net).toBe("net:VCC");
  });

  test("Tidy redraws the schematic, as one undo step", async ({ page }) => {
    await page.goto(HOME);
    await page.getByRole("button", { name: /555 LED blinker/ }).click();
    await expect(page.getByRole("textbox", { name: "Project name" })).toBeVisible();
    await page.waitForFunction(() => "__cherryblossom" in window);
    const status = page.getByRole("status").filter({ hasText: /tidy|Tidied/i });
    // The example ships tidied.
    await page.getByRole("button", { name: "Tidy the schematic" }).click();
    await expect(status).toHaveText("Already tidy.");

    const r1 = async () => (await project(page)).components.find((c) => c.ref === "R1")!.sch;
    const tidy = await r1();
    // Move the LED and its resistor, with their wires, labels and ground port, out of place:
    // everything drawn around them, so nothing comes apart.
    await page.evaluate(() => {
      const api = (window as unknown as EditorHook).__cherryblossom.projectApi();
      api.commit((p) => {
        const parts = p.components.filter((c) => c.ref === "R1" || c.ref === "D1");
        const near = (q: { x: number; y: number }) => parts.some((c) => Math.abs(q.x - c.sch.x) < 0.9 && Math.abs(q.y - c.sch.y) < 1.2);
        const by = <T extends { x: number; y: number }>(q: T): T => ({ ...q, x: Math.round((q.x + 2) * 10) / 10, y: Math.round((q.y - 1) * 10) / 10 });
        return {
          ...p,
          components: p.components.map((c) => (near(c.sch) ? { ...c, sch: by(c.sch) } : c)),
          wires: p.wires.map((w) => (w.points.every(near) ? { ...w, points: w.points.map(by) } : w)),
          labels: p.labels.map((l) => (near(l) ? by(l) : l)),
        };
      });
    });
    const moved = await r1();
    expect(moved.x).toBeCloseTo(tidy.x + 2);

    await page.keyboard.press("t");
    await expect(status).toHaveText("Tidied 9 parts into 3 blocks.");
    expect(await r1()).toEqual(tidy);
    await page.keyboard.press("Control+z");
    expect(await r1()).toEqual(moved);
  });

  test("Clean up groups the loose parts into blocks and tidies, as one undo step", async ({ page }) => {
    await page.goto(HOME);
    await page.getByRole("button", { name: /3\.3 V supply/ }).click();
    await expect(page.getByRole("textbox", { name: "Project name" })).toBeVisible();
    await page.waitForFunction(() => "__cherryblossom" in window);
    // The example ships in blocks: take them off, so every part is loose.
    await page.evaluate(() => {
      (window as unknown as EditorHook).__cherryblossom.projectApi().commit((p) => ({ ...p, blocks: undefined }));
    });
    const blocks = () =>
      page.evaluate(() => (window as unknown as EditorHook).__cherryblossom.projectApi().project.blocks?.map((b) => b.name) ?? []);

    // No AI here (signed out), so the button is the free one, and it asks before it does anything.
    await page.getByRole("button", { name: "Clean up", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Clean up" });
    await expect(dialog).toContainText("Group 7 parts into 2 blocks and tidy the sheet?");
    expect(await blocks()).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(await blocks()).toEqual([]);

    await page.getByRole("button", { name: "Clean up", exact: true }).click();
    await dialog.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByRole("status").filter({ hasText: /Grouped/ })).toHaveText("Grouped 7 parts into 2 blocks and tidied the sheet.");
    expect(await blocks()).toEqual(["REGULATOR U1 AMS1117-3.3", "LED D1"]);

    await page.keyboard.press("Control+z");
    expect(await blocks()).toEqual([]);
  });

  test("Clean up is off on a sheet with no parts, and says why", async ({ page }) => {
    await newProject(page);
    const button = page.getByRole("button", { name: "Clean up", exact: true });
    await expect(button).toBeDisabled();
    await expect(button.locator("xpath=..")).toHaveAttribute("title", /add parts to the sheet first/);
  });

  test("themes through data-theme before the editor loads", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(HOME);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });
});

test.describe("exports to other tools", () => {
  async function openBlinker(page: Page) {
    await page.goto(HOME);
    await page.getByRole("button", { name: /555 LED blinker/ }).click();
    await expect(page.getByRole("textbox", { name: "Project name" })).toBeVisible();
  }

  test("the export menu downloads Circuit JSON that names the parts and says what stays behind", async ({ page }) => {
    await openBlinker(page);
    await page.getByRole("button", { name: "Export" }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("menuitem", { name: /Circuit JSON \(tscircuit\)/ }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.circuit\.json$/);
    const path = await download.path();
    const elements = JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8")) as { type: string; name?: string }[];
    expect(elements.some((e) => e.type === "source_component" && e.name === "U1")).toBe(true);
    expect(elements.some((e) => e.type === "pcb_board")).toBe(true);
    await expect(page.getByRole("status")).toContainText("Exported Circuit JSON");
  });

  test("the export menu downloads a KiCad project as a zip", async ({ page }) => {
    test.slow();
    await openBlinker(page);
    await page.getByRole("button", { name: "Export" }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60_000 }),
      page.getByRole("menuitem", { name: /KiCad project/ }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.kicad\.zip$/);
  });
});

test.describe("electrical checks", () => {
  test("a bare LED is warned about, selected from the list, ignored and restored", async ({ page }) => {
    await newProject(page);
    // An LED straight across 3V3: the ports sit with their pins on the LED's, which connects them.
    await page.evaluate(() => {
      type Commit = { commit: (fn: (p: { components: unknown[] }) => unknown) => void };
      const api = (window as unknown as EditorHook).__cherryblossom.projectApi() as unknown as Commit;
      const part = (id: string, partId: string, ref: string, x: number, y: number, props: Record<string, string>) => ({
        id,
        partId,
        ref,
        props,
        footprint: partId === "led" ? "0603" : "",
        sch: { x, y, rot: 0 },
        pcb: { x: 0, y: 0, rot: 0, side: "top", placed: false },
      });
      api.commit((p) => ({
        ...p,
        components: [
          part("c_led", "led", "D1", 0, 0, { color: "red" }),
          part("c_pwr", "power", "#PWR1", -0.3, 0.2, { net: "3V3" }),
          part("c_gnd", "ground", "#GND1", 0.3, -0.3, { net: "GND" }),
        ],
      }));
    });

    await page.getByRole("button", { name: "1 warning" }).click();
    const row = page.getByRole("button", { name: /D1 has no resistor between it and 3V3/ });
    await expect(row).toBeVisible();
    await row.click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __cherryblossom: { uiApi: () => { selection: string[] } } }).__cherryblossom.uiApi().selection))
      .toEqual(["c:c_led"]);

    await page.getByRole("button", { name: "Ignore", exact: true }).click();
    await expect(page.getByRole("button", { name: "Checks pass" })).toBeVisible();
    await expect.poll(async () => (await project(page)) as unknown as { ignoredChecks?: string[] }).toMatchObject({ ignoredChecks: ["bare-led:c_led"] });

    await page.getByRole("button", { name: /Ignored/ }).click();
    await page.getByRole("button", { name: "Restore" }).click();
    await expect(page.getByRole("button", { name: "1 warning" })).toBeVisible();
  });
});

test.describe("parts and Sakura", () => {
  test("search reads values and packages, and placing applies them", async ({ page }) => {
    await newProject(page);
    await openLibrary(page);
    const search = page.getByRole("combobox", { name: "Search parts" });
    await search.fill("10k 0603");
    const first = page.getByRole("option").first();
    await expect(first).toContainText("Resistor");
    await expect(first).toContainText("10k");
    await expect(first).toContainText("0603");
    await search.press("Enter");

    const canvas = await page.evaluate(() => {
      const r = document.querySelector('svg > g[transform^="matrix"]')!.closest("div")!.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.click(canvas.x, canvas.y);
    await expect.poll(async () => (await project(page)).components.map((c) => [c.ref, c.props.resistance, c.footprint])).toEqual([
      ["R1", "10k", "0603"],
    ]);

    await search.fill("bme280");
    await expect(page.getByText('Can\'t find "bme280"?')).toBeVisible();
    await expect(page.getByRole("button", { name: "Create it with Sakura" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Import KiCad files" })).toBeVisible();
  });

  test("signed out, Sakura asks to sign in instead of calling a model", async ({ page }) => {
    let modelCalls = 0;
    await page.route("**/api/v1/chat/completions", (route) => {
      modelCalls++;
      return route.abort();
    });
    await newProject(page);
    // Sakura is open when a project opens, and the parts library closed.
    await expect(page.getByRole("complementary", { name: "Sakura" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Parts library" })).toHaveCount(0);
    await expect(page.getByText("Sign in to use Sakura").first()).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message Sakura" })).toBeDisabled();
    expect(modelCalls).toBe(0);

    // ⌘L closes and reopens the panel.
    await page.keyboard.press("ControlOrMeta+KeyL");
    await expect(page.getByRole("complementary", { name: "Sakura" })).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+KeyL");
    await expect(page.getByRole("complementary", { name: "Sakura" })).toBeVisible();
  });

  test("Sakura runs on managed AI and creates a part the library doesn't have", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    const sse = (...chunks: object[]) =>
      [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"].join("");
    const call = (id: string, name: string, args: object) =>
      sse(
        { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      );
    const requests: { authorization?: string; body: { model: string; messages: { role: string; content: unknown }[] } }[] = [];

    await page.route("**/api/v1/me", (route) =>
      route.fulfill({
        json: {
          user: { id: "user_e2e", email: null, name: null },
          plan: { tier: "pro", name: "Pro", managedAi: true, allowedModels: ["anthropic/claude-sonnet-5.5"] },
          limits: { maxTokensPerRequest: 64000, requestsPerMinute: 60, requestsPerDay: 600, monthlyTokens: 4000000 },
          usage: { requestsThisMinute: 0, minuteResetsAt: null, requestsThisDay: 0, dayResetsAt: null, monthlyTokens: 0, monthResetsAt: null },
          onDemand: { available: true, enabled: false, capCents: 0, creditsThisPeriod: 0, spentCents: 0 },
        },
      }),
    );
    await page.route("**/api/v1/chat/completions", (route) => {
      const body = route.request().postDataJSON();
      requests.push({ authorization: route.request().headers().authorization, body });
      const last = body.messages[body.messages.length - 1];
      const created = typeof last.content === "string" && last.content.match(/part_id "([^"]+)"/);
      let reply: string;
      if (last.role === "user") {
        reply = call("call_1", "create_part", {
          name: "TPS7A0233",
          description: "200 mA 3.3 V LDO, SOT-23-5",
          category: "Power",
          footprint: "sot23_5",
          pins: [
            { number: "1", name: "IN", kind: "power" },
            { number: "2", name: "GND", kind: "ground" },
            { number: "3", name: "EN", kind: "input" },
            { number: "4", name: "NC", kind: "nc" },
            { number: "5", name: "OUT", kind: "output" },
          ],
        });
      } else if (created) {
        reply = call("call_2", "add_component", { part_id: created[1], x: 0, y: 0 });
      } else {
        reply = sse({ choices: [{ delta: { content: "Added U1, a TPS7A0233 LDO." } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] });
      }
      return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: reply });
    });

    await newProject(page);
    // Stand in for the host's session: this build has none.
    await page.evaluate(() =>
      (window as unknown as EditorHook).__cherryblossom.connectManagedAi({ getAccessToken: async () => "e2e-token" }),
    );
    const composer = page.getByRole("textbox", { name: "Message Sakura" });
    await expect(composer).toBeEnabled();
    // Open from the start, Sakura leaves the focus to the canvas's shortcuts; opened by asking (⌘L), it takes it.
    await expect(composer).not.toBeFocused();
    await page.keyboard.press("ControlOrMeta+KeyL");
    await page.keyboard.press("ControlOrMeta+KeyL");
    await expect(composer).toBeFocused();
    await composer.fill("Add a TPS7A02 3.3 V LDO");
    await composer.press("Enter");

    await expect(page.getByText("Added U1, a TPS7A0233 LDO.")).toBeVisible({ timeout: 15_000 });
    // This build has no supplier source, so the part is made from memory, and says so.
    await expect(page.getByText("Created part TPS7A0233 from memory (unverified)")).toBeVisible();
    const p = await project(page);
    expect(p.parts?.map((x) => x.name)).toEqual(["TPS7A0233"]);
    expect(p.components.map((c) => [c.ref, c.partId])).toEqual([["U1", p.parts![0].id]]);

    expect(requests).toHaveLength(3);
    expect(requests.every((r) => r.authorization === "Bearer e2e-token")).toBe(true);
    expect(requests[0].body.model).toBe("anthropic/claude-sonnet-5.5");
    expect(requests[2].body.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant", "tool"]);

    // The made part is the project's own, in the library beside the built-in ones.
    await openLibrary(page);
    await expect(page.getByRole("heading", { name: "This project" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Parts library" }).getByText("TPS7A0233").first()).toBeVisible();

    // And the Checks panel says it was never checked against a supplier.
    await page.getByRole("tab", { name: "Checks" }).click();
    await expect(
      page.getByText("U1 (TPS7A0233): pinout and footprint not verified against a supplier; made from memory (supplier lookup isn't available in this editor)"),
    ).toBeVisible();
    expect(pageErrors, `unexpected page errors: ${pageErrors.join("\n")}`).toEqual([]);
  });

  test("Sakura builds a part from supplier data", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    // What the parts API answered for the TPS61023, as the editor's tests replay it.
    const recorded = JSON.parse(readFileSync(new URL("../tests/fixtures/supplier/recorded.json", import.meta.url), "utf8"));
    const lookups: string[] = [];
    await page.route("**/api/v1/parts/**", (route) => {
      const url = new URL(route.request().url());
      lookups.push(`${url.pathname}${url.search}`);
      if (route.request().headers().authorization !== "Bearer e2e-token") return route.fulfill({ status: 401, json: { error: { type: "not_authenticated", message: "x" } } });
      if (url.pathname.endsWith("/search")) return route.fulfill({ json: recorded.searches[url.searchParams.get("q")!.toUpperCase()] });
      const part = recorded.parts[url.pathname.split("/").pop()!];
      return part ? route.fulfill({ json: part }) : route.fulfill({ status: 404, json: { error: { type: "not_found", message: "none" } } });
    });
    await page.route("**/api/v1/me", (route) =>
      route.fulfill({
        json: {
          user: { id: "user_e2e", email: null, name: null },
          plan: { tier: "pro", name: "Pro", managedAi: true, allowedModels: ["anthropic/claude-sonnet-5.5"] },
          limits: { maxTokensPerRequest: 64000, requestsPerMinute: 60, requestsPerDay: 600, monthlyTokens: 4000000 },
          usage: { requestsThisMinute: 0, minuteResetsAt: null, requestsThisDay: 0, dayResetsAt: null, monthlyTokens: 0, monthResetsAt: null },
          onDemand: { available: true, enabled: false, capCents: 0, creditsThisPeriod: 0, spentCents: 0 },
        },
      }),
    );
    const sse = (...chunks: object[]) => [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"].join("");
    const call = (id: string, name: string, args: object) =>
      sse(
        { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      );
    await page.route("**/api/v1/chat/completions", (route) => {
      const body = route.request().postDataJSON();
      const last = body.messages[body.messages.length - 1];
      const text = typeof last.content === "string" ? last.content : "";
      const created = text.match(/part_id "([^"]+)"/);
      let reply: string;
      if (last.role === "user") reply = call("c1", "find_part", { query: "TPS61023" });
      else if (/^C\d+ TPS61023/.test(text)) reply = call("c2", "create_part", { lcsc: text.match(/^(C\d+)/)![1], category: "Power" });
      else if (created) reply = call("c3", "add_component", { part_id: created[1], x: 0, y: 0 });
      else reply = sse({ choices: [{ delta: { content: "Added U1 from LCSC data." } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] });
      return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: reply });
    });

    await newProject(page);
    // Stand in for a host with a backend: the session, and a parts source over /api/v1/parts.
    await page.evaluate(() => {
      const hook = (window as unknown as EditorHook).__cherryblossom;
      hook.connectManagedAi({ getAccessToken: async () => "e2e-token" });
      const get = (path: string) => fetch(path, { headers: { authorization: "Bearer e2e-token" } });
      hook.connectSupplierParts({
        search: async (q) => (await get(`/api/v1/parts/search?q=${encodeURIComponent(q)}`)).json(),
        part: async (id) => {
          const res = await get(`/api/v1/parts/${id}`);
          return res.status === 404 ? null : res.json();
        },
      });
    });
    const composer = page.getByRole("textbox", { name: "Message Sakura" });
    await composer.fill("Add a TPS61023 boost converter");
    await composer.press("Enter");

    await expect(page.getByText("Added U1 from LCSC data.")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Created part TPS61023DRL[RT] from LCSC C\d+/)).toBeVisible();
    expect(lookups[0]).toBe("/api/v1/parts/search?q=TPS61023");
    const p = await project(page);
    const spec = p.parts![0];
    expect(spec.source).toMatchObject({ pins: "supplier", land: "supplier" });
    expect(spec.footprint).toMatch(/^sot563_c\d+-/);
    expect(p.components.map((c) => [c.ref, c.partId, c.footprint])).toEqual([["U1", spec.id, spec.footprint]]);

    // Built from data: the Checks panel has nothing to say about the part itself.
    await page.getByRole("tab", { name: "Checks" }).click();
    await expect(page.getByText("isn't connected").first()).toBeVisible();
    await expect(page.getByText("not verified against a supplier")).toHaveCount(0);
    expect(pageErrors, `unexpected page errors: ${pageErrors.join("\n")}`).toEqual([]);
  });

  test("on Free, Sakura offers Pro and the user's own AI, each assistant linked to its steps", async ({ page }) => {
    await page.route("**/api/v1/me", (route) =>
      route.fulfill({
        json: {
          user: { id: "user_e2e", email: null, name: null },
          plan: { tier: "free", name: "Free", managedAi: false, allowedModels: [] },
          limits: { maxTokensPerRequest: 0, requestsPerMinute: 0, requestsPerDay: 0, monthlyTokens: 0 },
          usage: { requestsThisMinute: 0, minuteResetsAt: null, requestsThisDay: 0, dayResetsAt: null, monthlyTokens: 0, monthResetsAt: null },
          onDemand: { available: false, enabled: false, capCents: 0, creditsThisPeriod: 0, spentCents: 0 },
        },
      }),
    );
    await newProject(page);
    // The host's links are what the website's mount passes; the panel's first fetch already found no session.
    await page.evaluate(() =>
      (window as unknown as EditorHook).__cherryblossom.connectManagedAi({
        getAccessToken: async () => "e2e-token",
        upgradeUrl: "/pricing",
        assistantsUrl: "/docs/mcp",
        assistantGuides: { claude: "/docs/mcp#claude", chatgpt: "/docs/mcp#chatgpt", claudeCode: "/docs/mcp#claude-code", codex: "/docs/mcp#codex", cursor: "/docs/mcp#cursor" },
      }),
    );
    // The window's focus is what reloads the plan after a purchase in another tab.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const sakura = page.getByRole("complementary", { name: "Sakura" });
    await expect(sakura.getByRole("link", { name: "Upgrade to Pro" })).toHaveAttribute("href", "/pricing");
    const own = sakura.getByRole("region", { name: "Bring your own AI" });
    await expect(own).toContainText("Use the Claude or ChatGPT you already pay for");
    for (const [name, href] of [
      ["Claude", "/docs/mcp#claude"],
      ["ChatGPT", "/docs/mcp#chatgpt"],
      ["Claude Code", "/docs/mcp#claude-code"],
      ["Codex", "/docs/mcp#codex"],
      ["Cursor", "/docs/mcp#cursor"],
    ]) {
      await expect(own.getByRole("link", { name: `Connect ${name}`, exact: true })).toHaveAttribute("href", href);
    }
    await expect(own.getByRole("link", { name: "How it works" })).toHaveAttribute("href", "/docs/mcp");
    await expect(sakura.getByRole("textbox", { name: "Message Sakura" })).toBeDisabled();
  });

  test("a Pro user out of credits is offered Ultra and pay-as-you-go", async ({ page }) => {
    await page.route("**/api/v1/me", (route) =>
      route.fulfill({
        json: {
          user: { id: "user_e2e", email: null, name: null },
          plan: { tier: "pro", name: "Pro", managedAi: true, allowedModels: ["anthropic/claude-sonnet-5.5"] },
          limits: { maxTokensPerRequest: 64000, requestsPerMinute: 60, requestsPerDay: 600, monthlyTokens: 4000000 },
          usage: { requestsThisMinute: 1, minuteResetsAt: null, requestsThisDay: 40, dayResetsAt: null, monthlyTokens: 4000000, monthResetsAt: null },
          onDemand: { available: true, enabled: false, capCents: 5000, creditsThisPeriod: 0, spentCents: 0 },
        },
      }),
    );
    await page.route("**/api/v1/chat/completions", (route) =>
      route.fulfill({
        status: 429,
        headers: { "retry-after": "86400" },
        json: {
          error: {
            type: "rate_limited",
            message: "Monthly AI credit limit reached (4,000,000 credits/30 days on the Pro plan).",
            limit: "month",
          },
        },
      }),
    );

    await newProject(page);
    // The host's session, with the links the website's mount gives it.
    await page.evaluate(() =>
      (window as unknown as EditorHook).__cherryblossom.connectManagedAi({
        getAccessToken: async () => "e2e-token",
        upgradeUrl: "/pricing",
        accountUrl: "/account/usage",
      }),
    );
    const composer = page.getByRole("textbox", { name: "Message Sakura" });
    await expect(composer).toBeEnabled();
    await composer.fill("Route the board");
    await composer.press("Enter");

    const sakura = page.getByRole("complementary", { name: "Sakura" });
    await expect(sakura.getByText("You've reached your plan's AI limit")).toBeVisible();
    await expect(sakura.getByText("Monthly AI credit limit reached", { exact: false })).toBeVisible();
    // Plans for Ultra, the usage page for pay-as-you-go, where turning it on is agreed to.
    await expect(sakura.getByRole("link", { name: "Upgrade to Ultra" })).toHaveAttribute("href", "/pricing");
    await expect(sakura.getByRole("link", { name: "Turn on pay-as-you-go" })).toHaveAttribute("href", "/account/usage");
  });
});

test.describe("the project's own parts", () => {
  test("a part is edited in the part editor for every component placed from it, and an unused one removed", async ({ page }) => {
    await newProject(page);
    await page.evaluate(() => {
      const pins = (names: string[]) => names.map((name, i) => ({ number: String(i + 1), name }));
      (window as unknown as EditorHook).__cherryblossom.projectApi().commit((p) => ({
        ...p,
        parts: [
          { id: "ldo-aaaaaa", name: "TPS7A0233", description: "3.3 V LDO", category: "Power", refPrefix: "U", footprint: "sot23_5", pins: pins(["IN", "GND", "EN", "NC", "OUT"]), props: { mpn: "TPS7A0233" }, valueProp: "mpn" },
          { id: "sht31-bbbbbb", name: "SHT31", description: "Humidity sensor", category: "ICs", refPrefix: "U", footprint: "soic8", pins: pins(["SDA", "ADDR", "ALERT", "SCL", "VDD", "NRESET", "R", "VSS"]), props: {} },
        ],
      }));
    });
    await openLibrary(page);
    await page.getByRole("button", { name: /^TPS7A0233/ }).click();
    const canvas = await page.evaluate(() => {
      const r = document.querySelector('svg > g[transform^="matrix"]')!.closest("div")!.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.click(canvas.x, canvas.y);
    await expect.poll(async () => (await project(page)).components.map((c) => c.partId)).toEqual(["ldo-aaaaaa"]);
    await page.keyboard.press("Escape");

    // Nothing is placed from the sensor: it says so, and goes at once.
    const sensor = page.locator("li", { hasText: "SHT31" });
    await expect(sensor).toContainText("Unused");
    await sensor.hover();
    await page.getByRole("button", { name: "Remove SHT31 from the project" }).click();
    await expect.poll(async () => (await project(page)).parts!.map((s) => s.name)).toEqual(["TPS7A0233"]);

    await page.locator("li", { hasText: "TPS7A0233" }).hover();
    await page.getByRole("button", { name: "Edit TPS7A0233" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Placed as U1");
    await expect(dialog.getByRole("img", { name: "Footprint sot23_5" })).toBeVisible();
    await dialog.getByLabel("Part name").fill("TPS7A02");
    await dialog.getByRole("tab", { name: "Pins (5)" }).click();
    await dialog.getByLabel("Pin 3 name").fill("ENABLE");
    // Its 3D model, chosen in the same draft: drawn on the footprint in the dialog's own 3D view.
    await dialog.getByRole("tab", { name: "3D model" }).click();
    await expect(dialog.locator("canvas")).toBeVisible({ timeout: 30_000 });
    const body = "v -1.45 -0.8 0.1\nv 1.45 -0.8 0.1\nv 1.45 0.8 0.1\nv -1.45 0.8 0.1\nv -1.45 -0.8 1.2\nv 1.45 -0.8 1.2\nv 1.45 0.8 1.2\nv -1.45 0.8 1.2\nf 1 4 3 2\nf 5 6 7 8\nf 1 2 6 5\nf 2 3 7 6\nf 3 4 8 7\nf 4 1 5 8\n";
    await dialog.locator('input[type="file"]').setInputFiles({ name: "sot23-5.obj", mimeType: "text/plain", buffer: Buffer.from(body) });
    await expect(dialog).toContainText("OBJ file", { timeout: 20_000 });
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toHaveCount(0);

    const p = await project(page);
    expect(p.parts!.map((s) => s.name)).toEqual(["TPS7A02"]);
    expect(p.components.map((c) => c.partId)).toEqual([p.parts![0].id]);
    expect(p.models!.map((m) => [m.part, m.footprint, m.model.name])).toEqual([[p.parts![0].id, "sot23_5", "sot23-5.obj"]]);
    // Made from memory, it stays unverified however it is edited, and Checks says so under its new name.
    await page.getByRole("tab", { name: "Checks" }).click();
    await expect(page.getByText(/U1 \(TPS7A02\): pinout and footprint not verified against a supplier/).first()).toBeVisible();
  });
});

test.describe("drawing on the schematic", () => {
  type Drawn = { blocks?: { name: string; components: string[] }[]; drawings?: Record<string, unknown>[] };
  const drawn = (page: Page) => project(page) as unknown as Promise<Drawn>;

  /** Where a schematic point is on the page, through the canvas's own transform. */
  const at = (page: Page, x: number, y: number) =>
    page.evaluate(([x, y]) => {
      const g = document.querySelector("main svg g") as SVGGraphicsElement;
      const m = g.getCTM()!;
      const r = g.ownerSVGElement!.getBoundingClientRect();
      return { x: r.left + m.a * x + m.c * y + m.e, y: r.top + m.b * x + m.d * y + m.f };
    }, [x, y] as const);

  async function drag(page: Page, from: [number, number], to: [number, number]) {
    const a = await at(page, ...from);
    const b = await at(page, ...to);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 4 });
    await page.mouse.up();
  }

  /** A new project with two resistors side by side, R1 at (0, 0) and R2 at (1.5, 0). */
  async function twoResistors(page: Page) {
    await newProject(page);
    await page.evaluate(() => {
      type Commit = { commit: (fn: (p: { components: unknown[] }) => unknown) => void };
      const api = (window as unknown as EditorHook).__cherryblossom.projectApi() as unknown as Commit;
      const part = (id: string, partId: string, ref: string, x: number) => ({
        id,
        partId,
        ref,
        props: {},
        footprint: "0805",
        sch: { x, y: 0, rot: 0 },
        pcb: { x: 0, y: 0, rot: 0, side: "top", placed: false },
      });
      api.commit((p) => ({ ...p, components: [part("c_r1", "resistor", "R1", 0), part("c_r2", "resistor", "R2", 1.5)] }));
    });
  }

  test("the toolbar frames parts as a block, writes a text and draws a shape the Inspector styles", async ({ page }) => {
    await twoResistors(page);

    // A block: drag around the parts, and name it where its title is.
    await page.getByRole("button", { name: "Block", exact: true }).click();
    await drag(page, [-0.8, 0.8], [2.3, -0.8]);
    const name = page.getByRole("textbox", { name: "Block name" });
    await expect(name).toBeFocused();
    await name.fill("LED DRIVER");
    await name.press("Enter");
    await expect.poll(async () => (await drawn(page)).blocks).toEqual([expect.objectContaining({ name: "LED DRIVER", components: ["c_r1", "c_r2"] })]);

    // A text, typed where it goes.
    await page.getByRole("button", { name: "Text", exact: true }).click();
    const spot = await at(page, -0.5, 1.8);
    await page.mouse.click(spot.x, spot.y);
    await expect(page.getByRole("textbox", { name: "Text" })).toBeFocused();
    await page.keyboard.type("Blinker");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await drawn(page)).drawings).toEqual([expect.objectContaining({ type: "text", text: "Blinker", x: -0.5, y: 1.8 })]);

    // A rectangle, from the drawing tools' menu, styled from the Inspector, and each change one undo step.
    await page.getByRole("button", { name: "Drawing tools", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Rectangle", exact: true }).click();
    await drag(page, [3, 1], [4.5, -0.5]);
    await page.getByRole("button", { name: "Colour: blue" }).click();
    await page.getByRole("tab", { name: "Dashed" }).click();
    await expect
      .poll(async () => (await drawn(page)).drawings?.[1])
      .toMatchObject({ type: "rect", x: 3, y: -0.5, width: 1.5, height: 1.5, color: "blue", dash: "dashed" });
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => (await drawn(page)).drawings?.[1]).not.toHaveProperty("dash");

    // Dragging it moves it, and Delete removes it.
    await drag(page, [3, 0], [3.5, 0]);
    await expect.poll(async () => (await drawn(page)).drawings?.[1]).toMatchObject({ x: 3.5 });
    await page.keyboard.press("Delete");
    await expect.poll(async () => (await drawn(page)).drawings?.length).toBe(1);
  });

  test("the block tool takes two clicks as well as a drag, and keeps its name field focused", async ({ page }) => {
    await twoResistors(page);
    await page.getByRole("button", { name: "Block", exact: true }).click();
    for (const [x, y] of [[-0.8, 0.8], [2.3, -0.8]] as const) {
      const p = await at(page, x, y);
      await page.mouse.click(p.x, p.y);
    }
    const name = page.getByRole("textbox", { name: "Block name" });
    await expect(name).toBeFocused();
    await name.fill("PULL-UPS");
    await name.press("Enter");
    await expect.poll(async () => (await drawn(page)).blocks).toEqual([expect.objectContaining({ name: "PULL-UPS", components: ["c_r1", "c_r2"] })]);
  });
});

test.describe("projects", () => {
  test("an edit is saved as it is made, and is there after a reload", async ({ page }) => {
    await newProject(page);
    const name = page.getByRole("textbox", { name: "Project name" });
    await name.fill("Saved board");
    await name.press("Enter");
    // Autosave waits for a pause in editing; the leave-page guard would
    // otherwise hold the reload while the save is pending.
    await page.waitForFunction(() => {
      const index = JSON.parse(localStorage.getItem("cherryblossom:editor:index") ?? "[]");
      return index.some((p: { name: string }) => p.name === "Saved board");
    });
    await page.reload();
    await expect(name).toHaveValue("Saved board");

    // Stored as a project file: the envelope, with the design inside it.
    const stored = await page.evaluate(() => {
      const [entry] = JSON.parse(localStorage.getItem("cherryblossom:editor:index") ?? "[]");
      return JSON.parse(localStorage.getItem(`cherryblossom:editor:project:${entry.id}`) ?? "null");
    });
    expect(stored).toMatchObject({ format: "cherryblossom.project", version: 5, project: { name: "Saved board" } });
    expect(stored.project).not.toHaveProperty("id");
  });

  test("the paused strip's Reload keeps the edits saves couldn't take, and sends them", async ({ page }) => {
    await newProject(page);
    const name = page.getByRole("textbox", { name: "Project name" });
    // Saves fail: this harness keeps projects in localStorage, and a write there that throws is a failed save.
    await page.evaluate(() => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (this === localStorage && key.startsWith("cherryblossom:editor:")) throw new Error("Saves are off for this test");
        return set.call(this, key, value);
      };
    });
    await name.fill("Kept board");
    await name.press("Enter");
    // Editing pauses once saves have failed for 8 s, and the strip says what to do.
    await expect(page.getByText("Your latest changes aren't saved yet")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Download a copy" })).toBeVisible();

    // The strip's own Reload asks nothing: the edits go along in the tab.
    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.type());
      void dialog.dismiss();
    });
    await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Reload" }).click()]);
    expect(dialogs).toEqual([]);
    // The new page has no failing saves: the edit is on screen and lands.
    await expect(name).toHaveValue("Kept board");
    await page.waitForFunction(() => {
      const index = JSON.parse(localStorage.getItem("cherryblossom:editor:index") ?? "[]");
      return index.some((p: { name: string }) => p.name === "Kept board");
    });
    await expect(page.getByText("Your latest changes aren't saved yet")).toHaveCount(0);
  });

  test("a project saved before the file format had a version still opens", async ({ page }) => {
    await page.goto(HOME);
    await page.evaluate(() => {
      const bare = {
        id: "p_legacy",
        name: "Legacy board",
        description: "",
        createdAt: 1,
        updatedAt: 2,
        components: [],
        wires: [],
        labels: [],
        traces: [],
        vias: [],
        zones: [],
        texts: [],
        board: { width: 40, height: 30, x: 0, y: 0, thickness: 1.6, cornerRadius: 1 },
        rules: {},
      };
      localStorage.setItem("cherryblossom:editor:project:p_legacy", JSON.stringify(bare));
      localStorage.setItem(
        "cherryblossom:editor:index",
        JSON.stringify([{ id: "p_legacy", name: "Legacy board", description: "", updatedAt: 2, componentCount: 0 }]),
      );
    });
    await page.reload();
    await page.getByRole("button", { name: "Open Legacy board" }).first().click();
    await expect(page.getByRole("textbox", { name: "Project name" })).toHaveValue("Legacy board");
  });
});

test.describe("tooltips", () => {
  test("a toolbar button explains itself on hover, and Escape puts it away", async ({ page }) => {
    await newProject(page);
    const wire = page.getByRole("button", { name: "Wire", exact: true });
    // The styled tooltip replaces the browser's, so there is never a second one.
    await expect(wire).not.toHaveAttribute("title", /.*/);

    await wire.hover();
    const tip = page.getByRole("tooltip");
    await expect(tip).toBeVisible({ timeout: 1_000 });
    await expect(tip).toContainText("Wire");
    await expect(tip).toContainText("W");
    await expect(wire).toHaveAttribute("aria-describedby", (await tip.getAttribute("id"))!);

    // It sits inside the window and takes no clicks.
    const box = (await tip.boundingBox())!;
    const view = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(view.width);
    expect(box.y + box.height).toBeLessThanOrEqual(view.height);
    expect(await tip.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");

    await page.keyboard.press("Escape");
    await expect(tip).toBeHidden();
    await expect(wire).not.toHaveAttribute("aria-describedby", /.+/);
  });

  test("the PCB toolbar's re-pack button says what it does, and the next tooltip follows at once", async ({ page }) => {
    await newProject(page);
    await page.getByRole("tab", { name: "PCB" }).click();
    await page.getByRole("button", { name: "Re-pack parts" }).hover();
    const tip = page.getByRole("tooltip");
    await expect(tip).toContainText("Re-pack parts", { timeout: 1_000 });
    await expect(tip).toContainText("Lines up every part that isn't locked");

    // Along a toolbar the next tooltip replaces the last without another wait.
    await page.getByRole("button", { name: "Autoroute" }).hover();
    await expect(tip).toContainText("Autoroute", { timeout: 150 });
    await expect(page.getByRole("tooltip")).toHaveCount(1);

    await page.mouse.move(600, 500);
    await expect(tip).toBeHidden();
  });

  test("a click hides the tooltip without changing what the button does", async ({ page }) => {
    await newProject(page);
    const wire = page.getByRole("button", { name: "Wire", exact: true });
    await wire.hover();
    await expect(page.getByRole("tooltip")).toBeVisible();
    await wire.click();
    await expect(page.getByRole("tooltip")).toBeHidden();
    await expect(wire).toHaveAttribute("aria-pressed", "true");
  });

  test("a button's tooltip stays off the menu it opened", async ({ page }) => {
    await newProject(page);
    const exportButton = page.getByRole("button", { name: "Export", exact: true });
    await exportButton.hover();
    await expect(page.getByRole("tooltip")).toBeVisible({ timeout: 1_000 });

    // Opening the menu puts the tooltip away, and resting on the button again does not bring it back.
    await exportButton.click();
    await expect(page.getByRole("menuitem", { name: /Fabrication files/ })).toBeVisible();
    await expect(page.getByRole("tooltip")).toBeHidden();
    await page.mouse.move(600, 500);
    await exportButton.hover();
    await page.waitForTimeout(500);
    await expect(page.getByRole("tooltip")).toHaveCount(0);

    // Closed again, it explains itself as before.
    await exportButton.click();
    await expect(exportButton).toHaveAttribute("aria-expanded", "false");
    await page.mouse.move(600, 500);
    await exportButton.hover();
    await expect(page.getByRole("tooltip")).toBeVisible({ timeout: 1_000 });
  });

  test("only one tooltip is open at a time, even when keyboard focus and the mouse disagree", async ({ page }) => {
    await newProject(page);
    await page.getByRole("tab", { name: "PCB" }).click();
    // Keyboard focus puts a tooltip up on one control...
    const repack = page.getByRole("button", { name: "Re-pack parts" });
    await repack.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(repack).toBeFocused();
    await expect(page.getByRole("tooltip")).toContainText("Re-pack parts", { timeout: 1_000 });

    // ...and the pointer resting on another replaces it rather than joining it.
    await page.getByRole("button", { name: "Autoroute" }).hover();
    await expect(page.getByRole("tooltip")).toContainText("Autoroute", { timeout: 1_000 });
    for (let i = 0; i < 6; i++) {
      await expect(page.getByRole("tooltip")).toHaveCount(1);
      await page.waitForTimeout(100);
    }
  });
});

// The STEP reader is OpenCascade in WebAssembly, in a Web Worker the bundler has to emit along
// with its WASM file: what can break is the bundling, which the editor's own tests can't see.
test.describe("3D models", () => {
  // A 10 mm cube from the CAx-IF files occt-import-js ships, read where npm put it.
  const CUBE_STEP = fileURLToPath(
    new URL("../node_modules/occt-import-js/test/testfiles/cube-10x10mm/Cube 10x10.stp", import.meta.url),
  );

  test("a STEP file added to a part is read in the browser and kept for it", async ({ page }) => {
    // The first STEP file of a page fetches and compiles a 7.6 MB WebAssembly file.
    test.slow();
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    await page.goto(HOME);
    await page.getByRole("button", { name: /555 LED blinker/ }).click();
    await page.waitForFunction(() => "__cherryblossom" in window);
    await open3d(page);
    await page.evaluate(() => {
      const hook = (window as unknown as EditorHook & { __cherryblossom: { uiApi: () => { select: (ids: string[]) => void } } }).__cherryblossom;
      const u1 = hook.projectApi().project.components.find((c) => c.ref === "U1")!;
      hook.uiApi().select([`c:${u1.id}`]);
    });

    await page.locator('input[type="file"][accept*=".step"]:not([accept*=".kicad_mod"])').setInputFiles(CUBE_STEP);
    // Read (or refused) before it is assigned: the name in the Inspector means the worker read it.
    await expect(page.getByText("Cube 10x10.stp")).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText("STEP file", { exact: true })).toBeVisible();
    const models = await page.evaluate(
      () => (window as unknown as { __cherryblossom: { projectApi: () => { project: { models?: { part: string; model: { source: string; format: string; id: string } }[] } } } }).__cherryblossom.projectApi().project.models,
    );
    expect(models).toHaveLength(1);
    // The blinker's 555 is a part of its own, as every chip is: the library holds basic parts only.
    expect(models![0]).toMatchObject({ part: expect.stringMatching(/^ne555_timer-/), model: { source: "file", format: "step" } });
    expect(models![0].model.id).toMatch(/^[0-9a-f]{64}$/);

    // Back to the model a SOIC-8 has built in, KiCad's, which can't be removed; the 3D view keeps drawing.
    await page.getByRole("button", { name: "Remove 3D model" }).click();
    await expect(page.getByText("SOIC-8_3.9x4.9mm_P1.27mm", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove 3D model" })).toHaveCount(0);
    expect(pageErrors, `unexpected page errors: ${pageErrors.join("\n")}`).toEqual([]);
  });

  test("a KiCad part imported from its files comes in with its model, and places", async ({ page }) => {
    test.slow();
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    const kicad = (path: string) => fileURLToPath(new URL(`../tests/fixtures/kicad/${path}`, import.meta.url));
    await newProject(page);
    await openLibrary(page);

    await page.getByLabel("KiCad files to import").setInputFiles([
      kicad("symbols/Regulator_Linear.kicad_symdir/AP2204K-1.5.kicad_sym"),
      kicad("footprints/Package_TO_SOT_SMD.pretty/SOT-23-5.kicad_mod"),
      CUBE_STEP,
    ]);
    // The STEP file is read before the part comes in, so the notice waits on the worker.
    await expect(page.getByText("Imported AP2204K-1.5. Click the schematic to place it.")).toBeVisible({ timeout: 45_000 });
    await expect(page.getByRole("button", { name: /^AP2204K-1\.5/ })).toBeVisible();

    const canvas = await page.evaluate(() => {
      const r = document.querySelector('svg > g[transform^="matrix"]')!.closest("div")!.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.click(canvas.x, canvas.y);
    await expect.poll(async () => (await project(page)).components.map((c) => c.ref)).toEqual(["U1"]);
    const doc = await page.evaluate(
      () =>
        (
          window as unknown as {
            __cherryblossom: { projectApi: () => { project: { parts?: { id: string; source?: unknown }[]; models?: { part: string; model: { source: string; name: string } }[] } } };
          }
        ).__cherryblossom.projectApi().project,
    );
    expect(doc.parts).toHaveLength(1);
    expect(doc.parts![0].source).toEqual({ pins: "file", land: "file", file: { symbol: "AP2204K-1.5", footprint: "SOT-23-5" } });
    expect(doc.models).toEqual([expect.objectContaining({ part: doc.parts![0].id, model: expect.objectContaining({ source: "file", name: "Cube 10x10.stp" }) })]);
    expect(pageErrors, `unexpected page errors: ${pageErrors.join("\n")}`).toEqual([]);
  });
});
