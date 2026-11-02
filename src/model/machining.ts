import { copperLayers, flipLayer, kicadLayerName, viaLayers } from "./stack"
import { componentFootprint, pcbPads } from "./instances"
import { resolvedComponents } from "./ruleAreas"
import { onBoard } from "./partFlags"
import { defaultStackup } from "./stack"
import { viaTentedOn } from "./viaRules"
import type { Backdrill, BoardDef, CopperLayer, DesignRules, PostMachining, Project, StackRow, Via } from "./types"

// X22: what a via or a pad is made with after it is drilled (via protection after IPC-4761, backdrills, counterbores and countersinks), and the rules KiCad gives them
// (drill_enumerator.cpp, padstack.cpp and pcb_track.cpp of the 10.0 line, commit de08734). The outputs (`export/excellon.ts`, `export/notes.ts`) and Checks read it here.

/** What a via has, its own settings over the board's: each part is on or off. Tenting is X5's (`viaTentedOn`). */
interface ViaProtectionState {
  cap: boolean
  fill: boolean
  coverFront: boolean
  coverBack: boolean
  plugFront: boolean
  plugBack: boolean
  tentFront: boolean
  tentBack: boolean
}

/** A via's protection as KiCad's drill enumerator resolves it (`enumerateVia`, `:107-135`): a part the via does not say is the board's, and the board's is off unless `rules.viaProtect` says. */
export function viaProtection(rules: Pick<DesignRules, "viaProtect" | "tentVias" | "tentSides">, via: Pick<Via, "protect" | "tent" | "kind" | "from" | "to">, board?: Pick<BoardDef, "stack">): ViaProtectionState {
  const rule = rules.viaProtect
  const own = via.protect
  // A side is the board's front or back: a via whose end on that side is an inner layer has no such side (KiCad's `IsCovered( aLayer )` says nothing for an inner layer, and the board's rule is for the outer ones).
  const ends = board && via.kind ? viaLayers(board, via) : null
  const frontOuter = !ends || ends[0] === "top"
  const backOuter = !ends || ends[ends.length - 1] === "bottom"
  return {
    cap: own?.cap ?? rule?.cap ?? false,
    fill: own?.fill ?? rule?.fill ?? false,
    coverFront: frontOuter && (own?.cover?.front ?? rule?.cover?.front ?? false),
    coverBack: backOuter && (own?.cover?.back ?? rule?.cover?.back ?? false),
    plugFront: frontOuter && (own?.plug?.front ?? rule?.plug?.front ?? false),
    plugBack: backOuter && (own?.plug?.back ?? rule?.plug?.back ?? false),
    tentFront: viaTentedOn(rules, via, "top"),
    tentBack: viaTentedOn(rules, via, "bottom"),
  }
}

/** The parts of a via's protection that are on (without tenting), in words: `filled`, `capped`, `covered on the front`... Empty when there is none. */
export function protectionWords(p: ViaProtectionState): string[] {
  const out: string[] = []
  if (p.fill) out.push("filled")
  if (p.cap) out.push("capped")
  if (p.coverFront && p.coverBack) out.push("covered on both sides")
  else if (p.coverFront) out.push("covered on the front")
  else if (p.coverBack) out.push("covered on the back")
  if (p.plugFront && p.plugBack) out.push("plugged on both sides")
  else if (p.plugFront) out.push("plugged on the front")
  else if (p.plugBack) out.push("plugged on the back")
  return out
}

// ---------- layers by KiCad's ids ----------

/** KiCad's number for a copper layer: `F.Cu` 0, `B.Cu` 2, `In1.Cu` 4 and so on by twos. Backdrill spans and the drill depth are ordered by it. */
const kicadId = (l: CopperLayer): number => (l === "top" ? 0 : l === "bottom" ? 2 : 2 + 2 * Number(l.slice(2)))

/** A layer's place in the file names of KiCad's drill files, from 1 at the front (`layerIndex` of `getDrillFileName`). */
export const fileIndex = (board: Pick<BoardDef, "stack">, l: CopperLayer) => copperLayers(board).indexOf(l) + 1

/** KiCad's own name for a layer in a drill file's name: `front`, `in3`, `back` (`GENDRILL_WRITER_BASE::layerName`). */
export const drillLayerName = (l: CopperLayer) => (l === "top" ? "front" : l === "bottom" ? "back" : `in${l.slice(2)}`)

// ---------- the drill depth ----------

/** KiCad's thickness of copper where a row says none (`BOARD_STACKUP_ITEM::GetCopperDefaultThickness`). */
const COPPER_DEFAULT = 0.035

/** The rows a board's stackup has, or the ones KiCad makes for a board that has none (`BuildDefaultStackupList`: 35 micrometre copper everywhere, the dielectrics sharing what is left). */
function stackupRows(board: Pick<BoardDef, "stack" | "thickness">): StackRow[] {
  if (board.stack?.rows?.length) return board.stack.rows
  const n = copperLayers(board).length
  const copper = 0.035
  const mask = 0.01
  const each = Math.trunc(((board.thickness - copper * n - mask * 2) * 1e6) / Math.max(1, n - 1)) / 1e6
  return defaultStackup(n, board.thickness).map((r) => (r.type === "copper" ? { ...r, thickness: copper } : r.name.startsWith("dielectric") ? { ...r, thickness: each } : r))
}

/**
 * The depth KiCad says a backdrill from `first` to `second` leaves as its stub (`BOARD_STACKUP::GetDrillDepth`, board_stackup.cpp `:977`): the rows of the stackup are added in
 * order from the front when `second`'s number is above `first`'s, from the back otherwise, up to and including the copper of `second`, then half of the next row that is
 * a dielectric or copper. Silkscreen, paste and mask rows count for nothing. KiCad compares the two ids, not their places in the stack, so a drill that starts on `B.Cu` (id 2) and
 * ends on an inner layer (id 4 and up) is measured from the front, which is how KiCad's own drill files say it.
 */
export function drillDepth(board: Pick<BoardDef, "stack" | "thickness">, first: CopperLayer, second: CopperLayer): number {
  const rows = stackupRows(board)
  const ordered = kicadId(second) > kicadId(first) ? rows : [...rows].reverse()
  const copperName = (l: CopperLayer) => kicadLayerName(l)
  const target = copperName(second)
  let total = 0
  let half = false
  for (const row of ordered) {
    const isCopper = row.type === "copper"
    const isDielectric = row.name.startsWith("dielectric") || row.type === "core" || row.type === "prepreg"
    if (!isCopper && !isDielectric) continue
    const thickness = [row.thickness ?? (isCopper ? COPPER_DEFAULT : 0), ...(row.sub ?? []).map((s) => s.thickness ?? 0)]
    total += thickness.reduce((a, t) => a + (half ? t / 2 : t), 0)
    if (half) return total
    if (isCopper && row.name === target) half = true
  }
  return total
}

// ---------- vias ----------

/** One backdrilled hole of a via, as KiCad's Excellon writer lists it: a non-plated hole at the via's place on the span the drill goes between. */
export interface ViaBackdrill {
  via: Via
  /** `secondary` is the via's `backdrill`, `tertiary` its `tertiary_drill`. */
  kind: "secondary" | "tertiary"
  x: number
  y: number
  size: number
  /** The layers the bit runs between as the file names them: start and end. */
  from: CopperLayer
  to: CopperLayer
  /** KiCad's stub depth for this drill (`drillDepth`). */
  stub: number
}

/** The layers of a backdrill in stack order: where the bit is above and below. */
export const spanOf = (board: Pick<BoardDef, "stack">, d: Pick<Backdrill, "from" | "to">): [CopperLayer, CopperLayer] => {
  const all = copperLayers(board)
  return all.indexOf(d.from) <= all.indexOf(d.to) ? [d.from, d.to] : [d.to, d.from]
}

/** Every backdrill of a via of the board, secondary then tertiary for each. */
export function viaBackdrills(project: Pick<Project, "vias" | "board">): ViaBackdrill[] {
  const out: ViaBackdrill[] = []
  for (const v of project.vias) {
    for (const [kind, d] of [["secondary", v.backdrill], ["tertiary", v.tertiary]] as const) {
      if (!d) continue
      out.push({ via: v, kind, x: v.x, y: v.y, size: d.size, from: d.from, to: d.to, stub: drillDepth(project.board, d.from, d.to) })
    }
  }
  return out
}

/** The text of one post-machining as KiCad's drill file comments it (`writePostMachiningComment`): `Post-machining front countersink dia 0.800mm depth 0.200mm angle 90deg`. */
export function postMachiningComment(side: "front" | "back", p: PostMachining): string {
  const mm = (v: number | undefined) => (v !== undefined && v > 0 ? `${v.toFixed(3)}mm` : "")
  const parts = [`Post-machining ${side} ${p.mode}`]
  if (mm(p.size)) parts.push(`dia ${mm(p.size)}`)
  if (mm(p.depth)) parts.push(`depth ${mm(p.depth)}`)
  if (p.mode === "countersink" && p.angle !== undefined && p.angle > 0) parts.push(`angle ${Number.isInteger(p.angle) ? p.angle.toFixed(0) : p.angle.toFixed(1)}deg`)
  return parts.join(" ")
}

/** The largest hole a via or pad has on any of its layers (`PADSTACK::GetMaxHoleSize`): its drill, the size of a post-machining and of a backdrill. */
function maxHoleSize(drill: number, o: { backdrill?: Backdrill; tertiary?: Backdrill; post?: { front?: PostMachining; back?: PostMachining } }): number {
  return Math.max(drill, o.backdrill?.size ?? 0, o.tertiary?.size ?? 0, o.post?.front?.size ?? 0, o.post?.back?.size ?? 0)
}

/** Whether a drill removes the copper of `layer`: `layer` lies between its two ends, both included (`LAYER_RANGE::Contains`). */
const drillCovers = (board: Pick<BoardDef, "stack">, d: Pick<Backdrill, "from" | "to">, layer: CopperLayer): boolean => {
  const all = copperLayers(board)
  const a = all.indexOf(d.from)
  const b = all.indexOf(d.to)
  const l = all.indexOf(layer)
  return a >= 0 && b >= 0 && l >= Math.min(a, b) && l <= Math.max(a, b)
}

const nm = (mm: number) => Math.round(mm * 1e6)

/**
 * The distance KiCad measures between the copper of two layers (`BOARD_STACKUP::GetLayerDistance`, board_stackup.cpp `:916`): the dielectric and copper rows between them,
 * half of each inner copper layer at either end. In millimetres, from nanometres as KiCad adds them (a half is an integer division).
 */
export function layerDistance(board: Pick<BoardDef, "stack" | "thickness">, a: CopperLayer, b: CopperLayer): number {
  if (a === b) return 0
  // B.Cu is always the last copper layer but has not the last number
  let first = a
  let second = b
  if (second !== "bottom" && (kicadId(second) < kicadId(first) || first === "bottom")) [first, second] = [second, first]
  let total = 0
  let start = false
  let half = false
  for (const row of stackupRows(board)) {
    const isCopper = row.type === "copper"
    const isDielectric = row.name.startsWith("dielectric") || row.type === "core" || row.type === "prepreg"
    if (!isCopper && !isDielectric) continue
    const here = isCopper ? row.name : null
    if (!start && here === kicadLayerName(first)) {
      start = true
      if (first !== "top" && first !== "bottom") half = true
    } else if (!start) continue
    if (start && here === kicadLayerName(second) && second !== "top" && second !== "bottom") half = true
    for (const t of [row.thickness ?? (isCopper ? COPPER_DEFAULT : 0), ...(row.sub ?? []).map((q) => q.thickness ?? 0)]) total += half ? Math.trunc(nm(t) / 2) : nm(t)
    half = false
    if (here === kicadLayerName(second)) break
  }
  return total / 1e6
}

/**
 * The diameter of the hole a counterbore or countersink at the `end` of a via or pad leaves in the copper of `layer` (`PCB_VIA::GetPostMachiningKnockout`, pcb_track.cpp `:1121`, and
 * `PAD::GetPostMachiningKnockout`, pad.cpp `:956`, the same rule): a hole of its size for a counterbore, a cone for a countersink, down to its depth, which a countersink with no depth takes from its
 * size and angle. 0 where it reaches no further. The front is measured from `F.Cu`, the back from `B.Cu`.
 */
export function postKnockout(board: Pick<BoardDef, "stack" | "thickness">, post: { front?: PostMachining; back?: PostMachining } | undefined, layer: CopperLayer): number {
  if (!post) return 0
  for (const [pm, from] of [[post.front, "top"], [post.back, "bottom"]] as const) {
    if (!pm || !(pm.size && pm.size > 0)) continue
    const half = ((pm.angle ?? 0) / 2) * (Math.PI / 180)
    let depth = pm.depth ?? 0
    if (!(depth > 0) && pm.mode === "countersink" && (pm.angle ?? 0) > 0) depth = Math.trunc(nm(pm.size) / 2 / Math.tan(half)) / 1e6
    if (!(depth > 0)) continue
    const dist = layerDistance(board, from, layer)
    if (!(dist < depth)) continue
    if (pm.mode === "countersink" && (pm.angle ?? 0) > 0) return Math.max(0, pm.size - Math.trunc(2 * nm(dist) * Math.tan(half)) / 1e6)
    return pm.size
  }
  return 0
}

/** Whether the copper of `layer` is cut round the hole of a via or pad: a backdrill (or tertiary drill) runs through it, or a post-machining reaches it (`IsBackdrilledOrPostMachined`). */
function isBackdrilledOrPostMachined(board: Pick<BoardDef, "stack" | "thickness">, o: { backdrill?: Backdrill; tertiary?: Backdrill; post?: { front?: PostMachining; back?: PostMachining } }, layer: CopperLayer): boolean {
  for (const d of [o.backdrill, o.tertiary]) if (d && d.size > 0 && drillCovers(board, d, layer)) return true
  return postKnockout(board, o.post, layer) > 0
}

// ---------- pads ----------

/** A pad's backdrills and post-machining as they are on the board: layers by the board's own ids, sides by the board's front and back. */
export interface PadMachining {
  ref: string
  /** The number the pad has in the part. */
  pad: string
  x: number
  y: number
  drill: number
  backdrill?: { size: number; from: CopperLayer; to: CopperLayer }
  tertiary?: { size: number; from: CopperLayer; to: CopperLayer }
  front?: PostMachining
  back?: PostMachining
}

/** Every pad of a part on the board that has a backdrill or a post-machining, in the board's frame (a part on the bottom has its layers and sides turned over). */
export function padMachining(project: Project): PadMachining[] {
  const out: PadMachining[] = []
  const count = copperLayers(project.board).length
  for (const c of resolvedComponents(project)) {
    if (!onBoard(c) || !c.pcb.placed) continue
    const fp = componentFootprint(c)
    if (!fp || !fp.pads.some((p) => p.backdrill || p.tertiary || p.post)) continue
    const bottom = c.pcb.side === "bottom"
    const world = pcbPads(c, count)
    const turn = (l: CopperLayer) => (bottom ? flipLayer(l, count) : l)
    fp.pads.forEach((pad, i) => {
      if (!pad.backdrill && !pad.tertiary && !pad.post) return
      const w = world[i]
      const at = w.hole ?? w
      out.push({
        ref: c.ref,
        pad: w.padNumber ?? w.pin ?? "",
        x: at.x,
        y: at.y,
        drill: pad.holeDiameter ?? 0,
        ...(pad.backdrill ? { backdrill: { size: pad.backdrill.size, from: turn(pad.backdrill.from), to: turn(pad.backdrill.to) } } : {}),
        ...(pad.tertiary ? { tertiary: { size: pad.tertiary.size, from: turn(pad.tertiary.from), to: turn(pad.tertiary.to) } } : {}),
        ...(pad.post?.front ? { [bottom ? "back" : "front"]: pad.post.front } : {}),
        ...(pad.post?.back ? { [bottom ? "front" : "back"]: pad.post.back } : {}),
      })
    })
  }
  return out
}

// ---------- the copper round the hole ----------

/**
 * The layers on which a via's or pad's copper is cut round its hole, each with the size of the hole (`GetMaxHoleSize`): a backdrill runs through the layer, or a counterbore or countersink reaches it.
 * KiCad's pour then keeps away from the item on those layers as from another net's, and out of a hole of that size (`zone_filler.cpp` `:2190`, `:2345` and `:2507`). `o` is as the board has it: layers
 * by the board's ids, `front` the board's front. Undefined when no layer is cut, so the common case costs nothing.
 */
export function holeCuts(
  board: Pick<BoardDef, "stack" | "thickness">,
  o: { drill: number; backdrill?: Backdrill; tertiary?: Backdrill; post?: { front?: PostMachining; back?: PostMachining } },
  layers: readonly CopperLayer[],
): Partial<Record<CopperLayer, number>> | undefined {
  if (!o.backdrill && !o.tertiary && !o.post) return undefined
  let out: Partial<Record<CopperLayer, number>> | undefined
  const size = maxHoleSize(o.drill, o)
  for (const l of layers) {
    if (!isBackdrilledOrPostMachined(board, o, l)) continue
    ;(out ??= {})[l] = size
  }
  return out
}

/** A pad's backdrills and post-machining as the board has them: a part on the bottom has its layers turned over and its front and back swapped. */
export function padInBoardFrame(pad: { backdrill?: Backdrill; tertiary?: Backdrill; post?: { front?: PostMachining; back?: PostMachining } }, bottom: boolean, count: number): { backdrill?: Backdrill; tertiary?: Backdrill; post?: { front?: PostMachining; back?: PostMachining } } {
  if (!bottom) return pad
  const turn = (d: Backdrill | undefined): Backdrill | undefined => (d ? { size: d.size, from: flipLayer(d.from, count), to: flipLayer(d.to, count) } : undefined)
  const post = pad.post ? { ...(pad.post.back ? { front: pad.post.back } : {}), ...(pad.post.front ? { back: pad.post.front } : {}) } : undefined
  return { ...(pad.backdrill ? { backdrill: turn(pad.backdrill) } : {}), ...(pad.tertiary ? { tertiary: turn(pad.tertiary) } : {}), ...(post ? { post } : {}) }
}
