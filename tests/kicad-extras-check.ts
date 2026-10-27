import { componentFootprint } from "../src/model/instances"
import { copperLayers } from "../src/model/stack"
import type { CopperLayer, Project } from "../src/model/types"
import { extrasOracle } from "./kicad-census/extras.mjs"

// X21 and X22 of a built project against the oracle's reading of the raw file (`tests/kicad-census/extras.mjs`, which shares no code with `src`): every via's protection, backdrills and
// post-machining, the board's own protection, every pad's backdrills, post-machining and length inside its package (a part on the bottom has its layers and sides turned over), every
// generated item (kind, name, layer, lock, the tracks and vias it holds, every property), and the net chains.

export interface ExtrasCheck {
  /** The file has something of X21 or X22. */
  uses: boolean
  vias: number
  generators: number
  wrong: string[]
}

const near = (a: number, b: number) => Math.abs(a - b) < 2e-6

/** KiCad's flip of a copper layer by its place (`FlipLayer`): the outer layers swap, the inner ones swap end for end on a board of four or more. */
const flip = (index: number, count: number) => (index === 0 ? count - 1 : index === count - 1 ? 0 : count < 4 ? index : count - 1 - index)

export function checkExtras(text: string, project: Project, lossy: string[] = []): ExtrasCheck {
  const o = extrasOracle(text)
  const out: ExtrasCheck = { uses: false, vias: 0, generators: 0, wrong: [] }
  if (!o) return out
  const protectedVia = (v: (typeof o.vias)[number]) => [v.cap, v.fill, v.coverFront, v.coverBack, v.plugFront, v.plugBack].some((x) => x !== null)
  out.vias = o.vias.filter((v) => protectedVia(v) || v.backdrill || v.tertiary || v.front || v.back).length
  out.generators = o.generated.length
  out.uses = out.vias > 0 || o.pads.length > 0 || o.generated.length > 0 || o.chains.length > 0 || Object.values(o.board).some(Boolean)
  if (lossy.length) return out
  const wrong = out.wrong
  const layers = copperLayers(project.board)
  const names = o.copper
  const nameOf = (l: CopperLayer) => names[layers.indexOf(l)]
  const indexOfName = (n: string) => names.indexOf(n)

  // the board's own protection
  const rule = project.rules.viaProtect
  const have = { cap: rule?.cap === true, fill: rule?.fill === true, coverFront: rule?.cover?.front === true, coverBack: rule?.cover?.back === true, plugFront: rule?.plug?.front === true, plugBack: rule?.plug?.back === true }
  for (const k of Object.keys(have) as (keyof typeof have)[]) if (have[k] !== o.board[k]) wrong.push(`the board's ${k} is ${have[k]}, the file has ${o.board[k]}`)

  // vias, in the file's order
  if (project.vias.length !== o.vias.length) wrong.push(`${project.vias.length} vias, the file has ${o.vias.length}`)
  else {
    o.vias.forEach((f, i) => {
      const v = project.vias[i]
      const want = (x: boolean | null) => (x === null ? undefined : x)
      const got = {
        cap: v.protect?.cap,
        fill: v.protect?.fill,
        coverFront: v.protect?.cover?.front,
        coverBack: v.protect?.cover?.back,
        plugFront: v.protect?.plug?.front,
        plugBack: v.protect?.plug?.back,
      }
      for (const k of Object.keys(got) as (keyof typeof got)[]) if (got[k] !== want(f[k])) wrong.push(`via ${i}: ${k} is ${got[k]}, the file has ${want(f[k])}`)
      for (const [key, d] of [["backdrill", f.backdrill], ["tertiary", f.tertiary]] as const) {
        const m = v[key]
        if (!d) {
          if (m) wrong.push(`via ${i} has a ${key} the file does not`)
        } else if (!m) {
          if (indexOfName(d.start) >= 0 && indexOfName(d.end) >= 0) wrong.push(`via ${i}: the file's ${key} (${d.start} to ${d.end}) is not in the project`)
        } else if (!near(m.size, d.size) || nameOf(m.from) !== d.start || nameOf(m.to) !== d.end) wrong.push(`via ${i}: ${key} is ${m.size} ${nameOf(m.from)} to ${nameOf(m.to)}, the file has ${d.size} ${d.start} to ${d.end}`)
      }
      for (const [side, d] of [["front", f.front], ["back", f.back]] as const) {
        const m = v.post?.[side]
        if (!d) {
          if (m) wrong.push(`via ${i} has a ${side} post-machining the file does not`)
        } else if (!m || m.mode !== d.mode || !near(m.size ?? 0, d.size ?? 0) || !near(m.depth ?? 0, d.depth ?? 0) || Math.abs((m.angle ?? 0) - Math.round((d.angle ?? 0) * 10) / 10) > 1e-9) wrong.push(`via ${i}: ${side} post-machining differs (${JSON.stringify(m)} against ${JSON.stringify(d)})`)
      }
    })
  }

  // pads, by their part's reference and place in the footprint
  const parts = new Map(project.components.map((c) => [c.ref, c]))
  const seen = new Set<string>()
  // a footprint with no reference (or an empty or repeated one) is renamed by the importer, so it cannot be found by its reference
  const named = new Set(o.refs.filter((r, i) => r !== "" && o.refs.indexOf(r) === i && o.refs.lastIndexOf(r) === i))
  for (const f of o.pads) {
    if (!named.has(f.ref)) continue
    const c = parts.get(f.ref)
    const land = c ? componentFootprint(c) : null
    const pad = land?.pads[f.index]
    if (!c || !pad) {
      wrong.push(`pad ${f.index} of ${f.ref} has a machining or a length in the file and is not in the project`)
      continue
    }
    seen.add(`${f.ref}#${f.index}`)
    const bottom = c.pcb.side === "bottom"
    // in the land, a part on the bottom has the file's layers turned over and the file's front and back swapped
    const layerOf = (n: string): CopperLayer | null => {
      const i = indexOfName(n)
      return i < 0 ? null : layers[bottom ? flip(i, layers.length) : i]
    }
    for (const [key, d] of [["backdrill", f.backdrill], ["tertiary", f.tertiary]] as const) {
      const m = pad[key]
      if (!d) {
        if (m) wrong.push(`pad ${f.index} of ${f.ref} has a ${key} the file does not`)
        continue
      }
      const a = layerOf(d.start)
      const b = layerOf(d.end)
      if (!a || !b) continue
      if (!m || !near(m.size, d.size) || m.from !== a || m.to !== b) wrong.push(`pad ${f.index} of ${f.ref}: ${key} is ${JSON.stringify(m)}, the file has ${d.size} ${d.start} to ${d.end}`)
    }
    for (const [side, d] of [["front", f.front], ["back", f.back]] as const) {
      const own = bottom ? (side === "front" ? "back" : "front") : side
      const m = pad.post?.[own]
      if (!d) {
        if (m) wrong.push(`pad ${f.index} of ${f.ref} has a ${own} post-machining the file's ${side} does not`)
      } else if (!m || m.mode !== d.mode || !near(m.size ?? 0, d.size ?? 0) || !near(m.depth ?? 0, d.depth ?? 0)) wrong.push(`pad ${f.index} of ${f.ref}: post-machining differs (${JSON.stringify(m)} against ${JSON.stringify(d)})`)
    }
    if (!near(pad.dieLength ?? 0, f.die)) wrong.push(`pad ${f.index} of ${f.ref}: package length ${pad.dieLength ?? 0}, the file has ${f.die}`)
    if (!near(pad.dieDelay ?? 0, f.delay)) wrong.push(`pad ${f.index} of ${f.ref}: package delay ${pad.dieDelay ?? 0}, the file has ${f.delay}`)
  }
  // no pad of the project has any of it where the file has none
  for (const c of project.components) {
    if (!named.has(c.ref)) continue
    const land = componentFootprint(c)
    land?.pads.forEach((pad, i) => {
      if ((pad.backdrill || pad.tertiary || pad.post || pad.dieLength !== undefined || pad.dieDelay !== undefined) && !seen.has(`${c.ref}#${i}`)) wrong.push(`pad ${i} of ${c.ref} has a machining or a length the file does not`)
    })
  }

  // generated items: the project holds them in the file's order after the plain groups
  const groups = (project.groups ?? []).filter((g) => g.gen)
  const live = o.generated.filter((g) => !((g.type === "tuning_pattern" || g.type === "via_stack") && g.members === 0))
  if (groups.length !== live.length) wrong.push(`${groups.length} generated items, the file has ${live.length}`)
  else {
    const traces = new Map(project.traces.map((t) => [t.id, t]))
    live.forEach((f, i) => {
      const g = groups[i]
      const gen = g.gen!
      if (gen.kind !== f.type) wrong.push(`generated item ${i}: kind ${gen.kind}, the file has ${f.type}`)
      if (g.name !== f.name) wrong.push(`generated item ${i}: name ${JSON.stringify(g.name)}, the file has ${JSON.stringify(f.name)}`)
      if ((g.locked === true) !== f.locked) wrong.push(`generated item ${i}: locked ${g.locked === true}, the file has ${f.locked}`)
      if (nameOf(gen.layer) !== f.layer) wrong.push(`generated item ${i}: layer ${nameOf(gen.layer)}, the file has ${f.layer}`)
      // the tracks it holds: every segment of the file's list is a piece of a polyline of the group (an arc is one track)
      let pieces = 0
      let vias = 0
      for (const m of g.members) {
        const t = traces.get(m)
        if (t) pieces += t.arc ? 1 : Math.max(0, t.points.length - 1)
        else if (project.vias.some((v) => v.id === m)) vias++
      }
      if (f.trackMembers && pieces !== f.trackMembers) wrong.push(`generated item ${i}: holds ${pieces} track pieces, the file lists ${f.trackMembers}`)
      if (f.viaMembers && vias !== f.viaMembers) wrong.push(`generated item ${i}: holds ${vias} vias, the file lists ${f.viaMembers}`)
      // every property by name, a number to the file's own digits
      const keys = Object.keys(gen.props).sort()
      const missing = f.keys.filter((k) => !keys.includes(k))
      if (missing.length) wrong.push(`generated item ${i}: properties ${missing.join(", ")} are missing`)
      for (const k of keys) {
        const raw = f.props[k]
        const v = gen.props[k]
        if (typeof v === "number" && !near(v, Number(raw))) wrong.push(`generated item ${i}: ${k} is ${v}, the file has ${String(raw)}`)
        if (typeof v === "boolean" && (raw === "yes") !== v) wrong.push(`generated item ${i}: ${k} is ${v}, the file has ${String(raw)}`)
      }
    })
  }

  // net chains
  const chains = project.netChains ?? []
  if (chains.length !== o.chains.length) wrong.push(`${chains.length} net chains, the file has ${o.chains.length}`)
  else o.chains.forEach((c, i) => c.name !== chains[i].name && wrong.push(`net chain ${i} is named ${chains[i].name}, the file has ${c.name}`))
  return out
}
