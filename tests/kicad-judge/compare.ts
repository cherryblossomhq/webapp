import { parseSexpr, type SNode } from "../../src/model/kicad/sexpr"
import type { Judged } from "./cli"
import { matchPrims, mergeLines, parseDrill, parseGerber } from "./gerber"

// The comparisons of the KiCad-judged audit: what KiCad says of the original files against what it says of the files the editor wrote. A difference is
// `{ kind, detail }`; the kinds are the rows of the table. Names and order are normalised only where KiCad itself treats them as equal.

export interface Diff {
  kind: string
  detail: string
}

const r3 = (n: number) => Math.round(n * 1000) / 1000

// ---------- position file ----------

function csvRows(text: string): string[][] {
  const rows: string[][] = []
  for (const line of text.replace(/\r/g, "").split("\n")) {
    if (!line.trim()) continue
    const cells: string[] = []
    let cur = ""
    let q = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (q) {
        if (c === '"' && line[i + 1] === '"') {
          cur += '"'
          i++
        } else if (c === '"') q = false
        else cur += c
      } else if (c === '"') q = true
      else if (c === ",") {
        cells.push(cur)
        cur = ""
      } else cur += c
    }
    cells.push(cur)
    rows.push(cells)
  }
  return rows
}

export function comparePos(a: string, b: string): Diff[] {
  // a footprint with no name has the reference `REF**`, and several can: they are told apart by their place
  const read = (t: string) => {
    const rows = csvRows(t).slice(1)
    const seen = new Map<string, number>()
    for (const r of rows) seen.set(r[0], (seen.get(r[0]) ?? 0) + 1)
    return new Map(rows.map((r) => [(seen.get(r[0]) ?? 1) > 1 ? `${r[0]}@${Math.round(Number(r[3]))},${Math.round(Number(r[4]))}` : r[0], r] as const))
  }
  const A = read(a)
  const B = read(b)
  const out: Diff[] = []
  for (const [ref, r] of A) {
    const s = B.get(ref)
    if (!s) {
      out.push({ kind: "position file: part missing", detail: ref })
      continue
    }
    if (r[1] !== s[1]) out.push({ kind: "position file: value", detail: `${ref} ${r[1]} / ${s[1]}` })
    if (r[2] !== s[2]) out.push({ kind: "position file: footprint name", detail: `${ref} ${r[2]} / ${s[2]}` })
    const dx = Math.abs(Number(r[3]) - Number(s[3]))
    const dy = Math.abs(Number(r[4]) - Number(s[4]))
    if (dx > 0.001 || dy > 0.001) out.push({ kind: "position file: place", detail: `${ref} ${r[3]},${r[4]} / ${s[3]},${s[4]}` })
    const dd = (((Number(r[5]) - Number(s[5])) % 360) + 360) % 360
    if (Math.min(dd, 360 - dd) > 0.01) out.push({ kind: "position file: turn", detail: `${ref} ${r[5]} / ${s[5]}` })
    if (r[6] !== s[6]) out.push({ kind: "position file: side", detail: `${ref} ${r[6]} / ${s[6]}` })
  }
  for (const ref of B.keys()) if (!A.has(ref)) out.push({ kind: "position file: part added", detail: ref })
  return out
}

// ---------- IPC-D-356 (every pad's and via's net) ----------

interface IpcRec {
  net: string
  ref: string
  pin: string
  spec: string
}

function ipcRecords(text: string): IpcRec[] {
  const out: IpcRec[] = []
  for (const line of text.replace(/\r/g, "").split("\n")) {
    const m = /^(317|367|327)(.*?)\s+(\S+)\s+(?:(-?\S+)\s+)?(M?D\d{4}\S*)/.exec(line)
    if (m) out.push({ net: m[2].trim(), ref: m[3], pin: m[4] ?? "", spec: m[5] })
  }
  return out
}

/** Nets as the pads they join: names do not matter, who is joined to whom does. A pad on no net (`N/C`) is alone. */
function netGroups(recs: IpcRec[]) {
  const groups = new Map<string, string[]>()
  let alone = 0
  for (const r of recs) {
    if (r.ref === "VIA") continue
    const key = r.net === "N/C" ? `alone-${alone++}` : r.net
    ;(groups.get(key) ?? groups.set(key, []).get(key)!).push(`${r.ref}.${r.pin}`)
  }
  // a net of one pad is no net: KiCad names such a pad's net `unconnected-(R1-Pad2)`, and a pad with none is the same
  const out = new Map<string, string[]>()
  for (const [name, pins] of groups) out.set(pins.length === 1 ? `alone-${alone++}` : name, pins)
  return out
}

export function compareIpc(a: string, b: string): Diff[] {
  const RA = ipcRecords(a)
  const RB = ipcRecords(b)
  const out: Diff[] = []
  const GA = netGroups(RA)
  const GB = netGroups(RB)
  const sig = (g: Map<string, string[]>) => new Map([...g].map(([name, pins]) => [pins.sort().join(" "), name] as const))
  const SA = sig(GA)
  const SB = sig(GB)
  let moved = 0
  const examples: string[] = []
  for (const [pins, name] of SA) {
    if (/^alone-/.test(name)) continue
    if (!SB.has(pins)) {
      moved++
      if (examples.length < 3) examples.push(`${name}: ${pins.slice(0, 80)}`)
    }
  }
  if (moved) out.push({ kind: "board nets: pads joined differently", detail: `${moved} nets of the original have different pads in the export, e.g. ${examples.join(" ; ")}` })
  // a pad that has a net in one and none in the other
  const netOf = (g: Map<string, string[]>) => {
    const m = new Map<string, string>()
    for (const [name, pins] of g) for (const p of pins) m.set(p, /^alone-/.test(name) ? "" : name)
    return m
  }
  const NA = netOf(GA)
  const NB = netOf(GB)
  // a pad alone on its net: the name KiCad gave it (`unconnected-(R1-Pad2)`) is kept or it is not
  const lone = (recs: IpcRec[]) => {
    const names = new Map<string, string>()
    const count = new Map<string, number>()
    for (const r of recs) if (r.ref !== "VIA" && r.net !== "N/C") count.set(r.net, (count.get(r.net) ?? 0) + 1)
    for (const r of recs) if (r.ref !== "VIA" && r.net !== "N/C" && count.get(r.net) === 1) names.set(`${r.ref}.${r.pin}`, r.net)
    return names
  }
  const LA = lone(RA)
  const LB = lone(RB)
  let loneLost = 0
  // (IPC-D-356 writes a name of 14 characters at most: one that would be another's is cut shorter and given `#1`, so the same name reads differently when the set of lone nets differs)
  const abbreviated = (name: string | undefined) => (name ?? "").replace(/#\d+$/, "").slice(-8)
  for (const [pad, name] of LA) if (abbreviated(LB.get(pad)) !== abbreviated(name) && NB.has(pad)) loneLost++
  if (loneLost) out.push({ kind: "board nets: a lone pad's net name", detail: `${loneLost} of ${LA.size} pads alone on a net lost the name KiCad gave it` })
  let lost = 0
  let gained = 0
  let missingPads = 0
  for (const [p, n] of NA) {
    const o = NB.get(p)
    if (o === undefined) missingPads++
    else if (n && !o) lost++
    else if (!n && o) gained++
  }
  if (missingPads) out.push({ kind: "board nets: pad missing", detail: `${missingPads} pads` })
  if (lost) out.push({ kind: "board nets: pad lost its net", detail: `${lost} pads` })
  if (gained) out.push({ kind: "board nets: pad gained a net", detail: `${gained} pads` })
  // names: same pads, different name
  let renamed = 0
  const renamedExamples: string[] = []
  for (const [pins, name] of SA) {
    const o = SB.get(pins)
    if (o !== undefined && o !== name && !/^alone-/.test(name)) {
      renamed++
      if (renamedExamples.length < 3) renamedExamples.push(`${name} / ${o}`)
    }
  }
  if (renamed) out.push({ kind: "board nets: net name", detail: `${renamed} nets, e.g. ${renamedExamples.join(" ; ")}` })
  // vias: the same count, and every via at the same place with the same drill (its net is the net of the pads of the same name; a net with no pad is compared by place only)
  const vias = (recs: IpcRec[]) => recs.filter((r) => r.ref === "VIA").map((r) => r.spec.replace(/R\d+S\d/, "")).sort()
  const va = vias(RA)
  const vb = vias(RB)
  if (va.join() !== vb.join()) {
    // a place is a number of tenths of a mil: one more or less is the same place (a rounding of the millimetre)
    const split = (k: string) => {
      const m = /^(.*?)X([+-]\d+)Y([+-]\d+)(.*)$/.exec(k)
      return m ? { head: m[1], x: Number(m[2]), y: Number(m[3]), tail: m[4] } : { head: k, x: 0, y: 0, tail: "" }
    }
    const left = vb.map(split)
    let off = 0
    for (const k of va) {
      const a = split(k)
      const i = left.findIndex((b) => b.head === a.head && b.tail === a.tail && Math.abs(b.x - a.x) <= 1 && Math.abs(b.y - a.y) <= 1)
      if (i >= 0) left.splice(i, 1)
      else off++
    }
    if (off || va.length !== vb.length) out.push({ kind: "board nets: via count or place", detail: `${va.length} / ${vb.length} vias, ${off} of the original's without a twin` })
  }
  const netOfVia = (recs: IpcRec[], names: Map<string, string>) => recs.filter((r) => r.ref === "VIA" && names.has(r.net)).map((r) => `${names.get(r.net)}|${r.spec.replace(/R\d+S\d/, "")}`).sort()
  const byName = (s: Map<string, string>) => new Map([...s].map(([pins, name]) => [name, pins] as const))
  const na = netOfVia(RA, byName(SA))
  const nb = netOfVia(RB, byName(SB))
  const bag2 = new Map<string, number>()
  for (const k of nb) bag2.set(k, (bag2.get(k) ?? 0) + 1)
  let wrongNet = 0
  for (const k of na) {
    const n = bag2.get(k) ?? 0
    if (n) bag2.set(k, n - 1)
    else wrongNet++
  }
  if (wrongNet && va.join() === vb.join()) out.push({ kind: "board nets: via on another net", detail: `${wrongNet} of ${na.length} vias` })
  return out
}

// ---------- gerbers and drill ----------

const isCopper = (fn: string) => /^Copper/.test(fn)
const family = (layer: string, fn: string) => (isCopper(fn) ? "copper" : /Mask/.test(layer) ? "mask" : /Paste/.test(layer) ? "paste" : /Silk/.test(layer) ? "silkscreen" : /Edge/.test(layer) ? "board edge" : /Fab/.test(layer) ? "fab" : /Court/.test(layer) ? "courtyard" : "user layer")

/** KiCad 5's names of the fixed layers and KiCad 6 and later's are the same layers (`B.SilkS` and `B.Silkscreen`). */
const LAYER_SYNONYMS: [RegExp, string][] = [
  [/^([FB])_SilkS$/, "$1_Silkscreen"],
  [/^([FB])_Adhes$/, "$1_Adhesive"],
  [/^([FB])_CrtYd$/, "$1_Courtyard"],
  [/^Dwgs_User$/, "User_Drawings"],
  [/^Cmts_User$/, "User_Comments"],
  [/^Eco1_User$/, "User_Eco1"],
  [/^Eco2_User$/, "User_Eco2"],
]
const layerKey = (name: string) => LAYER_SYNONYMS.reduce((n, [re, to]) => n.replace(re, to), name)

export function compareGerbers(a: Record<string, string>, b: Record<string, string>): Diff[] {
  const out: Diff[] = []
  const plots = (g: Record<string, string>) => {
    const m = new Map<string, ReturnType<typeof parseGerber>>()
    const names = Object.keys(g).filter((n) => !/gbrjob$/i.test(n))
    // the project's name is the common start of every file name; the rest is the layer's name
    let stem = names[0] ?? ""
    for (const n of names) while (!n.startsWith(stem)) stem = stem.slice(0, -1)
    stem = stem.slice(0, stem.lastIndexOf("-") + 1)
    for (const name of names) m.set(layerKey(name.slice(stem.length).replace(/\.[^.]+$/, "")), parseGerber(g[name]))
    return m
  }
  const A = plots(a)
  const B = plots(b)
  for (const [fn, pa] of A) {
    const pb = B.get(fn)
    const layer = fn.replace(/,(Top|Bot|Inr|Inner)\b.*$/, "")
    if (!pb) {
      if (pa.prims.length) out.push({ kind: "gerber: layer missing", detail: fn })
      continue
    }
    const nonRegion = (p: typeof pa) => mergeLines(p.prims.filter((x) => !x.sig.startsWith("R|")))
    const m = matchPrims(nonRegion(pa), nonRegion(pb))
    // the same drawing with another aperture (a line of another width, a pad of another shape) is told apart from a missing one
    const ap = (s: string) => s.split("|")[1]
    const same = (x: { sig: string }) => `${x.sig.split("|")[0]}|${x.sig.split("|")[2]}`
    const changed: string[] = []
    const stillB = [...m.onlyB]
    const stillA: typeof m.onlyA = []
    for (const p of m.onlyA) {
      const i = stillB.findIndex((q) => same(q) === same(p) && q.nums.length === p.nums.length && q.nums.every((n, k) => Math.abs(n - p.nums[k]) <= 0.0025))
      if (i >= 0) {
        changed.push(`${ap(p.sig)} -> ${ap(stillB[i].sig)}`)
        stillB.splice(i, 1)
      } else stillA.push(p)
    }
    if (changed.length) {
      const by = new Map<string, number>()
      for (const k of changed) by.set(k, (by.get(k) ?? 0) + 1)
      out.push({ kind: `gerber ${family(fn, pa.fn)}: same drawing, other aperture`, detail: `${fn}: ${[...by].slice(0, 4).map(([k, n]) => `${n}x ${k}`).join("; ")}` })
    }
    m.onlyA = stillA
    m.onlyB = stillB
    const pre = (s: string) => s.split("|")[0]
    const kindOf = (list: { sig: string }[]) => {
      const c: Record<string, number> = {}
      for (const p of list) c[pre(p.sig)] = (c[pre(p.sig)] ?? 0) + 1
      return Object.entries(c).map(([k, v]) => `${k}${v}`).join(" ")
    }
    if (m.onlyA.length || m.onlyB.length) {
      const ex = (l: { sig: string; nums: number[] }[]) => (l[0] ? `${l[0].sig.slice(0, 60)} @ ${l[0].nums.map(r3).join(",")}` : "")
      out.push({ kind: `gerber ${family(fn, pa.fn)}: drawn items differ`, detail: `${fn}: ${m.onlyA.length} only in the original (${kindOf(m.onlyA)}), ${m.onlyB.length} only in the export (${kindOf(m.onlyB)}); e.g. ${ex(m.onlyA)} | ${ex(m.onlyB)}` })
    }
    // regions (pours, filled shapes): the count and total area; zone fills may be re-made, so copper areas have a tolerance
    const tol = isCopper(pa.fn) ? 0.02 : 0.002
    const base = Math.max(Math.abs(pa.regionArea), 1)
    if (pa.regions !== pb.regions || Math.abs(pa.regionArea - pb.regionArea) / base > tol) {
      out.push({ kind: `gerber ${family(fn, pa.fn)}: filled areas differ`, detail: `${fn}: ${pa.regions} regions ${r3(pa.regionArea)} mm2 / ${pb.regions} regions ${r3(pb.regionArea)} mm2 (${r3(((pb.regionArea - pa.regionArea) / base) * 100)}%)` })
    }
    void layer
  }
  for (const [fn, pb] of B) if (!A.has(fn) && pb.prims.length) out.push({ kind: "gerber: layer added", detail: fn })
  return out
}

export function compareDrills(a: Record<string, string>, b: Record<string, string>): Diff[] {
  const out: Diff[] = []
  const all = (d: Record<string, string>) => Object.values(d).map(parseDrill)
  // pair by function; KiCad names a plated file by its layer span
  const A = all(a)
  const B = all(b)
  const key = (f: string) => f
  const mb = new Map(B.map((d) => [key(d.fn), d] as const))
  for (const da of A) {
    const db = mb.get(key(da.fn))
    if (!db) {
      if (da.holes.length) out.push({ kind: "drill: file missing", detail: da.fn })
      continue
    }
    const m = matchPrims(da.holes, db.holes)
    if (m.onlyA.length || m.onlyB.length) out.push({ kind: "drill: holes differ", detail: `${da.fn}: ${m.onlyA.length} only in the original, ${m.onlyB.length} only in the export; e.g. ${m.onlyA[0] ? `${m.onlyA[0].sig} ${m.onlyA[0].nums.map(r3)}` : ""} | ${m.onlyB[0] ? `${m.onlyB[0].sig} ${m.onlyB[0].nums.map(r3)}` : ""}` })
  }
  for (const db of B) if (!A.some((d) => key(d.fn) === key(db.fn)) && db.holes.length) out.push({ kind: "drill: file added", detail: db.fn })
  return out
}

// ---------- DRC and ERC ----------

interface Violation {
  type: string
  severity: string
  description: string
  items?: { description: string; pos?: { x: number; y: number } }[]
}

function violationKey(v: Violation, withPos: boolean): string {
  const items = (v.items ?? []).map((i) => i.description.replace(/\s+/g, " ")).sort()
  const pos = withPos && v.items?.[0]?.pos ? `@${r3(Math.round(v.items[0].pos.x * 10) / 10)},${r3(Math.round(v.items[0].pos.y * 10) / 10)}` : ""
  return `${v.type}|${v.severity}|${items.join("&")}${pos}`
}

/** A clearance that falls short by no more than 3 micrometres (`required 0.5080 mm; actual 0.5069 mm`) is the rounding of a polygon fill, which KiCad's own refill has as well. */
function marginal(v: Violation): boolean {
  const m = /([\d.]+) mm; actual ([\d.]+) mm/.exec(v.description ?? "")
  return !!m && Number(m[1]) - Number(m[2]) <= 0.003
}

function jsonViolations(text: string, field: "violations" | "unconnected_items" | "schematic_parity"): Violation[] {
  const j = JSON.parse(text) as Record<string, unknown>
  return ((j[field] as Violation[] | undefined) ?? []).map((v) => ({ ...v, type: v.type ?? "?", severity: v.severity ?? "" })).filter((v) => !marginal(v))
}

function ercViolations(text: string): Violation[] {
  const j = JSON.parse(text) as { sheets?: { violations?: Violation[] }[] }
  return (j.sheets ?? []).flatMap((s) => s.violations ?? []).map((v) => ({ ...v, type: v.type ?? "?", severity: v.severity ?? "" }))
}

function violationDiff(label: string, A: Violation[], B: Violation[]): Diff[] {
  const out: Diff[] = []
  const count = (l: Violation[]) => {
    const m = new Map<string, number>()
    for (const v of l) m.set(v.type, (m.get(v.type) ?? 0) + 1)
    return m
  }
  const CA = count(A)
  const CB = count(B)
  for (const t of new Set([...CA.keys(), ...CB.keys()])) {
    const x = CA.get(t) ?? 0
    const y = CB.get(t) ?? 0
    if (x !== y) {
      const bag = new Map<string, number>()
      for (const v of A.filter((v) => v.type === t)) bag.set(violationKey(v, false), (bag.get(violationKey(v, false)) ?? 0) + 1)
      const fresh: string[] = []
      for (const v of B.filter((v) => v.type === t)) {
        const k = violationKey(v, false)
        const n = bag.get(k) ?? 0
        if (n) bag.set(k, n - 1)
        else fresh.push(k)
      }
      out.push({ kind: `${label} ${y > x ? "grew" : "shrank"}: ${t}`, detail: `${x} / ${y}${fresh[0] ? `; new: ${fresh[0].slice(0, 200)}` : ""}` })
    }
  }
  return out
}

export function compareDrc(a: string, b: string, label = "DRC"): Diff[] {
  const out = violationDiff(label, jsonViolations(a, "violations"), jsonViolations(b, "violations"))
  const ua = jsonViolations(a, "unconnected_items").length
  const ub = jsonViolations(b, "unconnected_items").length
  if (ua !== ub) out.push({ kind: `${label} ${ub > ua ? "grew" : "shrank"}: unconnected items`, detail: `${ua} / ${ub}` })
  return out
}

/** What KiCad says the schematic and the board disagree on (missing and extra footprints, nets, fields): the export must not have more of it than the original. */
export function compareParity(a: string, b: string): Diff[] {
  return violationDiff("Update PCB from schematic", jsonViolations(a, "schematic_parity"), jsonViolations(b, "schematic_parity"))
}

export function compareErc(a: string, b: string): Diff[] {
  return violationDiff("ERC", ercViolations(a), ercViolations(b))
}

// ---------- netlist (the schematic's own) ----------

interface Comp {
  ref: string
  value: string
  footprint: string
  fields: Record<string, string>
  props: Record<string, string>
  sheet: string
}

const kids = (n: SNode, head: string): SNode[][] => (Array.isArray(n) ? (n.filter((c) => Array.isArray(c) && c[0] === head) as SNode[][]) : [])
const txt = (n: SNode | undefined, head: string): string => {
  const c = Array.isArray(n) ? (n.find((x) => Array.isArray(x) && x[0] === head) as SNode[] | undefined) : undefined
  return c && typeof c[1] === "string" ? c[1] : ""
}

function readNetlist(text: string) {
  const root = parseSexpr(text)[0] as SNode[]
  const comps = new Map<string, Comp>()
  for (const c of kids(kids(root, "components")[0] ?? [], "comp")) {
    const ref = txt(c, "ref")
    const fields: Record<string, string> = {}
    for (const f of kids(kids(c, "fields")[0] ?? [], "field")) {
      const name = (kids(f, "name")[0]?.[1] as string) ?? ""
      const last = f[f.length - 1]
      fields[name] = typeof last === "string" ? last : ""
    }
    const props: Record<string, string> = {}
    for (const p of kids(c, "property")) props[txt(p, "name")] = txt(p, "value")
    comps.set(ref, { ref, value: txt(c, "value"), footprint: txt(c, "footprint"), fields, props, sheet: txt(kids(c, "sheetpath")[0] ?? [], "names") })
  }
  const nets = new Map<string, string[]>()
  let alone = 0
  for (const n of kids(kids(root, "nets")[0] ?? [], "net")) {
    const name = txt(n, "name")
    const pins = kids(n, "node").map((x) => `${txt(x, "ref")}.${txt(x, "pin")}`)
    // a net with one node is "unconnected-(...)" in KiCad: its name is made of its pin, so it is alone
    nets.set(/^unconnected-/.test(name) ? `alone-${alone++}` : name, pins.sort())
  }
  return { comps, nets }
}

export function compareNetlist(a: string, b: string): Diff[] {
  const A = readNetlist(a)
  const B = readNetlist(b)
  const out: Diff[] = []
  for (const [ref, c] of A.comps) {
    const d = B.comps.get(ref)
    if (!d) {
      out.push({ kind: "schematic: part missing", detail: ref })
      continue
    }
    if (c.value !== d.value) out.push({ kind: "schematic: value", detail: `${ref} ${c.value} / ${d.value}` })
    if (c.footprint !== d.footprint) out.push({ kind: "schematic: footprint field", detail: `${ref} ${c.footprint} / ${d.footprint}` })
    for (const k of new Set([...Object.keys(c.fields), ...Object.keys(d.fields)])) {
      if (c.fields[k] !== d.fields[k]) out.push({ kind: "schematic: user field", detail: `${ref} ${k}: ${JSON.stringify(c.fields[k])} / ${JSON.stringify(d.fields[k])}` })
    }
    for (const k of new Set([...Object.keys(c.props), ...Object.keys(d.props)])) {
      if (c.props[k] !== d.props[k]) out.push({ kind: `schematic: part flag ${k}`, detail: `${ref} ${JSON.stringify(c.props[k])} / ${JSON.stringify(d.props[k])}` })
    }
    if (c.sheet !== d.sheet) out.push({ kind: "schematic: sheet of a part", detail: `${ref} ${c.sheet} / ${d.sheet}` })
  }
  for (const ref of B.comps.keys()) if (!A.comps.has(ref)) out.push({ kind: "schematic: part added", detail: ref })
  const sig = (m: Map<string, string[]>) => new Map([...m].filter(([n, p]) => p.length > 0 && !/^alone-/.test(n)).map(([n, p]) => [p.join(" "), n] as const))
  const SA = sig(A.nets)
  const SB = sig(B.nets)
  let off = 0
  let renamed = 0
  const ex: string[] = []
  for (const [pins, name] of SA) {
    const o = SB.get(pins)
    if (o === undefined) {
      off++
      if (ex.length < 3) ex.push(`${name}: ${pins.slice(0, 80)}`)
    } else if (o !== name) {
      renamed++
      if (ex.length < 3) ex.push(`${name} / ${o}`)
    }
  }
  if (off) out.push({ kind: "schematic: nets join different pins", detail: `${off} of ${SA.size} nets, e.g. ${ex.join(" ; ")}` })
  if (renamed) out.push({ kind: "schematic: net name", detail: `${renamed} nets, e.g. ${ex.join(" ; ")}` })
  return out
}

export function compareBom(a: string, b: string): Diff[] {
  const norm = (t: string) => csvRows(t).map((r) => r.map((c) => c.trim()).join("|")).sort()
  const A = norm(a)
  const B = norm(b)
  if (A.join("\n") === B.join("\n")) return []
  const bag = new Map<string, number>()
  for (const r of B) bag.set(r, (bag.get(r) ?? 0) + 1)
  const only: string[] = []
  for (const r of A) {
    const n = bag.get(r) ?? 0
    if (n) bag.set(r, n - 1)
    else only.push(r)
  }
  return [{ kind: "BOM: lines differ", detail: `${only.length} of ${A.length} lines; e.g. ${only[0] ?? ""} | ${[...bag].find(([, n]) => n > 0)?.[0] ?? ""}` }]
}

/** Every comparison of what KiCad said of the two sides. */
export function compareJudged(a: Judged, b: Judged): Diff[] {
  const out: Diff[] = []
  const run = (name: string, f: () => Diff[]) => {
    try {
      out.push(...f())
    } catch (e) {
      out.push({ kind: `judge: ${name} could not be compared`, detail: e instanceof Error ? e.message.slice(0, 160) : String(e) })
    }
  }
  if (a.pos && b.pos) run("pos", () => comparePos(a.pos!, b.pos!))
  else if (a.pos || b.pos) out.push({ kind: "judge: position file only on one side", detail: a.pos ? "export failed" : "original failed" })
  if (a.ipc && b.ipc) run("ipc", () => compareIpc(a.ipc!, b.ipc!))
  if (a.gerbers && Object.keys(a.gerbers).length) run("gerbers", () => compareGerbers(a.gerbers, b.gerbers))
  if (Object.keys(a.drills).length || Object.keys(b.drills).length) run("drill", () => compareDrills(a.drills, b.drills))
  if (a.drc && b.drc) run("drc", () => compareDrc(a.drc!, b.drc!, "DRC stored fill"))
  else if (a.drc || b.drc) out.push({ kind: "judge: DRC only on one side", detail: a.drc ? "export failed" : "original failed" })
  if (a.drcRefill && b.drcRefill) run("drc refilled", () => compareDrc(a.drcRefill!, b.drcRefill!, "DRC refilled"))
  if (a.parity && b.parity) run("parity", () => compareParity(a.parity!, b.parity!))
  if (a.netlist && b.netlist) run("netlist", () => compareNetlist(a.netlist!, b.netlist!))
  else if (a.netlist || b.netlist) out.push({ kind: "judge: netlist only on one side", detail: a.netlist ? "export failed" : "original failed" })
  if (a.erc && b.erc) run("erc", () => compareErc(a.erc!, b.erc!))
  if (a.bom && b.bom) run("bom", () => compareBom(a.bom!, b.bom!))
  return out
}
