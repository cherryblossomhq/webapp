// Manual routing, in a real browser.
//
// The preview deliberately never reaches React or the DOM — it lives in
// `routeLive.snapshot` and is painted imperatively — so these assertions read
// that snapshot through the app's own module instance. What they are really
// guarding is the two things the rebuild exists for: the rubber band is present,
// mode-legal and attached to the cursor on EVERY sample (that loop is the flicker
// regression test), and a click commits exactly the polyline that was drawn.

import { test, expect } from "@playwright/test";
import {
  all45,
  clientToWorld,
  draftState,
  editorRoutingState,
  expectBandUnderPointer,
  gridBoard,
  hasNaN,
  openPcbBoard,
  readPreview,
  setRoutingMode,
  startRouteAtPad,
  worldToClient,
  type PadInfo,
} from "./pcbRouting";

// The board is evaluated for real (tscircuit core + its autorouter on the one
// wired pair), which is seconds of work before the first assertion can run.
test.setTimeout(120_000);
test.use({ viewport: { width: 1280, height: 800 } });

const BOARD = gridBoard({ cols: 4, rows: 4, pitchMm: 6, boardMm: 40 });

/** Left pad of R1 — one end of the board's only wired net. */
function startPad(pads: PadInfo[]): PadInfo {
  return pads[0];
}

test.describe("PCB manual routing", () => {
  test("the rubber band never vanishes, jumps, or leaves 45°", async ({
    page,
  }) => {
    const pads = await openPcbBoard(page, BOARD);
    const from = startPad(pads);
    await startRouteAtPad(page, from);

    // 40 discrete steps sweeping across the board. After EVERY one the composed
    // preview has to be non-empty, NaN-free, exactly on the cursor, and legal for
    // the mode. A single failing sample is the flicker the founder reported.
    const samples: number[] = [];
    for (let i = 0; i < 40; i++) {
      // Starts 2mm out: inside the start pad's magnet radius the cursor snaps
      // back onto the anchor, and a leader with nowhere to go is correctly empty.
      const t = (i + 1) / 40;
      const at = await worldToClient(page, {
        x: from.x + 2 + t * 14,
        y: from.y + 2 + t * 11 * Math.sin(t * 3),
      });
      await page.mouse.move(at.x, at.y);
      const pointer = await clientToWorld(page, at);
      const pv = await readPreview(page);
      expect(pv.active, `step ${i}: preview went inactive`).toBe(true);
      expect(pv.points.length, `step ${i}: empty preview`).toBeGreaterThanOrEqual(
        2
      );
      expect(hasNaN(pv.points), `step ${i}: NaN in preview`).toBe(false);
      expect(pv.cursor, `step ${i}: no live cursor`).not.toBeNull();
      expectBandUnderPointer(pv, pointer, `step ${i}`);
      expect(all45(pv.points), `step ${i}: off-45 segment in diag45`).toBe(true);
      samples.push(pv.points.length);
    }
    // Sanity: the sweep really did move through geometry of varying complexity,
    // so the loop above was not 40 reads of one static shape.
    expect(Math.max(...samples)).toBeGreaterThan(Math.min(...samples));
  });

  test("a two-segment leader with a knee, mirrored by Space", async ({
    page,
  }) => {
    const pads = await openPcbBoard(page, BOARD);
    const from = startPad(pads);
    await startRouteAtPad(page, from);

    // Off-axis AND off-diagonal, and up-LEFT into open board: R1's other pad sits
    // immediately to the right of the anchor, so a rightward target would put
    // copper under one posture and pull the walkaround in. This test is about the
    // leader alone.
    const target = { x: from.x - 4.3, y: from.y + 2.1 };
    const at = await worldToClient(page, target);
    await page.mouse.move(at.x, at.y);

    const first = await readPreview(page);
    expect(first.points).toHaveLength(3); // anchor + knee + endpoint
    expect(first.kneeIndex).toBe(1);
    expect(all45(first.points)).toBe(true);

    await page.keyboard.press("Space");
    // The posture is read on the next frame, so nudge the pointer back to the
    // same place to force one.
    await page.mouse.move(at.x + 3, at.y);
    await page.mouse.move(at.x, at.y);

    const second = await readPreview(page);
    expect(second.points).toHaveLength(3);
    expect(second.kneeIndex).toBe(1);
    expect(second.posture).not.toBe(first.posture);
    // Mirrored knee, bit-identical endpoint: the whole point of Space.
    expect(second.points[1]).not.toEqual(first.points[1]);
    expect(second.points[2]).toEqual(first.points[2]);
    expect((await draftState(page))!.postureLocked).toBe(true);
  });

  test("clicking commits exactly the polyline that was drawn", async ({
    page,
  }) => {
    const pads = await openPcbBoard(page, BOARD);
    const from = startPad(pads);
    await startRouteAtPad(page, from);

    const target = { x: from.x - 4.3, y: from.y + 2.1 };
    const at = await worldToClient(page, target);
    await page.mouse.move(at.x, at.y);
    const drawn = await readPreview(page);
    expect(drawn.points).toHaveLength(3);

    await page.mouse.click(at.x, at.y);
    const after = await draftState(page);
    // Two vertices in diag45: the knee and the endpoint. Byte-for-byte the
    // preview's own tail — nothing is recomputed at commit time.
    expect(after!.points).toHaveLength(3);
    expect(after!.points.map((p) => [p.x, p.y])).toEqual(
      drawn.points.map((p) => [p.x, p.y])
    );
  });

  test("every mode commits the vertex count it draws", async ({ page }) => {
    const pads = await openPcbBoard(page, BOARD);
    const from = startPad(pads);

    for (const [mode, expected] of [
      ["ortho", 2],
      ["free", 1],
    ] as const) {
      await setRoutingMode(page, mode);
      await startRouteAtPad(page, from);
      const at = await worldToClient(page, {
        x: from.x - 4.3,
        y: from.y + 2.1,
      });
      await page.mouse.move(at.x, at.y);
      const drawn = await readPreview(page);
      expect(drawn.points.length - 1, `${mode}: drawn tail`).toBe(expected);
      await page.mouse.click(at.x, at.y);
      const after = await draftState(page);
      expect(after!.points.length - 1, `${mode}: committed tail`).toBe(expected);
      await page.keyboard.press("Escape");
      expect(await draftState(page)).toBeNull();
    }
  });

  test("a walkaround hug is committed vertex for vertex", async ({ page }) => {
    const pads = await openPcbBoard(page, BOARD);
    const from = startPad(pads);
    await startRouteAtPad(page, from);

    // The board centre: the direct 45° run from R1's left pad passes straight
    // through R6's pads, so this only works if the solver's hug is on screen —
    // and only counts if the click commits it.
    const at = await worldToClient(page, { x: 0, y: 0 });
    await page.mouse.move(at.x - 30, at.y + 20);
    await page.mouse.move(at.x, at.y, { steps: 8 });
    await expect
      .poll(async () => (await readPreview(page)).points.length)
      .toBeGreaterThan(3);

    const drawn = await readPreview(page);
    expect(drawn.hits.every((h) => h === 0), "hug still crosses copper").toBe(
      true
    );
    expect(all45(drawn.points)).toBe(true);

    await page.mouse.click(at.x, at.y);
    const after = await draftState(page);
    expect(after!.points.map((p) => [p.x, p.y])).toEqual(
      drawn.points.map((p) => [p.x, p.y])
    );
  });

  test("V drops the via at the cursor, and a second V takes it back", async ({
    page,
  }) => {
    const pads = await openPcbBoard(page, BOARD);
    const from = startPad(pads);
    await startRouteAtPad(page, from);

    const target = { x: from.x - 4.3, y: from.y + 2.1 };
    const at = await worldToClient(page, target);
    await page.mouse.move(at.x, at.y);
    const drawn = await readPreview(page);
    const head = drawn.points[drawn.points.length - 1];

    await page.keyboard.press("v");
    const withVia = await draftState(page);
    expect(withVia!.activeLayer).toBe("bottom");
    expect(withVia!.pendingVia).not.toBeNull();
    // At the cursor, not back at the previous corner.
    expect(withVia!.pendingVia!.x).toBeCloseTo(head.x, 9);
    expect(withVia!.pendingVia!.y).toBeCloseTo(head.y, 9);
    // The duplicate-XY-on-the-new-layer encoding is what pcbModel decodes as a via.
    const last = withVia!.points[withVia!.points.length - 1];
    const prev = withVia!.points[withVia!.points.length - 2];
    expect([last.x, last.y]).toEqual([prev.x, prev.y]);
    expect(last.layer).not.toBe(prev.layer);

    await page.keyboard.press("v");
    const undone = await draftState(page);
    expect(undone!.activeLayer).toBe("top");
    expect(undone!.pendingVia).toBeNull();
    expect(undone!.points).toHaveLength(1);
  });

  test("Esc abandons the route and empties the overlay", async ({ page }) => {
    const pads = await openPcbBoard(page, BOARD);
    const from = startPad(pads);
    await startRouteAtPad(page, from);
    const at = await worldToClient(page, { x: from.x + 5, y: from.y + 3 });
    await page.mouse.move(at.x, at.y);
    expect((await readPreview(page)).active).toBe(true);

    await page.keyboard.press("Escape");
    expect(await draftState(page)).toBeNull();
    await expect.poll(async () => (await readPreview(page)).active).toBe(false);
  });

  test("the preview canvas sits between the board canvas and the stage", async ({
    page,
  }) => {
    await openPcbBoard(page, BOARD);
    const order = await page.evaluate(() => {
      const wrapper = document.querySelector(
        '[data-testid="pcb-base-canvas"]'
      )!.parentElement!;
      return Array.from(wrapper.children).map((el) =>
        el.getAttribute("data-testid")
      );
    });
    // Paint order is DOM order: preview above committed copper, below the SVG's
    // selection halos, ratsnest and DRC markers — and below the element that owns
    // pointer capture.
    expect(order.slice(0, 3)).toEqual([
      "pcb-base-canvas",
      "pcb-route-canvas",
      "pcb-stage",
    ]);
    const style = await page.evaluate(() => {
      const el = document.querySelector(
        '[data-testid="pcb-route-canvas"]'
      ) as HTMLCanvasElement;
      const cs = getComputedStyle(el);
      return { pointerEvents: cs.pointerEvents, zIndex: cs.zIndex };
    });
    expect(style.pointerEvents).toBe("none");
    expect(style.zIndex).toBe("auto");
  });

  // Every draft-scoped key in ShortcutsHelp's PCB section, pressed against a live
  // route, each asserted by the state it is supposed to change. `registerShortcuts`
  // is global and its `matches()` demands exact modifier equality, so a spec that
  // is merely *declared* can still be shadowed or never reached — the only proof a
  // key is live is pressing it in a browser and watching the store move.
  test("every documented routing hotkey moves the state it claims to", async ({
    page,
  }) => {
    const pads = await openPcbBoard(page, BOARD);
    const from = startPad(pads);
    await setRoutingMode(page, "diag45");
    await startRouteAtPad(page, from);
    const at = await worldToClient(page, { x: from.x - 4.3, y: from.y + 2.1 });
    await page.mouse.move(at.x, at.y);

    // Space — swap posture, and lock it. Compared on the RENDERED posture, not
    // `draft.posture`: while unlocked that field is an inert placeholder and the
    // live posture is the per-frame auto guess, so comparing the store field to
    // itself would pass even if Space did nothing.
    expect((await draftState(page))!.postureLocked).toBe(false);
    const shown = async () => {
      // The posture is read on the next flush, so a nudge back and forth forces
      // one without moving where the band lands.
      await page.mouse.move(at.x + 3, at.y);
      await page.mouse.move(at.x, at.y);
      return (await readPreview(page)).posture;
    };
    const posture0 = await shown();
    await page.keyboard.press("Space");
    expect((await draftState(page))!.postureLocked).toBe(true);
    const posture1 = await shown();
    expect(posture1).not.toBe(posture0);

    // `/` — the same action on the other key, so it swaps straight back.
    await page.keyboard.press("/");
    expect(await shown()).toBe(posture0);

    // Shift+Space cycles the 4-member mode axis, in order, and is the ONLY
    // binding that does. `G` was a duplicate; it is asserted dead here so the
    // second binding cannot quietly come back and let the surfaces disagree
    // about the name of this action again.
    await page.keyboard.press("Shift+Space");
    expect((await editorRoutingState(page)).routingMode).toBe("curved");
    await page.keyboard.press("Shift+Space");
    expect((await editorRoutingState(page)).routingMode).toBe("free");
    await page.keyboard.press("g");
    expect((await editorRoutingState(page)).routingMode).toBe("free");
    await page.keyboard.press("Shift+Space");
    expect((await editorRoutingState(page)).routingMode).toBe("ortho");

    // `,` / `.` step the fillet radius, ×5 with Shift. The Shift form is pressed
    // as the SHIFTED CHARACTER (`Shift+>`), because that is what a real keyboard
    // delivers — `Shift+.` makes Playwright report key "." with shiftKey set,
    // which no physical keyboard produces.
    await setRoutingMode(page, "curved");
    const r0 = (await draftState(page))!.cornerRadiusMm;
    await page.keyboard.press(".");
    const r1 = (await draftState(page))!.cornerRadiusMm;
    expect(r1).toBeCloseTo(r0 + 0.05, 9);
    await page.keyboard.press("Shift+>");
    expect((await draftState(page))!.cornerRadiusMm).toBeCloseTo(r1 + 0.25, 9);
    await page.keyboard.press("Shift+<");
    expect((await draftState(page))!.cornerRadiusMm).toBeCloseTo(r1, 9);
    await page.keyboard.press(",");
    expect((await draftState(page))!.cornerRadiusMm).toBeCloseTo(r0, 9);

    // Shift+R — conflict mode, which also has to release the frozen hug.
    expect((await draftState(page))!.conflictMode).toBe("walkaround");
    await page.keyboard.press("Shift+R");
    expect((await draftState(page))!.conflictMode).toBe("ignore");
    await page.keyboard.press("Shift+R");
    expect((await draftState(page))!.conflictMode).toBe("walkaround");

    // Shift+C — clearance halo.
    const halo = (await editorRoutingState(page)).clearanceHaloVisible;
    await page.keyboard.press("Shift+C");
    expect((await editorRoutingState(page)).clearanceHaloVisible).toBe(!halo);
    await page.keyboard.press("Shift+C");
    expect((await editorRoutingState(page)).clearanceHaloVisible).toBe(halo);

    // T — trace width, which the draft must NOT adopt retroactively.
    const w0 = (await draftState(page))!.width;
    await page.keyboard.press("t");
    expect((await editorRoutingState(page)).traceWidth).not.toBe(w0);

    // 2 / 1 — jump copper layer, dropping an unfixed via at the cursor. Naming
    // the layer the pending via already leads back to takes it back, exactly as a
    // second V does, so points and layer both have to return to where they were.
    await setRoutingMode(page, "diag45");
    const flat = (await draftState(page))!.points.length;
    await page.keyboard.press("2");
    const onBottom = await draftState(page);
    expect(onBottom!.activeLayer).toBe("bottom");
    expect(onBottom!.pendingVia).not.toBeNull();
    expect(onBottom!.points.length).toBeGreaterThan(flat);
    await page.keyboard.press("1");
    const backOnTop = await draftState(page);
    expect(backOnTop!.activeLayer).toBe("top");
    expect(backOnTop!.pendingVia).toBeNull();
    expect(backOnTop!.points).toHaveLength(flat);

    // Backspace pops exactly ONE vertex per press — a click that placed two needs
    // two Backspaces — and NEVER falls through to deleteSelection on a one-point
    // draft, which used to delete the user's copper instead of their last click.
    await page.mouse.click(at.x, at.y);
    const deep = (await draftState(page))!.points.length;
    expect(deep).toBe(3);
    await page.keyboard.press("Backspace");
    expect((await draftState(page))!.points).toHaveLength(2);
    for (let i = 0; i < 4; i++) await page.keyboard.press("Backspace");
    expect((await draftState(page))!.points).toHaveLength(1);

    // The band is still live after all of that — proof Space never latched pan.
    await page.mouse.move(at.x + 12, at.y - 9);
    const still = await readPreview(page);
    expect(still.active).toBe(true);
    expect(still.points.length).toBeGreaterThanOrEqual(2);
  });

  test("Enter finishes the route as a dangling stub", async ({ page }) => {
    const pads = await openPcbBoard(page, BOARD);
    const from = startPad(pads);
    await setRoutingMode(page, "diag45");
    await startRouteAtPad(page, from);

    const at = await worldToClient(page, { x: from.x - 5, y: from.y + 3.4 });
    await page.mouse.move(at.x, at.y);
    const drawn = await readPreview(page);
    expect(drawn.points.length).toBeGreaterThanOrEqual(3);

    await page.keyboard.press("Enter");
    expect(await draftState(page)).toBeNull();
    // Committed to the sidecar, vertex for vertex, with the per-point width that
    // ProjectStore now has to carry through a save.
    const route = await page.evaluate(async () => {
      const mod = await import("/src/editor/state/editorStore.ts");
      const edits = mod.useEditorStore.getState().manualEdits as Record<
        string,
        { pcb?: { route?: Array<{ x: number; y: number; width?: number }> } }
      >;
      for (const entry of Object.values(edits)) {
        const r = entry.pcb?.route;
        if (r && r.length >= 2) {
          return r.map((p) => ({ x: p.x, y: p.y, width: p.width }));
        }
      }
      return null;
    });
    expect(route).not.toBeNull();
    expect(route!.map((p) => [p.x, p.y])).toEqual(
      drawn.points.map((p) => [p.x, p.y])
    );
    expect(route!.every((p) => typeof p.width === "number")).toBe(true);
  });

  test("curved mode draws a tessellated fillet that still lands on the cursor", async ({
    page,
  }) => {
    const pads = await openPcbBoard(page, BOARD);
    const from = startPad(pads);
    await setRoutingMode(page, "curved");
    await startRouteAtPad(page, from);

    const target = { x: from.x - 4.3, y: from.y + 2.1 };
    const at = await worldToClient(page, target);
    await page.mouse.move(at.x, at.y);
    const pointer = await clientToWorld(page, at);

    const pv = await readPreview(page);
    expect(pv.mode).toBe("curved");
    // A fillet is a flattened arc, so the vertex count is well above the 3 a
    // diag45 knee produces — and the whole thing still ends under the pointer.
    expect(pv.points.length).toBeGreaterThan(4);
    expect(hasNaN(pv.points)).toBe(false);
    expectBandUnderPointer(pv, pointer, "curved");
    // The knee dot marks the arc, so it has to sit ON the drawn polyline.
    expect(pv.kneeIndex).toBeGreaterThan(0);
    expect(pv.kneeIndex).toBeLessThan(pv.points.length);

    // Radius 0 has to degrade to exactly the diag45 two-segment leader.
    for (let i = 0; i < 40; i++) await page.keyboard.press(",");
    expect((await draftState(page))!.cornerRadiusMm).toBe(0);
    await page.mouse.move(at.x + 4, at.y);
    await page.mouse.move(at.x, at.y);
    const flat = await readPreview(page);
    expect(flat.points).toHaveLength(3);
    expect(all45(flat.points)).toBe(true);

    // And the arc commits as the polyline it was drawn as.
    for (let i = 0; i < 10; i++) await page.keyboard.press(".");
    await page.mouse.move(at.x + 4, at.y);
    await page.mouse.move(at.x, at.y);
    const arced = await readPreview(page);
    expect(arced.points.length).toBeGreaterThan(4);
    await page.mouse.click(at.x, at.y);
    const after = await draftState(page);
    expect(after!.points.map((p) => [p.x, p.y])).toEqual(
      arced.points.map((p) => [p.x, p.y])
    );
  });

  test("right-click abandons the route and leaves the sidecar alone", async ({
    page,
  }) => {
    const pads = await openPcbBoard(page, BOARD);
    const from = startPad(pads);
    await startRouteAtPad(page, from);
    const at = await worldToClient(page, { x: from.x + 5, y: from.y + 3 });
    await page.mouse.move(at.x, at.y);
    await page.mouse.click(at.x, at.y);
    expect((await draftState(page))!.points.length).toBeGreaterThan(1);

    await page.mouse.click(at.x + 20, at.y + 10, { button: "right" });
    expect(await draftState(page)).toBeNull();
    const routes = await page.evaluate(async () => {
      const mod = await import("/src/editor/state/editorStore.ts");
      const edits = mod.useEditorStore.getState().manualEdits as Record<
        string,
        { pcb?: { route?: unknown[] } }
      >;
      return Object.values(edits).filter(
        (entry) => (entry.pcb?.route?.length ?? 0) >= 2
      ).length;
    });
    expect(routes).toBe(0);
  });

  test("the status bar reports the live route", async ({ page }) => {
    const pads = await openPcbBoard(page, BOARD);
    const from = startPad(pads);
    await startRouteAtPad(page, from);
    const at = await worldToClient(page, { x: from.x + 5, y: from.y + 3 });
    await page.mouse.move(at.x, at.y);

    // The readout is one monospace strip of separate spans, so this asserts on its
    // whitespace-collapsed text rather than pinning six DOM shapes. Polled because
    // the HUD republishes at 10Hz, not per frame — that throttle is the point.
    const bar = page.getByTestId("pcb-status-bar");
    await expect(bar).toBeVisible();
    await expect
      .poll(async () => (await bar.innerText()).replace(/\s+/g, " "))
      .toMatch(/Top copper .* 0\.25 mm .* 45° .* first .* walk .* len \d+\.\d\d mm/);
  });

  // Airwires are MST edges BETWEEN pads, so every one of them terminates on a
  // pad, and their invisible pick capsule (12 screen px) sits directly over the
  // copper a route has to click. That capsule used to stay hit-testable while
  // routing, with a bubble-phase handler that focused the net and set a pointer
  // cursor — so mid-route the highlight jumped to whatever airwire the cursor
  // crossed and every other net dimmed. (The route itself still committed: the
  // canvas takes pointerdown in the CAPTURE phase precisely because airwires
  // swallow events, which is why the damage was a stolen selection rather than
  // a lost route.)
  //
  // This asserts the invariant directly — while the route tool is active no
  // airwire is hit-testable — because the functional symptoms are masked by
  // that capture-phase handler and by route-start legitimately focusing its own
  // net, so neither can tell the two states apart.
  test("airwires are not hit-testable while the route tool is active", async ({
    page,
  }) => {
    await openPcbBoard(page, BOARD);

    // The board's one net is autorouted during eval, so it has NO airwire and
    // the test would prove nothing. `noAutoroute` is the app's own "user deleted
    // this copper" flag: it hides the eval's trace and brings the airwire back,
    // which is exactly the state you are in when hand-routing a net.
    await page.evaluate(async () => {
      const [store, ids] = await Promise.all([
        import("/src/editor/state/editorStore.ts"),
        import("/src/editor/shared/connectionId.ts"),
      ]);
      const key = ids.connectionId(
        ids.canonEndpoint(".R1 > .pin1"),
        ids.canonEndpoint(".R16 > .pin2")
      );
      store.useEditorStore.getState().setPcbEdit(key, { noAutoroute: true });
    });

    const readWire = () =>
      page.evaluate(() => {
        const l = document.querySelector('line[stroke-dasharray="2 1.5"]');
        if (!l) return null;
        const n = (a: string) => Number(l.getAttribute(a));
        return { x1: n("x1"), y1: n("y1"), x2: n("x2"), y2: n("y2") };
      });

    // Guard the fixture: without this the whole test silently degrades to a
    // no-op the moment the board stops producing an airwire — which is exactly
    // how the first version of this test passed against the unfixed code.
    await expect.poll(readWire).not.toBeNull();
    const wire = (await readWire())!;

    // Midpoint of the airwire, where only the capsule can be hit.
    const mid = await worldToClient(page, {
      x: (wire.x1 + wire.x2) / 2,
      y: (wire.y1 + wire.y2) / 2,
    });
    const capsuleAt = (x: number, y: number) =>
      page.evaluate(
        (p) =>
          document
            .elementsFromPoint(p.x, p.y)
            .some(
              (e) =>
                e.tagName === "line" &&
                e.getAttribute("stroke") === "transparent"
            ),
        { x, y }
      );

    // Select tool: still a target, so net focus keeps working where it should.
    expect(await capsuleAt(mid.x, mid.y)).toBe(true);

    // Route tool: a guide, not a target.
    await startRouteAtPad(page, { x: wire.x1, y: wire.y1 });
    await page.mouse.move(mid.x, mid.y);
    expect(await capsuleAt(mid.x, mid.y)).toBe(false);
  });
});
