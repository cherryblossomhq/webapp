// Shared harness for the two PCB manual-routing browser specs.
//
// Both specs seed a board through `localStorage` and never touch the network:
// the editor restores the autosave on mount, so the board is on screen with no
// setup at all.
//
// State is read through the app's OWN modules. Vite dev serves source by URL, so
// `import("/src/editor/pcb/routeLive.ts")` inside `page.evaluate` resolves to the
// very module instance the running app holds — which is the only way to observe
// a preview that deliberately never reaches React or the DOM.

import { expect, type Page } from "@playwright/test";

const AUTOSAVE_KEY = "cherryblossom_autosave";

/** A grid of 0402 resistors plus one wired pair, as an `export default` board. */
export function gridBoard(opts: {
  cols: number;
  rows: number;
  pitchMm: number;
  boardMm: number;
  chips?: number;
}): string {
  const { cols, rows, pitchMm, boardMm } = opts;
  const parts: string[] = [];
  let n = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      n++;
      const x = (c - (cols - 1) / 2) * pitchMm;
      const y = (r - (rows - 1) / 2) * pitchMm;
      parts.push(
        `<resistor name="R${n}" resistance="1k" footprint="0402" ` +
          `pcbX={${x.toFixed(2)}} pcbY={${y.toFixed(2)}} />`
      );
    }
  }
  for (let i = 0; i < (opts.chips ?? 0); i++) {
    const x = (i === 0 ? -1 : 1) * pitchMm * 1.5;
    parts.push(
      `<chip name="U${i + 1}" footprint="soic8" pcbX={${x.toFixed(2)}} pcbY={0} />`
    );
  }
  // One wired pair at the far corners. The manual route is drawn on THIS net, so
  // its two pads are the only copper the route is allowed to land on — and the
  // long diagonal guarantees the walkaround has obstacles to get around.
  parts.push(`<trace from=".R1 > .pin1" to=".R${n} > .pin2" />`);
  return `export default () => (\n  <board width="${boardMm}mm" height="${boardMm}mm">\n    ${parts.join(
    "\n    "
  )}\n  </board>\n);\n`;
}

export interface PadInfo {
  id: string;
  x: number;
  y: number;
  layer: string;
}

/** Load the board, switch to the PCB tab, and wait for real pads to exist. */
export async function openPcbBoard(page: Page, tsx: string): Promise<PadInfo[]> {
  await page.addInitScript(
    ([key, code]) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          version: 1,
          tsxCode: code,
          metadata: { title: "Routing" },
          manualEdits: {},
        })
      );
    },
    [AUTOSAVE_KEY, tsx] as const
  );
  await page.goto("/");
  await page.getByRole("tab", { name: "PCB", exact: true }).click();

  // A 100+ pad board takes seconds of real eval (plus the capacity-mesh
  // autorouter on the one wired pair), so this polls rather than waits on a
  // selector.
  await expect
    .poll(() => padCount(page), { timeout: 110_000, intervals: [400] })
    .toBeGreaterThan(0);
  return pads(page);
}

function padCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const mod = await import("/src/store/circuitStore.ts");
    const cj = mod.useCircuitStore.getState().circuitJson as
      | Array<{ type?: string }>
      | null;
    return cj ? cj.filter((e) => e.type === "pcb_smtpad").length : 0;
  });
}

export function pads(page: Page): Promise<PadInfo[]> {
  return page.evaluate(async () => {
    const mod = await import("/src/store/circuitStore.ts");
    const cj = (mod.useCircuitStore.getState().circuitJson ?? []) as Array<
      Record<string, unknown>
    >;
    return cj
      .filter((e) => e.type === "pcb_smtpad")
      .map((e) => ({
        id: String(e.pcb_smtpad_id),
        x: Number(e.x),
        y: Number(e.y),
        layer: String(e.layer),
      }));
  });
}

/**
 * Client-space pixel for a world millimetre point. Derived from the live
 * viewport + the `<svg>` box rather than the stage `<g transform>` string, so it
 * cannot drift from `screenToWorld` — note the Y flip.
 */
export async function worldToClient(
  page: Page,
  world: { x: number; y: number }
): Promise<{ x: number; y: number }> {
  return page.evaluate(async (w) => {
    const mod = await import("/src/editor/state/editorStore.ts");
    const vp = mod.useEditorStore.getState().viewport.pcb;
    const svg = document.querySelector(
      '[data-testid="pcb-stage"]'
    ) as SVGSVGElement;
    const box = svg.getBoundingClientRect();
    return {
      x: box.left + box.width / 2 + vp.x + w.x * vp.scale,
      y: box.top + box.height / 2 + vp.y - w.y * vp.scale,
    };
  }, world);
}

/**
 * The inverse of `worldToClient` — where the mouse actually is, in millimetres.
 *
 * This is what makes "the band ends at the cursor" a real assertion rather than a
 * tautology: the live snapshot reports the band's own LANDING point (the readout
 * has to say where the copper goes, not where the mouse is), so comparing the
 * band's last vertex against the snapshot's cursor field would only ever compare
 * a number with itself. Deriving the pointer position independently, from the
 * client pixel the spec asked Playwright to move to, is the only honest check.
 */
export async function clientToWorld(
  page: Page,
  client: { x: number; y: number }
): Promise<PointerWorld> {
  return page.evaluate(async (c) => {
    const mod = await import("/src/editor/state/editorStore.ts");
    const vp = mod.useEditorStore.getState().viewport.pcb;
    const svg = document.querySelector(
      '[data-testid="pcb-stage"]'
    ) as SVGSVGElement;
    const box = svg.getBoundingClientRect();
    return {
      x: (c.x - box.left - box.width / 2 - vp.x) / vp.scale,
      y: -(c.y - box.top - box.height / 2 - vp.y) / vp.scale,
      pxMm: 1 / vp.scale,
    };
  }, client);
}

export interface PointerWorld {
  x: number;
  y: number;
  /** One screen pixel in millimetres, so a tolerance can be zoom-aware. */
  pxMm: number;
}

/** Half the 0.1mm fine grid, plus the leader's axis-lock slack. */
export const LANDING_TOLERANCE_MM = 0.05 + 0.025;

/**
 * Assert the band's last vertex really is under the pointer.
 *
 * Two legal outcomes, and the magnet has to be told apart from the grid or the
 * bound would have to be widened to the magnet radius and would then prove
 * nothing. On a pad magnet the band must land exactly on the pad; otherwise it
 * must land within half a grid step of the pointer, plus the ≤0.025mm the leader
 * is allowed to move the endpoint when it snaps a near-axis run flat, plus one
 * pixel — Blink reports `clientX` as an integer, so the fractional pixel this
 * spec asked Playwright to move to is not the one the app was handed.
 *
 * That still leaves the bound at a couple of pixels, which is the point: a band
 * that reverted to a straight line, or jumped to a magnet it should not have
 * taken, is out by millimetres.
 */
export function expectBandUnderPointer(
  pv: PreviewSample,
  pointer: PointerWorld,
  label: string
): void {
  const end = pv.points[pv.points.length - 1];
  if (pv.snapKind !== 0) {
    expect(end.x, `${label}: band off the magnet`).toBeCloseTo(pv.snap.x, 9);
    expect(end.y, `${label}: band off the magnet`).toBeCloseTo(pv.snap.y, 9);
    return;
  }
  const tol = LANDING_TOLERANCE_MM + pointer.pxMm;
  expect(
    Math.abs(end.x - pointer.x),
    `${label}: band x ${end.x} is not under pointer x ${pointer.x}`
  ).toBeLessThanOrEqual(tol);
  expect(
    Math.abs(end.y - pointer.y),
    `${label}: band y ${end.y} is not under pointer y ${pointer.y}`
  ).toBeLessThanOrEqual(tol);
}

export interface PreviewSample {
  active: boolean;
  points: Array<{ x: number; y: number }>;
  committed: Array<{ x: number; y: number }>;
  kneeIndex: number;
  /** The band's landing point as the app reports it, NOT the raw pointer. */
  cursor: { x: number; y: number } | null;
  /** 0 = no magnet, 1 = pad on the routed net, 2 = pad on a foreign net. */
  snapKind: number;
  snap: { x: number; y: number };
  blocked: boolean;
  mode: string;
  posture: string;
  hits: number[];
}

/**
 * One read of the live preview, straight off `routeLive.snapshot`.
 *
 * Waits two animation frames first. A pointer move only STAMPS a ref and asks for
 * a frame — that is the entire point of the design — so reading the snapshot in
 * the same task as the move would race the flush and see the previous geometry.
 */
export function readPreview(page: Page): Promise<PreviewSample> {
  return page.evaluate(async () => {
    await new Promise<void>((res) =>
      requestAnimationFrame(() => requestAnimationFrame(() => res()))
    );
    const mod = await import("/src/editor/pcb/routeLive.ts");
    const s = mod.routeLive.snapshot;
    const pts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < s.previewLen; i++) {
      pts.push({ x: s.previewX[i], y: s.previewY[i] });
    }
    const committed: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < s.committedLen; i++) {
      committed.push({ x: s.committedX[i], y: s.committedY[i] });
    }
    const hits: number[] = [];
    for (let i = 0; i + 1 < s.previewLen; i++) hits.push(s.previewHit[i]);
    return {
      active: s.active,
      points: pts,
      committed,
      hits,
      kneeIndex: s.kneeIndex,
      cursor: s.cursorValid ? { x: s.cursorX, y: s.cursorY } : null,
      snapKind: s.snapKind,
      snap: { x: s.snapX, y: s.snapY },
      blocked: s.blocked,
      mode: s.mode,
      posture: s.posture,
    };
  });
}

export interface LiveStats {
  moveCount: number;
  rafCount: number;
  storeWrites: number;
  solveCount: number;
  okCount: number;
  timeoutCount: number;
  blockedCount: number;
  directFallbackCount: number;
  moveSelfMsMax: number;
  flushMsMax: number;
  flushMsSamples: number[];
  moveSelfMsSamples: number[];
}

export function readStats(page: Page): Promise<LiveStats> {
  return page.evaluate(async () => {
    const mod = await import("/src/editor/pcb/routeLive.ts");
    const s = mod.routeLive.stats;
    return {
      moveCount: s.moveCount,
      rafCount: s.rafCount,
      storeWrites: s.storeWrites,
      solveCount: s.solveCount,
      okCount: s.okCount,
      timeoutCount: s.timeoutCount,
      blockedCount: s.blockedCount,
      directFallbackCount: s.directFallbackCount,
      moveSelfMsMax: s.moveSelfMsMax,
      flushMsMax: s.flushMsMax,
      flushMsSamples: s.flushMsSamples.slice(),
      moveSelfMsSamples: s.moveSelfMsSamples.slice(),
    };
  });
}

export function resetStats(page: Page): Promise<void> {
  return page.evaluate(async () => {
    const mod = await import("/src/editor/pcb/routeLive.ts");
    mod.routeLive.resetStats();
  });
}

export function draftPointCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const mod = await import("/src/editor/state/editorStore.ts");
    return mod.useEditorStore.getState().pcbRouteDraft?.points.length ?? 0;
  });
}

export function draftState(page: Page): Promise<{
  points: Array<{ x: number; y: number; layer: string; width?: number }>;
  activeLayer: string;
  pendingVia: { x: number; y: number } | null;
  posture: string;
  postureLocked: boolean;
  conflictMode: string;
  cornerRadiusMm: number;
  width: number;
} | null> {
  return page.evaluate(async () => {
    const mod = await import("/src/editor/state/editorStore.ts");
    const d = mod.useEditorStore.getState().pcbRouteDraft;
    if (!d) return null;
    return {
      points: d.points.map((p) => ({
        x: p.x,
        y: p.y,
        layer: p.layer,
        width: p.width,
      })),
      activeLayer: d.activeLayer,
      pendingVia: d.pendingVia ? { x: d.pendingVia.x, y: d.pendingVia.y } : null,
      posture: d.posture,
      postureLocked: d.postureLocked,
      conflictMode: d.conflictMode,
      cornerRadiusMm: d.cornerRadiusMm,
      width: d.width,
    };
  });
}

/** Editor-level (not per-draft) routing state the hotkeys reach. */
export function editorRoutingState(page: Page): Promise<{
  routingMode: string;
  clearanceHaloVisible: boolean;
  traceWidth: number;
  activeLayer: string;
}> {
  return page.evaluate(async () => {
    const mod = await import("/src/editor/state/editorStore.ts");
    const s = mod.useEditorStore.getState();
    return {
      routingMode: s.routingMode,
      clearanceHaloVisible: s.clearanceHaloVisible,
      traceWidth: s.traceWidth,
      activeLayer: s.activeLayer,
    };
  });
}

export function setRoutingMode(page: Page, mode: string): Promise<void> {
  return page.evaluate(async (m) => {
    const mod = await import("/src/editor/state/editorStore.ts");
    // Cast through the store's own action rather than poking state, so the
    // toolbar / status bar see the change exactly as a keypress would leave it.
    mod.useEditorStore.getState().setRoutingMode(m as "ortho");
  }, mode);
}

/** Every preview segment's angle, in degrees, normalised to [0, 180). */
export function segmentAngles(pts: ReadonlyArray<{ x: number; y: number }>) {
  const out: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) continue;
    out.push((((Math.atan2(dy, dx) * 180) / Math.PI + 180) % 180 + 180) % 180);
  }
  return out;
}

/** True when every segment sits on a 45° multiple (within floating slop). */
export function all45(pts: ReadonlyArray<{ x: number; y: number }>): boolean {
  return segmentAngles(pts).every((a) => {
    const r = a % 45;
    return r < 1e-6 || 45 - r < 1e-6;
  });
}

export function hasNaN(pts: ReadonlyArray<{ x: number; y: number }>): boolean {
  return pts.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y));
}

/** Start the route tool on `pad` and confirm a draft exists. */
export async function startRouteAtPad(
  page: Page,
  pad: { x: number; y: number }
): Promise<void> {
  await page.keyboard.press("w");
  const at = await worldToClient(page, pad);
  await page.mouse.move(at.x, at.y);
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => draftPointCount(page)).toBeGreaterThan(0);
}
