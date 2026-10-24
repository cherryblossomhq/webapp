import type { Box } from "../../lib/geometry"
import { parseProjectFile, serializeProject } from "../../model/projectFile"
import { tidySchematic, type TidyResult } from "../../model/tidy"
import type { Vec2 } from "../../model/types"
import { toScreen, type ViewTransform } from "../viewport"
import { projectApi } from "../../store/projectStore"
import { selectionIds, uiApi } from "../../store/uiStore"

// Tidy from the schematic toolbar and the T shortcut: the selected block when exactly one block is
// selected, else the whole sheet, as one undo step.

type Listener = (r: TidyResult & { whole: boolean; blockId?: string }) => void
const listeners = new Set<Listener>()
const busyListeners = new Set<(busy: boolean) => void>()
let busy = false

/** Hear about each tidy: the toolbar says what it did, the canvas shows what was tidied. */
export function onTidy(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Hear when a tidy starts and ends, so the toolbar can show it is working. */
export function onTidyBusy(listener: (busy: boolean) => void): () => void {
  busyListeners.add(listener)
  return () => {
    busyListeners.delete(listener)
  }
}

const setBusy = (value: boolean) => {
  busy = value
  for (const l of busyListeners) l(value)
}

/** What the page sends the tidy worker. */
export interface TidyRequest {
  file: string
  blockId?: string
}

/** What the tidy worker sends back: the tidy, with the project as a file, or what went wrong. */
export type TidyReply = (Omit<TidyResult, "project"> & { project: string | null }) | { error: string }

/** The block a tidy from the toolbar works on: the selected one when exactly one is selected. */
function selectedBlock(): string | undefined {
  const blocks = selectionIds(uiApi().selection, "b")
  return blocks.length === 1 ? blocks[0] : undefined
}

/** Take a tidy's result into the project as one undo step, and tell the listeners. */
function apply(blockId: string | undefined, result: TidyResult): TidyResult {
  if (result.changed) {
    projectApi().commit(() => result.project)
    // Wires, labels and ports are drawn anew, so only what is still there stays selected.
    const p = result.project
    const alive = new Set([
      ...p.components.map((c) => `c:${c.id}`),
      ...p.wires.map((w) => `w:${w.id}`),
      ...p.labels.map((l) => `l:${l.id}`),
      ...(p.blocks ?? []).map((b) => `b:${b.id}`),
    ])
    uiApi().select(uiApi().selection.filter((id) => alive.has(id)))
  }
  for (const l of listeners) l({ ...result, whole: !blockId, blockId })
  return result
}

/**
 * Take a result into the sheet and tell the listeners, as a tidy does: for a whole-sheet change made
 * by something that runs Tidy among other steps (Clean up), so it is one undo step and the toolbar
 * and the view hear about it like any tidy.
 */
export const applyTidyResult = (result: TidyResult): TidyResult => apply(undefined, result)

/** Tell the listeners the whole sheet was tidied elsewhere (by Sakura): the toolbar says so and the view fits it. */
export function announceTidy(result: TidyResult): void {
  for (const l of listeners) l({ ...result, whole: true })
}

let worker: Worker | null = null
/** The running tidy's time limit, cleared when it answers. */
let timer: ReturnType<typeof setTimeout> | null = null

/** How long a tidy in the worker may take before it is stopped: the 150-part design takes about a second. */
export const TIDY_TIMEOUT_MS = 30_000

/** The tidy worker, made once; null where there are no workers (tests) or it can't start. */
function tidyWorker(): Worker | null {
  if (worker || typeof Worker !== "function") return worker
  try {
    worker = new Worker(new URL("./tidy.worker.ts", import.meta.url), { type: "module" })
  } catch {
    worker = null
  }
  return worker
}

/** The worker shut down and its time limit cleared: a stuck tidy, or the editor going away. */
function dropWorker() {
  if (timer !== null) clearTimeout(timer)
  timer = null
  if (worker) {
    // A reply already on its way from the worker stopped is never heard.
    worker.onmessage = null
    worker.onerror = null
    worker.terminate()
  }
  worker = null
}

/** Stop a tidy still running and shut its worker down, as the editor closes. Nothing is changed. */
export function stopTidy(): void {
  dropWorker()
  if (busy) setBusy(false)
}

const unchanged = (project: TidyResult["project"], message: string, problems: string[] = []): TidyResult => ({
  project,
  changed: false,
  ok: false,
  message,
  renamed: {},
  dropped: [],
  loose: { wires: 0, labels: 0, ports: 0 },
  problems,
  kept: [],
})

/**
 * Tidy from the toolbar or a key, off the page's thread where it can be, so a big sheet doesn't
 * freeze the page: the toolbar says it is working meanwhile. A sheet edited while it worked is
 * left as it is now. A tidy that takes longer than `TIDY_TIMEOUT_MS` is stopped, its worker shut
 * down, and the sheet left as it was, so the button never stays greyed. Where there are no workers
 * it runs here, after the busy state is drawn.
 */
export function startTidy(timeoutMs = TIDY_TIMEOUT_MS): void {
  // A viewer's tidy could only be refused, after the worker had done it all.
  if (busy || projectApi().role === "viewer") return
  setBusy(true)
  const w = tidyWorker()
  const before = projectApi().project
  if (w && before) {
    const blockId = selectedBlock()
    const tell = (r: TidyResult) => {
      for (const l of listeners) l({ ...r, whole: !blockId, blockId })
    }
    timer = setTimeout(() => {
      dropWorker()
      setBusy(false)
      tell(unchanged(before, "Tidy took too long and was stopped; nothing was changed."))
    }, timeoutMs)
    w.onmessage = (e: MessageEvent<TidyReply>) => {
      if (timer !== null) clearTimeout(timer)
      timer = null
      setBusy(false)
      const reply = e.data
      const now = projectApi().project
      if ("error" in reply) {
        tell(unchanged(before, "Tidy couldn't finish; nothing was changed.", [reply.error]))
        return
      }
      if (now !== before) {
        tell({ ...reply, project: before, changed: false, ok: false, message: "The sheet changed while it was being tidied, so nothing was changed.", problems: [] })
        return
      }
      const project = reply.project ? { ...parseProjectFile(reply.project, { id: before.id, createdAt: before.createdAt, updatedAt: Date.now() }) } : before
      apply(blockId, { ...reply, project })
    }
    w.onerror = () => {
      // The worker couldn't run: tidy here instead.
      dropWorker()
      setTimeout(() => {
        try {
          tidySelected()
        } finally {
          setBusy(false)
        }
      }, 0)
    }
    w.postMessage({ file: serializeProject(before), blockId } satisfies TidyRequest)
    return
  }
  const run = () => {
    try {
      tidySelected()
    } finally {
      setBusy(false)
    }
  }
  // The frame paints the busy state; the tidy runs after it.
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => setTimeout(run, 0))
  else setTimeout(run, 0)
}

/** Tidy here and now, on the page's thread. */
export function tidySelected(): TidyResult {
  const before = projectApi().project!
  const blockId = selectedBlock()
  return apply(blockId, tidySchematic(before, { blockId }))
}

/**
 * How to show a block just tidied, which may have moved to find room: nothing when it is in view;
 * else centred at the same zoom when it fits there, or fitted when it doesn't.
 */
export function viewForBlock(
  frame: Box,
  t: ViewTransform,
  size: { width: number; height: number },
): { kind: "none" } | { kind: "center"; at: Vec2; scale: number } | { kind: "fit" } {
  const a = toScreen(t, { x: frame.minX, y: frame.maxY })
  const b = toScreen(t, { x: frame.maxX, y: frame.minY })
  if (a.x >= 0 && a.y >= 0 && b.x <= size.width && b.y <= size.height) return { kind: "none" }
  if (b.x - a.x <= size.width * 0.9 && b.y - a.y <= size.height * 0.9) {
    return { kind: "center", at: { x: (frame.minX + frame.maxX) / 2, y: (frame.minY + frame.maxY) / 2 }, scale: t.scale }
  }
  return { kind: "fit" }
}
