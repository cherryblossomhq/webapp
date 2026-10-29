import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { parseSexpr, type SNode } from "../../src/model/kicad/sexpr"
import { cli } from "./cli"
import type { Diff } from "./compare"

// The board file as KiCad itself reads it: both boards are given to `kicad-cli pcb upgrade --force`, which parses a file completely and writes it again in
// KiCad's own form, so what KiCad understands of the original and of the export is compared in one shape (every KiCad release's spelling of a thing is the same
// afterwards). The two trees are diffed node by node; a difference is the path of the node, with the names of the footprints and pads left out, as the kind.

// (`path`, `sheetname` and `sheetfile` are a footprint's link to its symbol: the judge checks the link with KiCad's own "Update PCB from Schematic", which finds the footprint by it, so the words themselves are not compared.)
const IGNORED = new Set(["uuid", "tstamp", "version", "generator", "generator_version", "id", "path", "sheetname", "sheetfile"])

/** Heads whose items are drawn copper or lines: matched by their place, never by their order. */
const GEOMETRY = new Set(["segment", "arc", "via", "gr_line", "gr_arc", "gr_circle", "gr_rect", "gr_curve", "fp_line", "fp_arc", "fp_circle", "fp_rect", "fp_curve"])
/** A fill is KiCad's own result of a fill, which the editor makes again (the gerbers say how the copper differs). */
const SKIP = /\/filled_polygon$/

const isList = (n: SNode): n is SNode[] => Array.isArray(n)
const head = (n: SNode[]) => (typeof n[0] === "string" ? n[0] : "")
const num = (n: SNode | undefined) => (typeof n === "string" ? Number(n) : NaN)
const child = (n: SNode[], h: string) => n.find((c) => isList(c) && c[0] === h) as SNode[] | undefined
const r3 = (n: number) => String(Math.round(n * 1000) / 1000 + 0)
/** The place of an item to a hundredth of a millimetre: the same item in two files may differ by a micrometre or two (a rounding), which is no difference. */
const r2 = (n: number) => String(Math.round(n * 100) / 100 + 0)
/** Two lists of words are equal when every number is within 2.6 micrometres of the other and every other word is the same. */
function sameWords(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => (/^-?\d+(\.\d+)?$/.test(x) && /^-?\d+(\.\d+)?$/.test(b[i]) ? Math.abs(Number(x) - Number(b[i])) <= 0.0026 : x === b[i]))
}

/** The canonical text of a node: no ids, numbers rounded to 3 decimals (0.001 mm). */
function canon(n: SNode): string {
  if (!isList(n)) {
    const v = /^-?\d+(\.\d+)?(e-?\d+)?$/i.test(n) ? Number(n) : NaN
    return Number.isNaN(v) ? JSON.stringify(n) : r3(v)
  }
  return `(${n.filter((c) => !(isList(c) && IGNORED.has(head(c)))).map(canon).join(" ")})`
}

/** KiCad draws a pad a quarter turn turned the same as the pad with its size turned: the two are made one. An angle is the same modulo a whole turn. */
function canonical(n: SNode): SNode {
  if (!isList(n)) return n
  let out = n.map(canonical)
  if (head(out) === "pad") {
    const shape = out[3]
    const at = child(out, "at")
    const size = child(out, "size")
    if (at && size && (shape === "rect" || shape === "oval" || shape === "roundrect" || shape === "circle")) {
      const full = (((num(at[3]) || 0) % 180) + 180) % 180
      // a quarter turn more with the sides swapped is the same pad: the turn is kept below a quarter
      const turned = full >= 90
      const a = turned ? full - 90 : full
      out = out.map((c) => {
        if (c === at) return a === 0 ? ["at", at[1], at[2]] : ["at", at[1], at[2], String(a)]
        if (c === size && turned) return ["size", size[2], size[1]]
        if (turned && isList(c) && c[0] === "drill" && c[1] === "oval") return ["drill", "oval", c[3], c[2], ...c.slice(4)]
        return c
      })
      // an oval pad of equal sides is a circle
      if (shape === "oval" && Math.abs(num(size[1]) - num(size[2])) < 1e-6) out = out.map((c, i) => (i === 3 ? "circle" : c))
    }
  }
  // a line is the same drawn from either end, an arc likewise, and a circle by any point of it
  if (["segment", "gr_line", "fp_line", "arc", "gr_arc", "fp_arc"].includes(head(out))) {
    const st = child(out, "start")
    const en = child(out, "end")
    if (st && en) {
      const first = [Math.round(num(st[1]) * 100), Math.round(num(st[2]) * 100)]
      const last = [Math.round(num(en[1]) * 100), Math.round(num(en[2]) * 100)]
      if (first[0] > last[0] || (first[0] === last[0] && first[1] > last[1])) out = out.map((c) => (c === st ? ["start", en[1], en[2]] : c === en ? ["end", st[1], st[2]] : c))
    }
  }
  // a stroke of the default type is a solid one
  if (head(out) === "stroke") out = out.filter((c) => !(isList(c) && head(c) === "type" && c[1] === "default")).map((c) => (isList(c) && head(c) === "type" && c[1] === "solid" ? ["type", "solid"] : c))
  if (head(out) === "stroke" && !child(out, "type")) out = [...out, ["type", "solid"]]
  if (head(out) === "gr_circle" || head(out) === "fp_circle") {
    const c = child(out, "center")
    const e = child(out, "end")
    if (c && e) {
      const r = Math.hypot(num(e[1]) - num(c[1]), num(e[2]) - num(c[2]))
      out = out.map((x) => (x === e ? ["end", String(num(c[1]) + r), c[2]] : x))
    }
  }
  // a 3D model is the same file whichever release's variable names the library folder and whichever of its formats is named
  if (head(out) === "model" && typeof out[1] === "string") out = out.map((x, i) => (i === 1 ? String(x).replace(/^\$\{(?:KICAD\d*_3DMODEL_DIR|KISYS3DMOD)\}\//, "").replace(/\.(wrl|step|stp)$/i, "") : x))
  // the user's name of a layer that is KiCad's own name for it says nothing
  if (head(out) === "layers") {
    out = out.map((row) => {
      if (!isList(row) || row.length !== 4) return row
      const std: Record<string, string> = { "F.SilkS": "F.Silkscreen", "B.SilkS": "B.Silkscreen", "F.Adhes": "F.Adhesive", "B.Adhes": "B.Adhesive", "Dwgs.User": "User.Drawings", "Cmts.User": "User.Comments", "Eco1.User": "User.Eco1", "Eco2.User": "User.Eco2", "F.CrtYd": "F.Courtyard", "B.CrtYd": "B.Courtyard", "F.Mask": "F.Mask", "B.Mask": "B.Mask", "F.Paste": "F.Paste", "B.Paste": "B.Paste", "F.Fab": "F.Fab", "B.Fab": "B.Fab", "Edge.Cuts": "Edge.Cuts", Margin: "Margin" }
      return std[row[1] as string] === row[3] ? row.slice(0, 3) : row
    })
  }
  // a net tie's groups are the same with or without a space after the comma
  if (head(out) === "net_tie_pad_groups") out = out.map((c, i) => (i === 0 || isList(c) ? c : String(c).replace(/,\s+/g, ",")))
  // a polygon is the same drawn from any of its corners, either way round, and with any corner on a straight side left out: it is told by its area and its box
  if (["fp_poly", "gr_poly"].includes(head(out))) {
    out = out.map((c) => {
      if (!isList(c) || head(c) !== "pts") return c
      const xy = c.slice(1).filter(isList).map((p) => [num(p[1]), num(p[2])])
      let area = 0
      for (let i = 0; i < xy.length; i++) area += xy[i][0] * xy[(i + 1) % xy.length][1] - xy[(i + 1) % xy.length][0] * xy[i][1]
      const xs = xy.map((p) => p[0])
      const ys = xy.map((p) => p[1])
      return ["pts", ["area", r2(Math.abs(area) / 2)], ["box", r2(Math.min(...xs)), r2(Math.min(...ys)), r2(Math.max(...xs)), r2(Math.max(...ys))]]
    })
  }
  // what a footprint says for all its pads is what each pad says where it does not say its own (KiCad's inheritance), so it is written on each pad
  if (head(out) === "footprint") {
    const inherited = ["clearance", "solder_mask_margin", "solder_paste_margin", "solder_paste_margin_ratio", "zone_connect"]
    const own = out.filter((c) => isList(c) && inherited.includes(head(c))) as SNode[][]
    if (own.length) {
      out = out.filter((c) => !own.includes(c as SNode[])).map((c) => {
        if (!isList(c) || head(c) !== "pad") return c
        const add = own.filter((f) => !child(c, head(f)))
        return add.length ? [...c, ...add] : c
      })
    }
  }
  if (head(out) === "zone") {
    const rule = !!child(out, "keepout")
    // a rule area has no pour: what a pour says is nothing there; a smoothing with no radius smooths nothing; `fill yes` says the zone has a stored fill, which the editor makes again
    out = out.filter((c) => !(rule && isList(c) && ["connect_pads", "min_thickness", "fill", "hatch", "priority"].includes(head(c))))
    out = out.map((c) => {
      if (!isList(c) || head(c) !== "fill") return c
      const hasRadius = (num(child(c, "radius")?.[1]) || 0) > 0
      return c.filter((x) => x !== "yes" && !(isList(x) && (head(x) === "radius" || head(x) === "smoothing") && !hasRadius))
    })
  }
  if (head(out) === "at" && out.length === 4 && !Number.isNaN(num(out[3]))) out = ["at", out[1], out[2], String((((num(out[3]) % 360) + 360) % 360) % 360)]
  return out
}

/** The place of a drawn item, as text: the same copper or line in two files has the same place whatever order the file lists it in. */
function placeKey(h: string, n: SNode[]): string {
  const layer = child(n, "layer")?.slice(1).join(",") ?? ""
  const pt = (name: string) => {
    const c = child(n, name)
    return c ? `${r2(num(c[1]))},${r2(num(c[2]))}` : ""
  }
  if (h === "segment" || h === "gr_line" || h === "fp_line") return `${layer}|${[pt("start"), pt("end")].sort().join("|")}`
  if (h === "via") return `${layer}|${pt("at")}`
  if (h === "arc" || h === "gr_arc" || h === "fp_arc") return `${layer}|${[pt("start"), pt("end")].sort().join("|")}|${pt("mid")}`
  if (h === "gr_circle" || h === "fp_circle") {
    const c = child(n, "center")
    const e = child(n, "end")
    const r = c && e ? Math.hypot(num(e[1]) - num(c[1]), num(e[2]) - num(c[2])) : 0
    return `${layer}|${pt("center")}|${r2(r)}`
  }
  return `${layer}|${canon(n)}`
}

/** The box of a zone's own polygon (its first `polygon`), to the half millimetre: two zones of one net and layer are told apart by where they are. */
function polygonBox(n: SNode[]): string {
  const poly = n.find((c) => isList(c) && c[0] === "polygon") as SNode[] | undefined
  const pts = poly && (child(poly, "pts") as SNode[] | undefined)
  const xy = (pts ?? []).filter((c): c is SNode[] => isList(c) && c[0] === "xy").map((c) => [num(c[1]), num(c[2])])
  if (!xy.length) return ""
  const xs = xy.map((p) => p[0])
  const ys = xy.map((p) => p[1])
  const r = (v: number) => Math.round(v * 2) / 2
  return `${r(Math.min(...xs))},${r(Math.min(...ys))},${r(Math.max(...xs))},${r(Math.max(...ys))}`
}

/** The numbers of a drawn item's places, and its layer: two items are the same place when the layer is and every number is within 2.6 micrometres (a circle by its centre and radius). */
function placeNumbers(h: string, n: SNode[]): number[] {
  const out: number[] = []
  for (const name of ["start", "mid", "end", "at", "center"]) {
    const c = child(n, name)
    if (c) out.push(num(c[1]), num(c[2]))
  }
  if (h === "gr_circle" || h === "fp_circle") {
    const c = child(n, "center")
    const e = child(n, "end")
    return c && e ? [num(c[1]), num(c[2]), Math.hypot(num(e[1]) - num(c[1]), num(e[2]) - num(c[2]))] : out
  }
  return out
}

function near(h: string, x: SNode[], y: SNode[]): boolean {
  if ((child(x, "layer")?.slice(1).join(",") ?? "") !== (child(y, "layer")?.slice(1).join(",") ?? "") && !(h === "via")) return false
  const p = placeNumbers(h, x)
  const q = placeNumbers(h, y)
  if (p.length !== q.length) return false
  if (p.every((v, i) => Math.abs(v - q[i]) <= 0.0026)) return true
  // a line is the same drawn from its other end
  if (p.length === 4 && (h === "segment" || h === "gr_line" || h === "fp_line")) return Math.abs(p[0] - q[2]) <= 0.0026 && Math.abs(p[1] - q[3]) <= 0.0026 && Math.abs(p[2] - q[0]) <= 0.0026 && Math.abs(p[3] - q[1]) <= 0.0026
  return false
}

/** A line is the same drawn from its other end: the second one is turned to run the way the first does before the two are compared. */
function aligned(h: string, x: SNode[], y: SNode[]): SNode[] {
  if (!["segment", "gr_line", "fp_line"].includes(h)) return y
  const xs = child(x, "start")
  const xe = child(x, "end")
  const ys = child(y, "start")
  const ye = child(y, "end")
  if (!xs || !xe || !ys || !ye) return y
  const d = (a: SNode[], b: SNode[]) => Math.hypot(num(a[1]) - num(b[1]), num(a[2]) - num(b[2]))
  if (d(xs, ys) + d(xe, ye) <= d(xs, ye) + d(xe, ys)) return y
  return y.map((c) => (c === ys ? ["start", ye[1], ye[2]] : c === ye ? ["end", ys[1], ys[2]] : c))
}

function keyOf(h: string, n: SNode[]): string | null {
  if (h === "footprint") {
    const r = n.find((c) => isList(c) && c[0] === "property" && c[1] === "Reference")
    return r && isList(r) ? String(r[2]) : null
  }
  if (h === "dimension") {
    const pts = child(n, "pts")
    const xy = pts ? pts.slice(1).filter(isList).map((c) => `${r2(num(c[1]))},${r2(num(c[2]))}`).sort() : []
    return `${child(n, "layer")?.slice(1).join(",") ?? ""}|${xy.join("|")}`
  }
  if (h === "pad" || h === "property" || h === "model") return typeof n[1] === "string" ? n[1] : null
  if (h === "zone") {
    const net = child(n, "net_name") ?? child(n, "net")
    const layer = child(n, "layer") ?? child(n, "layers")
    return `${net ? net[1] : ""}|${layer ? layer.slice(1).join(",") : ""}|${polygonBox(n)}`
  }
  if (GEOMETRY.has(h)) return placeKey(h, n)
  return null
}

type Out = Map<string, { count: number; example: string }>

function diffNodes(a: SNode[], b: SNode[], path: string, out: Out) {
  const add = (kind: string, ex: string) => {
    const e = out.get(kind)
    if (e) e.count++
    else out.set(kind, { count: 1, example: ex.slice(0, 260) })
  }
  const group = (n: SNode[]) => {
    const g = new Map<string, SNode[][]>()
    for (const c of n.slice(1)) if (isList(c) && !IGNORED.has(head(c))) (g.get(head(c)) ?? g.set(head(c), []).get(head(c))!).push(c)
    return g
  }
  const atoms = (n: SNode[]) => n.slice(1).filter((c): c is string => !isList(c))
  if (!sameWords(atoms(a), atoms(b))) add(path, `${atoms(a).join(" ")} / ${atoms(b).join(" ")}`)
  const GA = group(a)
  const GB = group(b)
  for (const h of new Set([...GA.keys(), ...GB.keys()])) {
    const la = GA.get(h) ?? []
    const lb = GB.get(h) ?? []
    const at = `${path}/${h}`
    if (SKIP.test(at)) continue
    if (la.length === 1 && lb.length === 1 && !GEOMETRY.has(h)) {
      diffNodes(la[0], lb[0], at, out)
      continue
    }
    // equal ones cancel (by their canonical text); what is left is matched by key (a footprint by its reference, a pad by its number, an item by its place) and compared inside
    const rest: SNode[][] = []
    const bag = new Map<string, SNode[][]>()
    for (const x of lb) (bag.get(canon(x)) ?? bag.set(canon(x), []).get(canon(x))!).push(x)
    for (const x of la) {
      const l = bag.get(canon(x))
      if (l?.length) l.pop()
      else rest.push(x)
    }
    const restB = [...bag.values()].flat()
    if (!rest.length && !restB.length) continue
    if (GEOMETRY.has(h)) {
      // drawn items are paired by place, within a few micrometres
      const left = [...restB]
      const lost: SNode[][] = []
      for (const x of rest) {
        const i = left.findIndex((y) => near(h, x, y))
        if (i >= 0) diffNodes(x, aligned(h, x, left.splice(i, 1)[0]), at, out)
        else lost.push(x)
      }
      // The outline is the editor's one outline (pieces joined, a footprint's edge lines among them, a circle as two arcs): the judge compares it as KiCad plots it, in the gerber of Edge.Cuts
      const notEdge = (x: SNode[]) => child(x, "layer")?.[1] !== "Edge.Cuts"
      const lostNow = lost.filter(notEdge)
      const leftNow = left.filter(notEdge)
      if (lostNow.length) add(`${at} only in the original`, canon(lostNow[0]))
      if (leftNow.length) add(`${at} only in the export`, canon(leftNow[0]))
      continue
    }
    const byKey = new Map<string, SNode[][]>()
    const loose: SNode[][] = []
    for (const x of restB) {
      const k = keyOf(h, x)
      if (k === null) loose.push(x)
      else (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(x)
    }
    const unmatchedA: SNode[][] = []
    for (const x of rest) {
      const k = keyOf(h, x)
      const l = k === null ? (la.length === lb.length ? loose : []) : byKey.get(k)
      if (l?.length) diffNodes(x, l.shift()!, at, out)
      else unmatchedA.push(x)
    }
    const unmatchedB = [...byKey.values(), loose].flat()
    if (unmatchedA.length) add(`${at} only in the original`, canon(unmatchedA[0]))
    if (unmatchedB.length) add(`${at} only in the export`, canon(unmatchedB[0]))
  }
}

async function upgraded(file: string, work: string, tag: string): Promise<SNode[] | null> {
  mkdirSync(work, { recursive: true })
  const copy = join(work, `${tag}-${basename(file)}`)
  copyFileSync(file, copy)
  const r = await cli(["pcb", "upgrade", "--force", copy])
  if (!r.ok) return null
  return canonical(parseSexpr(readFileSync(copy, "utf8"))[0]) as SNode[]
}

/** The node paths where two boards differ after KiCad has read and written both, as `Diff` lines. */
export async function compareBoardFiles(origPcb: string, outPcb: string, work: string): Promise<Diff[]> {
  const [a, b] = await Promise.all([upgraded(origPcb, work, "a"), upgraded(outPcb, work, "b")])
  if (!a || !b) return [{ kind: "board file: KiCad could not read and rewrite one of the files", detail: a ? "the export" : "the original" }]
  const out: Out = new Map()
  diffNodes(a, b, "board", out)
  // A board saved before KiCad 9 numbers the layers of its plot choice the old way: the export does not carry that choice (the import report says so).
  if (Number(/\(version (\d+)\)/.exec(origPcb)?.[1] ?? 0) < 20241229) for (const k of [...out.keys()]) if (/pcbplotparams\/(layerselection|plot_on_all_layers_selection)$/.test(k)) out.delete(k)
  return [...out].map(([kind, v]) => ({ kind: `board file: ${kind}`, detail: `${v.count}x; e.g. ${v.example}` }))
}

// ---------- the project file ----------

type Json = unknown

function jsonDiff(a: Json, b: Json, path: string, out: Out) {
  const add = (kind: string, ex: string) => {
    const e = out.get(kind)
    if (e) e.count++
    else out.set(kind, { count: 1, example: ex.slice(0, 200) })
  }
  const show = (v: Json) => JSON.stringify(v)?.slice(0, 80) ?? ""
  if (a && b && typeof a === "object" && typeof b === "object") {
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b)) return add(path, `${show(a)} / ${show(b)}`)
      const named = [...a, ...b].every((x) => x && typeof x === "object" && "name" in (x as object))
      if (named) {
        const mb = new Map(b.map((x) => [(x as { name: string }).name, x] as const))
        for (const x of a) {
          const y = mb.get((x as { name: string }).name)
          if (y === undefined) add(`${path}[] only in the original`, show(x))
          else jsonDiff(x, y, `${path}[]`, out)
        }
        for (const [n] of mb) if (!a.some((x) => (x as { name: string }).name === n)) add(`${path}[] only in the export`, n)
        return
      }
      if (a.length !== b.length) add(`${path}[] length`, `${a.length} / ${b.length}`)
      for (let i = 0; i < Math.min(a.length, b.length); i++) jsonDiff(a[i], b[i], `${path}[]`, out)
      return
    }
    const oa = a as Record<string, Json>
    const ob = b as Record<string, Json>
    for (const k of new Set([...Object.keys(oa), ...Object.keys(ob)])) {
      if (!(k in ob)) add(`${path}.${k} only in the original`, show(oa[k]))
      else if (!(k in oa)) add(`${path}.${k} only in the export`, show(ob[k]))
      else jsonDiff(oa[k], ob[k], `${path}.${k}`, out)
    }
    return
  }
  if (a !== b && !(typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-6)) add(path, `${show(a)} / ${show(b)}`)
}

/** The project file's settings: design rules, net classes, severities, text variables, ERC settings. */
export function compareProFiles(origPro: string | null, outPro: string): Diff[] {
  if (!origPro || !existsSync(origPro) || !existsSync(outPro)) return []
  const out: Out = new Map()
  let a: Record<string, Json>
  let b: Record<string, Json>
  try {
    a = JSON.parse(readFileSync(origPro, "utf8"))
    b = JSON.parse(readFileSync(outPro, "utf8"))
  } catch {
    return [{ kind: "project file: unreadable", detail: origPro }]
  }
  for (const k of ["board", "net_settings", "text_variables", "erc", "schematic"]) {
    if (k in a || k in b) jsonDiff(a[k] ?? {}, b[k] ?? {}, k, out)
  }
  return [...out].map(([kind, v]) => ({ kind: `project file: ${kind}`, detail: `${v.count}x; e.g. ${v.example}` }))
}

export async function compareSettings(origPcb: string, outPcb: string, work: string, origPro: string | null, outPro: string): Promise<Diff[]> {
  return [...(await compareBoardFiles(origPcb, outPcb, join(work, "upgraded"))), ...compareProFiles(origPro, outPro)]
}
