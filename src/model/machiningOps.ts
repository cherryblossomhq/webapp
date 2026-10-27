import { registerProjectFootprints } from "./footprints"
import { boardProtection } from "./viaCodec"
import type { Backdrill, DesignRules, FootprintDef, PadDef, PostMachining, Project, Via, ViaProtection } from "./types"

// X22 and X21: the edits of a via's protection, backdrills and post-machining, of a pad's, of its length inside the package, and of the board's own protection rule. A `null` clears what a patch names
// (the via then follows the board, the pad has none); anything that is not a usable number changes nothing. The project is returned as it is when nothing changes.

const touch = (p: Project): Project => ({ ...p, updatedAt: Date.now() })

/** One part of a via's protection: true or false to say it, null to follow the board. */
export interface ProtectionPatch {
  cap?: boolean | null
  fill?: boolean | null
  coverFront?: boolean | null
  coverBack?: boolean | null
  plugFront?: boolean | null
  plugBack?: boolean | null
}

export interface MachiningPatch {
  protect?: ProtectionPatch
  backdrill?: Backdrill | null
  tertiary?: Backdrill | null
  post?: { front?: PostMachining | null; back?: PostMachining | null }
}

const usable = (v: number | undefined) => v === undefined || (Number.isFinite(v) && v >= 0)

/** A post-machining with only usable numbers: sizes, depths and angles of zero or more; a zero is left out (KiCad's writer leaves it out and the machine has none). */
function cleanPost(p: PostMachining): PostMachining | null {
  if (p.mode !== "counterbore" && p.mode !== "countersink") return null
  if (!usable(p.size) || !usable(p.depth) || !usable(p.angle)) return null
  return { mode: p.mode, ...(p.size ? { size: p.size } : {}), ...(p.depth ? { depth: p.depth } : {}), ...(p.angle ? { angle: Math.round(p.angle * 10) / 10 } : {}) }
}

const cleanDrill = (d: Backdrill): Backdrill | null => (Number.isFinite(d.size) && d.size > 0 && d.from !== d.to ? { size: d.size, from: d.from, to: d.to } : null)

/** A protection with the patch applied; undefined when it ends up saying nothing. */
export function patchProtection(p: ViaProtection | undefined, patch: ProtectionPatch): ViaProtection | undefined {
  const next: ViaProtection = { ...p, ...(p?.cover ? { cover: { ...p.cover } } : {}), ...(p?.plug ? { plug: { ...p.plug } } : {}) }
  const set = <K extends "cap" | "fill">(k: K, v: boolean | null | undefined) => {
    if (v === undefined) return
    if (v === null) delete next[k]
    else next[k] = v
  }
  set("cap", patch.cap)
  set("fill", patch.fill)
  const side = (k: "cover" | "plug", s: "front" | "back", v: boolean | null | undefined) => {
    if (v === undefined) return
    const cur: { front?: boolean; back?: boolean } = { ...next[k] }
    if (v === null) delete cur[s]
    else cur[s] = v
    if (Object.keys(cur).length) next[k] = cur
    else delete next[k]
  }
  side("cover", "front", patch.coverFront)
  side("cover", "back", patch.coverBack)
  side("plug", "front", patch.plugFront)
  side("plug", "back", patch.plugBack)
  return Object.keys(next).length ? next : undefined
}

/** A via with the patch applied. */
export function patchViaMachining(via: Via, patch: MachiningPatch): Via {
  const next: Record<string, unknown> = { ...via }
  if (patch.protect) {
    const p = patchProtection(via.protect, patch.protect)
    if (p) next.protect = p
    else delete next.protect
  }
  for (const k of ["backdrill", "tertiary"] as const) {
    const v = patch[k]
    if (v === undefined) continue
    const d = v === null ? null : cleanDrill(v)
    if (d) next[k] = d
    else if (v === null) delete next[k]
  }
  if (patch.post) {
    const post: { front?: PostMachining; back?: PostMachining } = { ...via.post }
    for (const s of ["front", "back"] as const) {
      const v = patch.post[s]
      if (v === undefined) continue
      const c = v === null ? null : cleanPost(v)
      if (c) post[s] = c
      else if (v === null) delete post[s]
    }
    if (post.front || post.back) next.post = post
    else delete next.post
  }
  return next as unknown as Via
}

/** The vias by id patched. */
export function updateViaMachining(project: Project, ids: string[], patch: MachiningPatch): Project {
  const set = new Set(ids)
  let changed = false
  const vias = project.vias.map((v) => {
    if (!set.has(v.id)) return v
    const next = patchViaMachining(v, patch)
    if (JSON.stringify(next) === JSON.stringify(v)) return v
    changed = true
    return next
  })
  return changed ? touch({ ...project, vias }) : project
}

/** What a pad can say of X22 and X21 for itself. */
export interface PadMachiningPatch extends Omit<MachiningPatch, "protect"> {
  dieLength?: number | null
  dieDelay?: number | null
}

/** A pad with the patch applied. */
export function patchPadMachining(pad: PadDef, patch: PadMachiningPatch): PadDef {
  const { protect: _p, ...rest } = patch as MachiningPatch & PadMachiningPatch
  const asVia = patchViaMachining({ id: "", x: 0, y: 0, diameter: 0, drill: 0, ...(pad.backdrill ? { backdrill: pad.backdrill } : {}), ...(pad.tertiary ? { tertiary: pad.tertiary } : {}), ...(pad.post ? { post: pad.post } : {}) }, rest)
  const next: Record<string, unknown> = { ...pad }
  for (const k of ["backdrill", "tertiary", "post"] as const) {
    if (asVia[k]) next[k] = asVia[k]
    else delete next[k]
  }
  for (const k of ["dieLength", "dieDelay"] as const) {
    const v = patch[k]
    if (v === undefined) continue
    if (v === null || v === 0) delete next[k]
    else if (Number.isFinite(v) && v > 0) next[k] = v
  }
  return next as unknown as PadDef
}

/** The project's own land's pad at `index` patched; as it is when the land is not the project's, has no such pad, or nothing changes. */
export function updateLandPadMachining(project: Project, land: string, index: number, patch: PadMachiningPatch): Project {
  const def = project.footprints?.find((f) => f.name === land)
  const pad = def?.pads[index]
  if (!def || !pad) return project
  const changed = patchPadMachining(pad, patch)
  if (JSON.stringify(changed) === JSON.stringify(pad)) return project
  const next: FootprintDef = { ...def, pads: def.pads.map((p, i) => (i === index ? changed : p)) }
  registerProjectFootprints({ footprints: [next] })
  return touch({ ...project, footprints: project.footprints!.map((f) => (f.name === land ? next : f)) })
}

/** The board's own protection rule with the patch applied (a part is on or off; off is no setting). */
export function patchProtectRule(rules: DesignRules, patch: ProtectionPatch): DesignRules {
  const asFalse = (v: boolean | null | undefined) => (v === undefined ? undefined : v === true)
  const merged = patchProtection(rules.viaProtect, {
    cap: asFalse(patch.cap),
    fill: asFalse(patch.fill),
    coverFront: asFalse(patch.coverFront),
    coverBack: asFalse(patch.coverBack),
    plugFront: asFalse(patch.plugFront),
    plugBack: asFalse(patch.plugBack),
  })
  const rule = merged ? boardProtection(merged) : undefined
  const { viaProtect: _old, ...rest } = rules
  return rule ? { ...rest, viaProtect: rule } : (rest as DesignRules)
}
