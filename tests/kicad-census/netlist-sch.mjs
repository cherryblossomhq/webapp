// The nets of a KiCad schematic, derived from the raw file by KiCad's own rules, sharing no code
// with `src`: it uses the census's s-expression reader (`sexpr.mjs`) and nothing else. This is the
// oracle the importer's nets are checked against (`tests/kicad-schematic-nets.test.ts` and the
// corpus test), and the board's own nets are its oracle in turn (`boardPadNets`).
//
// The rules (eeschema/connection_graph.cpp, as far as the corpus shows them):
//   - items whose connection points coincide are on one net: wire ends, pins, labels, junctions,
//     sheet pins;
//   - a junction, a label or a sheet pin on the body of a wire joins that wire; a wire end or a pin
//     on the body of a wire joins it only where there is a junction (`opts.bodyConnects` says
//     otherwise, to test that against the boards);
//   - a local label joins the nets of the same name on its own sheet, a global label those of every
//     sheet, a hierarchical label the sheet pin of the same name on the sheet symbol above;
//   - a power symbol's power-input pin, and any power-input pin the symbol does not draw, is on the
//     global net named by the symbol's Value (power symbol) or the pin's name (hidden pin);
//   - a symbol is placed by its turn, then its mirror (SCH_SYMBOL::SetOrientation, the order the
//     parser applies them in).
// Buses are derived only on one sheet, where they join nothing a label does not: a project with buses
// and several sheets reports it (`unsupported`) and its nets are left out.

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { parseSexpr, kid, kids, numAt } from "./sexpr.mjs"

const read = (f) => {
  const buf = readFileSync(f)
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf)
  } catch {
    return buf.toString("latin1")
  }
}
const sch = (text) => parseSexpr(text).find((n) => Array.isArray(n) && n[0] === "kicad_sch")
const prop = (node, name) => kids(node, "property").find((p) => p[1] === name)?.[2]
const flag = (node, name) => {
  if (!Array.isArray(node)) return false
  for (let i = 1; i < node.length; i++) {
    const c = node[i]
    if (c === name) return true
    if (Array.isArray(c) && c[0] === name) return c[1] === undefined || c[1] === "yes"
  }
  return false
}

class UF {
  constructor() {
    this.p = new Map()
  }
  find(a) {
    if (!this.p.has(a)) this.p.set(a, a)
    let r = a
    while (this.p.get(r) !== r) r = this.p.get(r)
    while (a !== r) {
      const n = this.p.get(a)
      this.p.set(a, r)
      a = n
    }
    return r
  }
  union(a, b) {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.p.set(ra, rb)
  }
}

/** KiCad's TRANSFORM, as the parser builds it: the lib point (px, py) goes to (x1 px + y1 py, x2 px + y2 py). */
function orientation(angle, mirror) {
  let m = { x1: 1, y1: 0, x2: 0, y2: -1 }
  const mul = (t) => {
    // newTransform = old * temp, as SCH_SYMBOL::SetOrientation writes it out.
    m = {
      x1: m.x1 * t.x1 + m.x2 * t.y1,
      y1: m.y1 * t.x1 + m.y2 * t.y1,
      x2: m.x1 * t.x2 + m.x2 * t.y2,
      y2: m.y1 * t.x2 + m.y2 * t.y2,
    }
  }
  const ccw = { x1: 0, y1: 1, x2: -1, y2: 0 }
  const turns = (((Math.round(angle / 90) % 4) + 4) % 4)
  for (let i = 0; i < turns; i++) mul(ccw)
  if (mirror === "x") mul({ x1: 1, y1: 0, x2: 0, y2: -1 })
  if (mirror === "y") mul({ x1: -1, y1: 0, x2: 0, y2: 1 })
  return m
}

const unit = (v) => Math.round(v * 10000)
const keyOf = (x, y) => `${unit(x)},${unit(y)}`

/**
 * The pad numbers of one drawn pin, as KiCad's `ExpandStackedPinNotation` (common/string_utils.cpp) reads
 * them: [1,2,3], [1-5], [6,7,9-11], [A1-A4]; a backslash escapes a bracket, comma, dash or backslash;
 * a notation it cannot read is the one pin with that text for a number.
 */
function padNumbers(raw) {
  const BS = String.fromCharCode(92)
  const special = (c) => "[],-".includes(c) || c === BS
  const esc = (t, i) => t[i] === BS && i + 1 < t.length && special(t[i + 1])
  const open = raw.includes("[")
  const close = raw.includes("]")
  if (!raw.startsWith("[") || !raw.endsWith("]")) return [raw]
  void open
  void close
  const items = []
  let cur = ""
  const inner = raw.slice(1, -1)
  for (let i = 0; i < inner.length; i++) {
    if (esc(inner, i)) {
      cur += inner[i] + inner[i + 1]
      i++
    } else if (inner[i] === ",") {
      items.push(cur)
      cur = ""
    } else cur += inner[i]
  }
  items.push(cur)
  const unesc = (t) => {
    let o = ""
    for (let i = 0; i < t.length; i++) o += esc(t, i) ? t[++i] : t[i]
    return o
  }
  const alnum = (pin) => {
    let numStart = pin.length
    for (let i = pin.length - 1; i >= 0; i--) {
      if (!(pin[i] >= "0" && pin[i] <= "9")) {
        numStart = i + 1
        break
      }
      if (i === 0) numStart = 0
    }
    return numStart < pin.length ? [pin.slice(0, numStart), Number(pin.slice(numStart))] : ["", -1]
  }
  const out = []
  for (let part of items) {
    part = part.trim()
    if (part === "") continue
    let dash = -1
    for (let i = 0; i < part.length; i++) {
      if (esc(part, i)) i++
      else if (part[i] === "-") {
        dash = i
        break
      }
    }
    if (dash < 0) {
      out.push(unesc(part))
      continue
    }
    const [sp, sv] = alnum(unesc(part.slice(0, dash)).trim())
    const [ep, ev] = alnum(unesc(part.slice(dash + 1)).trim())
    if (sp !== ep || sv === -1 || ev === -1 || sv > ev || out.length + (ev - sv + 1) > 10000) return [raw]
    for (let n = sv; n <= ev; n++) out.push(sp + n)
  }
  return out.length ? out : [raw]
}

/** A unit as a reference writes it: 1 is A. */
const unitLetter = (n) => {
  let out = ""
  for (let k = Math.max(1, n); k > 0; k = Math.floor((k - 1) / 26)) out = String.fromCharCode(65 + ((k - 1) % 26)) + out
  return out
}

/** Name of the net a text names, as KiCad compares it: `{slash}` is `/`. */
const decode = (s) => s.replace(/\{slash\}/g, "/")

/**
 * The classes a label names by its fields called Netclass (KiCad 9 and 10 read the names Netclass and Net Class; a development build also reads the
 * translations of Net Class, which a file written by a program in another language has: the French one is in the corpus).
 */
const NETCLASS_NAMES = new Set(["Netclass", "Net Class", "Classe d'Equipot"])
const netclassFields = (node) => [...new Set(kids(node, "property").filter((p) => NETCLASS_NAMES.has(p[1]) && typeof p[2] === "string" && p[2] !== "").map((p) => p[2]))]

/**
 * Derives the nets of a project. `readFile(path)` gives a file's text or null.
 * Returns `{ pins: Map<"<board path>#<pin number>", group>, names: Map<group, Set<name>>, unsupported: Set<string> }`.
 */
export function deriveNets(rootFile, opts = {}) {
  const o = { bodyConnects: "junction", powerNameFrom: "value", hiddenPower: true, localJoinsGlobal: "same", ...opts }
  const out = { pins: new Map(), names: new Map(), unsupported: new Set(), symbols: 0, pinsTotal: 0, instances: 0 }
  const rootText = read(rootFile)
  const root = sch(rootText)
  if (!root) throw new Error("no kicad_sch")
  const uf = new UF()
  // KiCad 6's root list: the unit, value and footprint of each use of a symbol, by the path a board writes it.
  const rootList = new Map()
  for (const p of kids(kid(root, "symbol_instances") ?? [], "path")) rootList.set(p[1], { unit: numAt(kid(p, "unit"), 1, 0), value: kid(p, "value")?.[1], reference: kid(p, "reference")?.[1] })
  const rootUuid = kid(root, "uuid")?.[1]
  const nameJoin = [] // [item, nameNode]
  let sawBuses = false
  const pinItems = [] // { item, key, pin, name }
  const ncFlags = []
  /** Every pin that is a driver of its net: for the names KiCad gives a net after a pin (`Net-(R1-Pad2)`). */
  const pinDrivers = []
  const labelItems = []
  const ncPinItems = new Set()
  // S8: what the net classes are worked out from: every directive label and every label with a net class field, the rule areas, and where each wire, pin and label is.
  const classSources = []
  const ruleAreas = []
  const geo = { wires: [], pins: [], labels: [] }

  const sheetNames = new Map([["", ""]]) // the instance path -> the sheets' names from the root, as KiCad writes them in a net name
  const walk = (file, chain, ancestors, parentSheet) => {
    const s = file === rootFile ? root : sch(read(file))
    const version = numAt(kid(s, "version"), 1, 0)
    const tilde = (v) => (v === "~" && version <= 20250317 ? "" : v)
    out.instances++
    const inst = chain.join("/")
    const sheetPath = chain.length ? `/${chain.join("/")}` : ""
    const uuidRoot = kid(root, "uuid")?.[1]
    if (kids(s, "bus").length || kids(s, "bus_entry").length) sawBuses = true
    const lib = new Map()
    for (const ls of kids(kid(s, "lib_symbols") ?? [], "symbol")) lib.set(ls[1], ls)
    const points = new Map() // key -> [items]
    const wires = []
    const add = (x, y, item) => {
      const k = keyOf(x, y)
      if (!points.has(k)) points.set(k, [])
      points.get(k).push(item)
    }
    let n = 0
    const id = (kind) => `${inst}|${kind}${n++}`
    const bodyItems = [] // items that may sit on a wire body: { x, y, item, kind }
    const allPins = new Set() // the point of every pin, of every electrical type

    for (const w of kids(s, "wire")) {
      const pts = kids(kid(w, "pts"), "xy")
      if (pts.length < 2) continue
      const item = id("wire")
      uf.find(item)
      const a = { x: numAt(pts[0], 1), y: numAt(pts[0], 2) }
      const b = { x: numAt(pts[1], 1), y: numAt(pts[1], 2) }
      wires.push({ item, a, b })
      geo.wires.push({ inst, item, a, b, width: numAt(kid(kid(w, "stroke"), "width"), 1, 0) })
      add(a.x, a.y, item)
      add(b.x, b.y, item)
      bodyItems.push({ x: a.x, y: a.y, item, kind: "wireEnd", wire: item })
      bodyItems.push({ x: b.x, y: b.y, item, kind: "wireEnd", wire: item })
    }
    const junctions = []
    for (const j of kids(s, "junction")) {
      const at = kid(j, "at")
      const item = id("junction")
      uf.find(item)
      junctions.push({ x: numAt(at, 1), y: numAt(at, 2), item })
      add(numAt(at, 1), numAt(at, 2), item)
      bodyItems.push({ x: numAt(at, 1), y: numAt(at, 2), item, kind: "junction" })
    }
    const labelNames = []
    for (const kind of ["label", "global_label", "hierarchical_label"]) {
      for (const l of kids(s, kind)) {
        const at = kid(l, "at")
        const item = id(kind)
        uf.find(item)
        add(numAt(at, 1), numAt(at, 2), item)
        bodyItems.push({ x: numAt(at, 1), y: numAt(at, 2), item, kind: "label", plain: true })
        labelNames.push({ item, kind, text: decode(l[1]) })
        labelItems.push(item)
        geo.labels.push({ inst, item, x: numAt(at, 1), y: numAt(at, 2) })
        const own = netclassFields(l)
        if (own.length) classSources.push({ inst, item, classes: own, own: true })
      }
    }
    for (const kind of ["netclass_flag", "directive_label"]) {
      for (const l of kids(s, kind)) {
        const at = kid(l, "at")
        const item = id(kind)
        uf.find(item)
        add(numAt(at, 1), numAt(at, 2), item)
        bodyItems.push({ x: numAt(at, 1), y: numAt(at, 2), item, kind: "label" })
        classSources.push({ inst, item, x: numAt(at, 1), y: numAt(at, 2), classes: netclassFields(l), own: false })
      }
    }
    for (const ra of kids(s, "rule_area")) ruleAreas.push({ inst, pts: kids(kid(kid(ra, "polyline"), "pts"), "xy").map((p) => [numAt(p, 1), numAt(p, 2)]) })
    // sheet pins of the sheets drawn on this sheet
    const children = []
    for (const sh of kids(s, "sheet")) {
      const file2 = prop(sh, "Sheetfile") ?? prop(sh, "Sheet file") ?? prop(sh, "File")
      const uuid = kid(sh, "uuid")?.[1]
      const pins = []
      for (const p of kids(sh, "pin")) {
        const at = kid(p, "at")
        const item = id("sheetpin")
        uf.find(item)
        add(numAt(at, 1), numAt(at, 2), item)
        bodyItems.push({ x: numAt(at, 1), y: numAt(at, 2), item, kind: "label" })
        pins.push({ item, name: decode(p[1]) })
      }
      children.push({ file: file2, uuid, pins, name: prop(sh, "Sheetname") ?? prop(sh, "Sheet name") ?? "" })
    }
    const noConnects = kids(s, "no_connect").map((c) => keyOf(numAt(kid(c, "at"), 1), numAt(kid(c, "at"), 2)))
    const ncSet = new Set(noConnects)
    ncFlags.push(...noConnects.map((k) => ({ key: k, inst })))
    void ncSet

    for (const sym of kids(s, "symbol")) {
      const libId = kid(sym, "lib_name")?.[1] ?? kid(sym, "lib_id")?.[1]
      const ls = lib.get(libId)
      if (!ls) continue
      out.symbols++
      const at = kid(sym, "at")
      const x0 = numAt(at, 1)
      const y0 = numAt(at, 2)
      const mirror = kid(sym, "mirror")?.[1] ?? ""
      const m = orientation(numAt(at, 3), mirror)
      // The unit is the use's (connection_graph.cpp: SetUnit( GetUnitSelection( &sheet ) )): the symbol's own list of instances, or the root list of KiCad 6, before its header.
      const symUuid0 = kid(sym, "uuid")?.[1]
      const instPath = `/${[rootUuid, ...chain].join("/")}`
      let own
      for (const project of kids(kid(sym, "instances") ?? [], "project")) for (const p of kids(project, "path")) if (p[1] === instPath) own = { unit: numAt(kid(p, "unit"), 1, 0), value: kid(p, "value")?.[1], reference: kid(p, "reference")?.[1] }
      const listed = rootList.get(`${sheetPath}/${symUuid0}`)
      const use = own ?? listed
      const u = use && use.unit > 0 ? use.unit : numAt(kid(sym, "unit"), 1, 1)
      const bs = numAt(kid(sym, "body_style") ?? kid(sym, "convert"), 1, 1)
      const isPower = !!kid(ls, "power")
      const value = (use?.value ? use.value : prop(sym, "Value")) ?? ""
      // Before 20230221 a global power symbol whose first pin is a hidden power input is named by that pin (FixLegacyPowerSymbolMismatches, sch_screen.cpp).
      const firstPin = kids(kids(ls, "symbol").find((x) => kids(x, "pin").length) ?? [], "pin")[0]
      const legacyName = numAt(kid(root, "version"), 1, 0) < 20230221 && isPower && kid(ls, "power")?.[1] !== "local" && firstPin && firstPin[1] === "power_in" && flag(firstPin, "hide") ? tilde(kid(firstPin, "name")?.[1] ?? "") : null
      const symUuid = kid(sym, "uuid")?.[1]
      const boardPath = `${sheetPath}/${symUuid}`
      const reference = (use?.reference ? use.reference : prop(sym, "Reference")) ?? ""
      const unitCount = Math.max(1, ...kids(ls, "symbol").map((x) => Number(/_(\d+)_\d+$/.exec(x[1])?.[1] ?? 0)))
      const onBoard = !(kid(sym, "on_board") && !flag(sym, "on_board"))
      const refField = prop(ls, "Reference") ?? ""
      /** The pins this symbol draws in the unit and body style it is placed as. */
      const unitPins = []
      for (const sub of kids(ls, "symbol")) {
        const mm = /_(\d+)_(\d+)$/.exec(sub[1])
        const su = mm ? Number(mm[1]) : 0
        const ss = mm ? Number(mm[2]) : 0
        if (!(su === 0 || su === u) || !(ss === 0 || ss === bs)) continue
        for (const pin of kids(sub, "pin")) unitPins.push({ name: tilde(kid(pin, "name")?.[1] ?? ""), number: tilde(kid(pin, "number")?.[1] ?? ""), nc: pin[1] === "unconnected" || pin[1] === "no_connect" })
      }
      for (const sub of kids(ls, "symbol")) {
        const mm = /_(\d+)_(\d+)$/.exec(sub[1])
        const su = mm ? Number(mm[1]) : 0
        const ss = mm ? Number(mm[2]) : 0
        if (!(su === 0 || su === u) || !(ss === 0 || ss === bs)) continue
        for (const pin of kids(sub, "pin")) {
          const pat = kid(pin, "at")
          const px = numAt(pat, 1)
          const py = numAt(pat, 2)
          const wx = x0 + m.x1 * px + m.y1 * py
          const wy = y0 + m.x2 * px + m.y2 * py
          const number = tilde(kid(pin, "number")?.[1] ?? "")
          const name = tilde(kid(pin, "name")?.[1] ?? "")
          const etype = pin[1] === "unconnected" ? "no_connect" : pin[1]
          const item = id("pin")
          uf.find(item)
          allPins.add(keyOf(wx, wy))
          // A pin of the electrical type "no connect" is on no net, whatever is drawn to it.
          if (etype !== "no_connect") {
            add(wx, wy, item)
            bodyItems.push({ x: wx, y: wy, item, kind: "pin" })
            geo.pins.push({ inst, item, x: wx, y: wy })
          }
          out.pinsTotal++
          for (const n of padNumbers(number)) pinItems.push({ item, key: `${boardPath}#${n}`, pin: n })
          pinDrivers.push({ item, ref: reference, refUnit: `${reference}${unitCount > 1 ? unitLetter(u) : ""}`, name, number, unitPins, nc: etype === "no_connect", eligible: onBoard && !refField.startsWith("#") && !(etype === "power_in" && isPower) && !reference.startsWith("#"), flagKey: keyOf(wx, wy), flagInst: inst })
          const hidden = flag(pin, "hide")
          const powerIn = etype === "power_in"
          if (powerIn && isPower) {
            // from 20230221 the Value is the net, and an empty one stays empty (sch_pin.cpp GetDefaultNetName)
            const net = legacyName !== null ? legacyName : tilde(value)
            // a local power pin's net is per sheet, and prefixed with the sheet path (sch_connection.cpp prepend_path = IsLocalPower)
            const localPower = kid(ls, "power")?.[1] === "local"
            if (net !== "") nameJoin.push([item, localPower ? `local:${inst}:${net}` : `global:${net}`, localPower ? 5 : 6])
          } else if (powerIn && hidden && o.hiddenPower) {
            nameJoin.push([item, `global:${name}`, 6])
          }
        }
      }
    }

    // items on the same point
    for (const items of points.values()) for (let i = 1; i < items.length; i++) uf.union(items[0], items[i])
    // items on the body of a wire
    const onBody = (w, x, y) => {
      const { a, b } = w
      const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x)
      if (Math.abs(cross) > 1e-6 * Math.max(1, Math.hypot(b.x - a.x, b.y - a.y))) return false
      const dot = (x - a.x) * (b.x - a.x) + (y - a.y) * (b.y - a.y)
      const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2
      if (len2 === 0) return false
      const t = dot / len2
      return t > 1e-9 && t < 1 - 1e-9
    }
    const junctionKeys = new Set(junctions.map((j) => keyOf(j.x, j.y)))
    // A label with a pin or a no-connect flag at its point is attached to that and skips a wire merely passing there (sch_label.cpp, ConnectionPropagatesTo scan).
    const pinPoints = new Set(allPins)
    for (const k of noConnects) pinPoints.add(k)
    for (const w of wires) {
      for (const it of bodyItems) {
        if (it.wire === w.item) continue
        if (it.kind === "label" && it.plain && pinPoints.has(keyOf(it.x, it.y))) continue
        if (!onBody(w, it.x, it.y)) continue
        const j = junctionKeys.has(keyOf(it.x, it.y))
        const ok =
          it.kind === "junction" || it.kind === "label"
            ? true
            : o.bodyConnects === "always"
              ? true
              : o.bodyConnects === "never"
                ? false
                : j
        if (ok) uf.union(w.item, it.item)
      }
    }
    // names
    for (const l of labelNames) {
      if (l.kind === "global_label") nameJoin.push([l.item, `global:${l.text}`, 7])
      else nameJoin.push([l.item, `local:${inst}:${l.text}`, l.kind === "hierarchical_label" ? 3 : 4])
    }
    // hierarchy
    for (const c of children) {
      if (!c.file) continue
      const child = join(dirname(file), c.file)
      if (!existsSync(child) || ancestors.includes(child)) continue
      const childInst = [...chain, c.uuid].join("/")
      sheetNames.set(childInst, `${sheetNames.get(inst) ?? ""}/${c.name}`)
      for (const p of c.pins) nameJoin.push([p.item, `local:${childInst}:${p.name}`, 2])
      walk(child, [...chain, c.uuid], [...ancestors, file], s)
    }
    void parentSheet
    void noConnects
    void uuidRoot
  }
  walk(rootFile, [], [], null)
  // On one sheet a bus joins nothing a label does not (a wire at a bus entry is named by its own label); between sheets it joins the members of a bus by name, which is not derived.
  if (sawBuses && out.instances > 1) out.unsupported.add("buses across sheets")
  // a local label joins the global net of the same name (option)
  if (o.localJoinsGlobal !== "none") {
    const globals = new Map() // name -> set of instances it appears on (null for "anywhere")
    for (const [item, nm] of nameJoin) if (nm.startsWith("global:")) {
      const t = nm.slice(7)
      if (!globals.has(t)) globals.set(t, new Set())
      globals.get(t).add(item.split("|")[0])
    }
    for (const [item, nm] of [...nameJoin]) {
      const m = /^local:([^:]*):(.*)$/s.exec(nm)
      if (!m || !globals.has(m[2])) continue
      if (o.localJoinsGlobal === "any" || globals.get(m[2]).has(m[1])) nameJoin.push([item, `global:${m[2]}`])
    }
  }
  // the name items
  const nameItem = (n) => `name|${n}`
  for (const [item, name] of nameJoin) uf.union(item, nameItem(name))
  // groups
  const groupId = new Map()
  const names = new Map()
  const gid = (root) => {
    if (!groupId.has(root)) groupId.set(root, groupId.size + 1)
    return groupId.get(root)
  }
  for (const p of pinItems) {
    const g = gid(uf.find(p.item))
    out.pins.set(p.key, out.pins.has(p.key) && out.pins.get(p.key) !== g ? [].concat(out.pins.get(p.key), g) : g)
  }
  // The driver of a group, as ResolveDrivers (connection_graph.cpp) picks it: the highest priority (sheet pin 2, hierarchical label 3,
  // local label 4, local power pin 5, global power pin 6, global label 7), a name with "-Pad" in it last, then the name that sorts first;
  // across sheets also by strength and path length, below.
  const driver = new Map()
  for (const [item, name, prio] of nameJoin) {
    const g = groupId.get(uf.find(item))
    if (g === undefined) continue
    if (!names.has(g)) names.set(g, new Set())
    const bare = name.replace(/^(global|local):(?:[^:]*:)?/, "")
    names.get(g).add(bare)
    if (prio === undefined) continue
    const low = bare.includes("-Pad")
    // Across the sheets of one net (connection_graph.cpp, the chain of subgraphs): a strong driver (hierarchical label and above) beats a weak
    // one (a sheet pin), then the higher priority, then the shorter sheet path, then the name that sorts first.
    const depth = (item.split("|")[0] || "").split("/").filter(Boolean).length
    const strong = prio >= 3
    const best = driver.get(g)
    const better = (a, b) => (a.strong !== b.strong ? a.strong : a.prio !== b.prio ? a.prio > b.prio : a.depth !== b.depth ? a.depth < b.depth : a.low !== b.low ? !a.low : a.full < b.full)
    // KiCad compares the names as they are written, with the sheet path of a name that is not global
    const isGlobal = name.startsWith("global:")
    const full = isGlobal ? bare : `${sheetNames.get(item.split("|")[0]) ?? ""}/${bare}`
    const cand = { name: bare, full, prio, low, depth, strong }
    if (!best || better(cand, best)) driver.set(g, cand)
  }
  out.names = names
  out.driver = driver
  // The names KiCad gives a net after its pins (SCH_PIN::GetDefaultNetName, KiCad 7 on; 6 writes every one as -PadN), for a net no label or power symbol names.
  const rule6 = numAt(kid(root, "version"), 1, 0) <= 20211123
  const driverCount = new Map()
  const bump = (item) => {
    const g = groupId.get(uf.find(item))
    if (g !== undefined) driverCount.set(g, (driverCount.get(g) ?? 0) + 1)
  }
  for (const pd of pinDrivers) if (!pd.nc) bump(pd.item)
  for (const item of labelItems) bump(item)
  const ncGroups = new Set()
  for (const pd of pinDrivers) if (ncFlags.some((f) => f.key === pd.flagKey && f.inst === pd.flagInst)) ncGroups.add(groupId.get(uf.find(pd.item)))
  const pinNames = new Map()
  const byGroup = new Map()
  for (const pd of pinDrivers) {
    const g = groupId.get(uf.find(pd.item))
    if (g === undefined) continue
    ;(byGroup.get(g) ?? byGroup.set(g, []).get(g)).push(pd)
  }
  for (const [g, list] of byGroup) {
    if (driver.get(g)) continue
    const unconnected = (driverCount.get(g) ?? 0) === 1 || ncGroups.has(g) || list.some((pd) => pd.nc)
    const cands = []
    for (const pd of list) {
      if (!pd.eligible) continue
      const shown = pd.name === "~" ? "" : pd.name
      // A stacked pin ([6,7,9-11]) is one pin, named after its smallest pad (KiCad 10: conn_pin_name.cpp, padNumber).
      const smallest = (n) => padNumbers(n).sort((a, b) => (Number.isNaN(Number(a)) || Number.isNaN(Number(b)) ? (a < b ? -1 : 1) : Number(a) - Number(b)))[0]
      const pad = smallest(pd.number)
      const start = unconnected ? "unconnected-(" : "Net-("
      let name
      if (rule6 || shown === "" || shown === pd.number) name = `${start}${pd.ref}-Pad${pad})`
      else {
        const dup = pd.unitPins.some((q) => (q.name === "~" ? "" : q.name) === shown && smallest(q.number) !== pad && !q.nc)
        name = `${start}${pd.refUnit}-${shown.replace(/\//g, "{slash}")}${unconnected || dup ? `-Pad${pad}` : ""})`
      }
      cands.push(name)
    }
    cands.sort((a, b) => Number(a.includes("-Pad")) - Number(b.includes("-Pad")) || (a < b ? -1 : a > b ? 1 : 0))
    if (cands.length) pinNames.set(g, decode(cands[0]))
  }
  /** The name KiCad gives each net, as the board writes it with its escapes read: a driver's (a global one as written, a local one with its sheet's path), else a pin's. */
  out.netName = (g) => {
    const d = driver.get(g)
    if (d) return d.full
    return pinNames.get(g) ?? null
  }
  out.groupOf = (key) => out.pins.get(key)
  out.netClasses = netClassesOf()
  return out

  /**
   * S8: the classes each net is in, by the net's name, for the nets that have a pin. KiCad's rule (`CONNECTION_GRAPH::GetNetclassesForDriver`,
   * connection_graph.cpp): every item of a net can name a class by a field called Netclass, and the net is in all of them; and a directive label on the
   * edge of a rule area gives its classes to the wires, labels and pins inside the area (the wires by the segment of their width, the others by their point).
   */
  function netClassesOf() {
    const result = new Map()
    const claim = (item, cls) => {
      const g = groupId.get(uf.find(item))
      if (g === undefined) return
      const name = out.netName(g)
      if (name === null) return
      if (!result.has(name)) result.set(name, new Set())
      result.get(name).add(cls)
    }
    for (const s of classSources) for (const cls of s.classes) claim(s.item, cls)
    const inside = (pts, x, y) => {
      // On the edge counts as inside.
      let inn = false
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i]
        const [xj, yj] = pts[j]
        const cross = (xj - xi) * (y - yi) - (yj - yi) * (x - xi)
        const within = Math.min(xi, xj) - 1e-9 <= x && x <= Math.max(xi, xj) + 1e-9 && Math.min(yi, yj) - 1e-9 <= y && y <= Math.max(yi, yj) + 1e-9
        if (Math.abs(cross) < 1e-9 && within) return true
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inn = !inn
      }
      return inn
    }
    const distToSeg = (px, py, ax, ay, bx, by) => {
      const dx = bx - ax
      const dy = by - ay
      const len2 = dx * dx + dy * dy
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
      return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
    }
    const segSeg = (a, b, c, d) => {
      const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
      const o1 = o(a, b, c)
      const o2 = o(a, b, d)
      const o3 = o(c, d, a)
      const o4 = o(c, d, b)
      return o1 * o2 < 0 && o3 * o4 < 0
    }
    for (const area of ruleAreas) {
      const edge = (x, y) => area.pts.some((p, i) => distToSeg(x, y, p[0], p[1], area.pts[(i + 1) % area.pts.length][0], area.pts[(i + 1) % area.pts.length][1]) <= 5e-6)
      const classes = [...new Set(classSources.filter((s) => !s.own && s.inst === area.inst && edge(s.x, s.y)).flatMap((s) => s.classes))]
      if (!classes.length) continue
      for (const w of geo.wires.filter((w) => w.inst === area.inst)) {
        const half = (w.width > 0 ? w.width : 0.1524) / 2
        const a = [w.a.x, w.a.y]
        const b = [w.b.x, w.b.y]
        const hit = inside(area.pts, a[0], a[1]) || inside(area.pts, b[0], b[1]) || area.pts.some((p, i) => {
          const q = area.pts[(i + 1) % area.pts.length]
          return segSeg(a, b, p, q) || distToSeg(p[0], p[1], a[0], a[1], b[0], b[1]) < half || distToSeg(q[0], q[1], a[0], a[1], b[0], b[1]) < half
        })
        if (hit) for (const cls of classes) claim(w.item, cls)
      }
      for (const l of geo.labels.filter((l) => l.inst === area.inst)) if (inside(area.pts, l.x, l.y)) for (const cls of classes) claim(l.item, cls)
      for (const p of geo.pins.filter((p) => p.inst === area.inst)) if (inside(area.pts, p.x, p.y)) for (const cls of classes) claim(p.item, cls)
    }
    return result
  }
}

/** The footprints of a board with each pad's net, from the raw file. */
export function boardPadNets(boardFile) {
  const board = sch0(read(boardFile))
  const fps = []
  for (const fp of board) {
    if (!Array.isArray(fp) || (fp[0] !== "footprint" && fp[0] !== "module")) continue
    const refNode = kids(fp, "fp_text").find((t) => t[1] === "reference") ?? kids(fp, "property").find((t) => t[1] === "Reference")
    const pads = kids(fp, "pad").map((p) => {
      const net = kid(p, "net")
      // `(net 12 "GND")` before stamp 20251028, `(net "GND")` from it
      const name = net ? (net.length > 2 ? net[2] : net[1]) : null
      return { number: String(p[1] ?? ""), type: p[2], net: name && name !== "" ? name : null }
    })
    fps.push({ ref: refNode?.[2] ?? "", path: kid(fp, "path")?.[1] ?? "", pads })
  }
  return fps
}
function sch0(text) {
  const t = parseSexpr(text).find((n) => Array.isArray(n) && n[0] === "kicad_pcb")
  return t ?? []
}
