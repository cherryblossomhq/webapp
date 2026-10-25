// The nets of a KiCad 5 (legacy) schematic project, derived from the raw files by KiCad 5.1's own
// rules, sharing no code with `src`: it reads the `.sch`, `.lib` and `.pro` text with its own
// small readers below. It is the oracle the importer's nets are checked against for legacy files
// (`tests/kicad-schematic-legacy-corpus.test.ts`), and the board's own nets are its oracle in turn.
//
// The rules (eeschema/netlist_object_list.cpp and netlist_object.cpp of KiCad 5.1):
//   - items whose connection points coincide are on one net, wire ends, pins, labels, junctions,
//     no-connect flags, sheet pins (`pointToPointConnect`);
//   - a junction or a label lying on the body of a wire joins that wire (`segmentToPointConnect`);
//     a wire end or a pin on the body of a wire joins it only through a junction;
//   - a pin of the type power input that is not shown, or any power input pin of a symbol marked
//     as a power symbol, is also a global label named by the pin's name (`LIB_PIN::IsPowerConnection`);
//   - labels of one text on one sheet are one net; a global label joins the global labels of every
//     sheet; a power pin label joins power pin labels everywhere, and a local label on another sheet
//     only picks up power pin labels (`labelConnect`);
//   - a sheet pin joins the hierarchical label of its name on the sheet it stands for;
//   - the net's name: a global label, else a power pin's name, else a hierarchical label, else a
//     local label (shorter sheet path first, then by name), else `Net-(REF-PadN)` of the first pin.
// The symbol is placed by the file's own transform matrix: the library point (px, py) goes to
// (x1 px + y1 py, x2 px + y2 py) from the symbol's place.

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"

const read = (f) => {
  const buf = readFileSync(f)
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf)
  } catch {
    return buf.toString("latin1")
  }
}
const exists = (f) => {
  try {
    readFileSync(f)
    return true
  } catch {
    return false
  }
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

/** KiCad's `ConvertToNewOverbarNotation` (common/string_utils.cpp): the old `~NAME~` is `~{NAME}`, `~~` is a tilde. */
export function newOverbar(old) {
  if (old === "~") return old
  let out = ""
  let inOverbar = false
  for (let i = 0; i < old.length; i++) {
    const ch = old[i]
    if (ch === "~") {
      if (old[i + 1] === "~") {
        if (old[i + 2] === "{") {
          out += "~~{}"
          continue
        }
        out += "~"
        i++
        continue
      }
      if (old[i + 1] === "{") return old
      if (inOverbar) {
        out += "}"
        inOverbar = false
      } else {
        out += "~{"
        inOverbar = true
      }
      continue
    }
    // a space, a closing brace or bracket, and the end of the text close an overbar
    if (inOverbar && (ch === " " || ch === "}" || ch === ")")) {
      out += "}"
      inOverbar = false
    }
    out += ch
  }
  if (inOverbar) out += "}"
  return out
}

const unquote = (s) => s.replace(/\\(["\\])/g, "$1")
const quotedAfter = (line, re) => {
  const m = re.exec(line)
  return m ? unquote(m[1]) : null
}

/** Reads a legacy library: parts by every name they answer to, each with its pins. */
export function readLib(file) {
  const byName = new Map()
  let part = null
  let inDraw = false
  for (const line of read(file).split(/\r?\n/)) {
    if (line.startsWith("DEF ")) {
      const t = line.trim().split(/\s+/)
      // A name that begins with `~` has no value shown: the symbol's name is what follows it.
      const own = t[1].startsWith("~") ? t[1].slice(1) : t[1]
      part = { name: own, power: t[9] === "P", pins: [], aliases: [own] }
      inDraw = false
    } else if (!part) continue
    else if (line.startsWith("ALIAS ")) part.aliases.push(...line.trim().split(/\s+/).slice(1))
    else if (line === "DRAW") inDraw = true
    else if (line === "ENDDRAW") inDraw = false
    else if (line.startsWith("ENDDEF")) {
      for (const a of part.aliases) if (!byName.has(a)) byName.set(a, part)
      part = null
    } else if (inDraw && line.startsWith("X ")) {
      const t = line.trim().split(/\s+/)
      part.pins.push({ name: t[1], number: t[2], x: Number(t[3]), y: Number(t[4]), unit: Number(t[9]), convert: Number(t[10]), type: t[11], hidden: (t[12] ?? "").includes("N") })
    }
  }
  return byName
}

/** The libraries of one project: the cache first, then the `.pro` list. */
function projectLibs(rootFile) {
  const dir = dirname(rootFile)
  const stem = rootFile.slice(dir.length + 1).replace(/\.sch$/i, "")
  const libs = []
  for (const n of [`${stem}-cache.lib`, `${stem}.cache.lib`]) if (exists(join(dir, n))) libs.push({ cache: true, map: readLib(join(dir, n)) })
  const pro = join(dir, `${stem}.pro`)
  if (exists(pro)) {
    const names = []
    let sec = ""
    for (const l of read(pro).split(/\r?\n/)) {
      const h = /^\[(.*)\]/.exec(l)
      if (h) sec = h[1].toLowerCase()
      else if (sec === "eeschema/libraries") {
        const m = /^LibName(\d+)=(.*)$/.exec(l)
        if (m) names[Number(m[1])] = m[2].trim()
      }
    }
    for (const n of names.filter(Boolean)) if (exists(join(dir, `${n}.lib`))) libs.push({ cache: false, name: n, map: readLib(join(dir, `${n}.lib`)) })
  }
  return libs
}

function findPart(libs, libName, version) {
  const colon = version > 3 ? libName.indexOf(":") : -1
  const nick = colon >= 0 ? libName.slice(0, colon) : ""
  const item = colon >= 0 ? libName.slice(colon + 1) : libName
  for (const l of libs) {
    if (!l.cache) continue
    const hit = l.map.get(nick ? `${nick}_${item}` : item) ?? (nick ? l.map.get(`${nick}:${item}`) : undefined)
    if (hit) return hit
  }
  for (const l of libs) {
    if (l.cache) continue
    const hit = l.map.get(item)
    if (hit) return hit
  }
  return null
}

/** One schematic file: its records, from the raw text. */
function readSheet(file) {
  const lines = read(file).split(/\r?\n/)
  const version = Number(/Version (\d+)/i.exec(lines[0])?.[1] ?? 0)
  const out = { version, comps: [], sheets: [], wires: [], buses: 0, junctions: [], noconns: [], labels: [], entries: 0 }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (l.startsWith("$Comp")) {
      const c = { name: "", unit: 1, convert: 1, ts: "", x: 0, y: 0, ar: [], matrix: [1, 0, 0, -1], fields: {} }
      for (i++; i < lines.length && !lines[i].startsWith("$EndComp"); i++) {
        const q = lines[i]
        if (/^L\s/.test(q)) c.name = q.trim().split(/\s+/)[1].replace(/~/g, " ")
        else if (/^U\s/.test(q)) {
          const t = q.trim().split(/\s+/)
          c.unit = Math.max(1, Number(t[1]))
          c.convert = Math.max(1, Number(t[2]))
          c.ts = t[3].toUpperCase().replace(/^0+(?=.)/, "")
        } else if (/^P\s/.test(q)) {
          const t = q.trim().split(/\s+/)
          c.x = Number(t[1])
          c.y = Number(t[2])
        } else if (/^AR\s/.test(q)) c.ar.push({ path: quotedAfter(q, /Path="((?:[^"\\]|\\.)*)"/) ?? "", ref: quotedAfter(q, /Ref="((?:[^"\\]|\\.)*)"/) ?? "", part: Number(/Part="(\d+)"/.exec(q)?.[1] ?? 1) })
        else if (/^F\s+\d+\s/.test(q)) {
          const m = /^F\s+(\d+)\s+"((?:[^"\\]|\\.)*)"/.exec(q)
          if (m) c.fields[Number(m[1])] = unquote(m[2])
        } else if (/^\s+-?[01]\s+-?[01]\s+-?[01]\s+-?[01]\s*$/.test(q)) c.matrix = q.trim().split(/\s+/).map(Number)
      }
      out.comps.push(c)
    } else if (l.startsWith("$Sheet")) {
      const s = { x: 0, y: 0, w: 0, h: 0, ts: "", name: "", file: "", pins: [] }
      for (i++; i < lines.length && !lines[i].startsWith("$EndSheet"); i++) {
        const q = lines[i]
        if (/^S\s/.test(q)) [s.x, s.y, s.w, s.h] = q.trim().split(/\s+/).slice(1).map(Number)
        else if (/^U\s/.test(q)) s.ts = q.trim().split(/\s+/)[1].toUpperCase().replace(/^0+(?=.)/, "")
        else if (/^F0\s/.test(q)) s.name = quotedAfter(q, /"((?:[^"\\]|\\.)*)"/) ?? ""
        else if (/^F1\s/.test(q)) s.file = quotedAfter(q, /"((?:[^"\\]|\\.)*)"/) ?? ""
        else if (/^F\d+\s/.test(q)) {
          const m = /^F\d+\s+"((?:[^"\\]|\\.)*)"\s+([IOBTU])\s+([RTBL])\s+(-?\d+)\s+(-?\d+)/.exec(q)
          if (m) s.pins.push({ name: unquote(m[1]), x: Number(m[4]), y: Number(m[5]) })
        }
      }
      out.sheets.push(s)
    } else if (/^Wire\s+Wire\s+Line/i.test(l)) {
      const t = lines[++i].trim().split(/\s+/).map(Number)
      out.wires.push({ a: { x: t[0], y: t[1] }, b: { x: t[2], y: t[3] } })
    } else if (/^Wire\s+Bus\s+Line/i.test(l)) {
      out.buses++
      i++
    } else if (/^Wire\s+Notes\s+Line/i.test(l)) i++
    else if (/^Entry\s/i.test(l)) {
      out.entries++
      i++
    } else if (/^Connection\s/.test(l)) {
      const t = l.trim().split(/\s+/)
      out.junctions.push({ x: Number(t[2]), y: Number(t[3]) })
    } else if (/^NoConn\s/.test(l)) {
      const t = l.trim().split(/\s+/)
      out.noconns.push({ x: Number(t[2]), y: Number(t[3]) })
    } else if (/^Text\s+(Label|GLabel|HLabel)\s/.test(l)) {
      const t = l.trim().split(/\s+/)
      let kind = t[1]
      if (kind === "GLabel" && version === 1) kind = "HLabel"
      out.labels.push({ kind, x: Number(t[2]), y: Number(t[3]), text: lines[++i].replace(/\\n/g, "\n").replace(/\{slash\}/g, "/") })
      // KiCad 5 compares the names as written (`~A~` and `~A` are two nets); the name shown is the converted one (`shown`)
    }
  }
  return out
}

const key = (x, y) => `${x},${y}`
const unitLetterOf = (n) => String.fromCharCode(64 + n)
void unitLetterOf

/**
 * Derives the nets of a legacy project. Returns `{ pins: Map<"<path>#<pad>", group>, names, netName(g), driver, unsupported }`.
 * A path is the board's form of a symbol's place, `/SHEETTS/COMPTS`, upper case without leading zeros.
 * `opts.ncPinsOnNets`: whether a pin of the type "no connect" joins what is drawn to it (KiCad 5 does).
 */
export function deriveLegacyNets(rootFile, opts = {}) {
  const o = { ncPinsOnNets: true, ...opts }
  const out = { pins: new Map(), unsupported: new Set(), symbols: 0, missing: new Set(), pinList: [] }
  const libs = projectLibs(rootFile)
  const uf = new UF()
  if (o.trace) {
    const u = uf.union.bind(uf)
    uf.union = (a, b) => {
      o.trace.push([a, b, String(new Error().stack).split(String.fromCharCode(10))[2].trim()])
      u(a, b)
    }
  }
  out.items = null
  const items = [] // { id, type, sheet, x, y, x2, y2, label?, ...}
  const sheetName = new Map([["", ""]])
  const pinsOf = []
  let n = 0
  const id = (k) => `${k}${n++}`

  const walk = (file, chain, ancestors) => {
    const sh = readSheet(file)
    const sheet = chain.join("/")
    if (sh.buses || sh.entries) out.unsupported.add("buses")
    const add = (type, x, y, extra = {}) => {
      const it = { id: id(type), type, sheet, x, y, x2: x, y2: y, ...extra }
      uf.find(it.id)
      items.push(it)
      return it
    }
    for (const w of sh.wires) add("segment", w.a.x, w.a.y, { x2: w.b.x, y2: w.b.y })
    for (const j of sh.junctions) add("junction", j.x, j.y)
    for (const c of sh.noconns) add("noconn", c.x, c.y)
    for (const l of sh.labels) add(l.kind === "Label" ? "label" : l.kind === "GLabel" ? "glabel" : "hlabel", l.x, l.y, { text: l.text })
    const children = []
    for (const s of sh.sheets) {
      for (const p of s.pins) add("sheetpin", p.x, p.y, { text: p.name, child: [...chain, s.ts].join("/") })
      children.push(s)
    }
    for (const c of sh.comps) {
      const part = findPart(libs, c.name, sh.version)
      if (!part) {
        out.missing.add(c.name)
        continue
      }
      out.symbols++
      // The use of the symbol on this sheet: 5.1 `GetRef` takes the `AR` line whose path is the sheet's path and the symbol's own timestamp, and the reference of field 0 when there is none
      // (a stale line, with another timestamp, is never matched).
      const norm = (path) => path.toUpperCase().replace(/\/0+(?=[0-9A-F])/g, "/")
      const here = `/${[...chain, c.ts].join("/")}`
      const hit = c.ar.find((a) => norm(a.path) === here)
      const uses = [hit ? { path: here, ref: hit.ref, unit: hit.part || c.unit } : { path: c.ts === "0" ? `/0@${c.fields[0] ?? ""}` : here, ref: c.fields[0] ?? "", unit: c.unit }]
      for (const use of uses) {
        for (const p of part.pins) {
          if (p.unit !== 0 && p.unit !== use.unit) continue
          if (p.convert !== 0 && p.convert !== c.convert) continue
          const [x1, y1, x2, y2] = c.matrix
          const x = c.x + x1 * p.x + y1 * p.y
          const y = c.y + x2 * p.x + y2 * p.y
          const nc = p.type === "N"
          const pin = add("pin", x, y, { pad: p.number, name: p.name, ref: use.ref, comp: c, nc, path: use.path })
          if (nc && !o.ncPinsOnNets) pin.skip = true
          pinsOf.push(pin)
          const powerConn = p.type === "W" && (p.hidden || part.power)
          if (powerConn) add("pinlabel", x, y, { text: p.name })
        }
      }
    }
    for (const s of children) {
      const child = join(dirname(file), s.file)
      if (!exists(child) || ancestors.includes(child)) continue
      sheetName.set([...chain, s.ts].join("/"), `${sheetName.get(sheet) ?? ""}/${s.name}`)
      walk(child, [...chain, s.ts], [...ancestors, file])
    }
  }
  walk(rootFile, [], [])

  // the points, per sheet
  const bySheet = new Map()
  for (const it of items) (bySheet.get(it.sheet) ?? bySheet.set(it.sheet, []).get(it.sheet)).push(it)
  const onSeg = (s, x, y) => {
    // a wire of no length has no side
    if (s.x === s.x2 && s.y === s.y2) return s.x === x && s.y === y
    const cross = (s.x2 - s.x) * (y - s.y) - (s.y2 - s.y) * (x - s.x)
    if (cross !== 0) return false
    const dot = (x - s.x) * (s.x2 - s.x) + (y - s.y) * (s.y2 - s.y)
    return dot >= 0 && dot <= (s.x2 - s.x) ** 2 + (s.y2 - s.y) ** 2
  }
  for (const list of bySheet.values()) {
    const at = new Map()
    for (const it of list) {
      if (it.skip) continue
      for (const k of [key(it.x, it.y), key(it.x2, it.y2)]) {
        if (!at.has(k)) at.set(k, [])
        at.get(k).push(it)
      }
    }
    // coinciding ends: segments, pins, labels, junctions, no-connects, sheet pins and pin labels; a bus-only item is not here
    // Only a segment, a pin, a pin label, a sheet pin or a no-connect flag starts a join (`BuildNetListInfo`, `pointToPointConnect`); labels and junctions are joined by them, never
    // to each other: two labels (or a label and a junction) at a point where nothing starts one are two items.
    const starts = (it) => ["segment", "pin", "pinlabel", "sheetpin", "noconn"].includes(it.type)
    for (const group of at.values()) if (group.some(starts)) for (let i = 1; i < group.length; i++) uf.union(group[0].id, group[i].id)
    const segs = list.filter((s) => s.type === "segment")
    // a junction or a label on the body of a wire
    for (const it of list) {
      if (!["junction", "label", "glabel", "hlabel"].includes(it.type)) continue
      for (const s of segs) if (onSeg(s, it.x, it.y)) uf.union(it.id, s.id)
    }
  }
  // names: labels of one text on one sheet; global labels everywhere; pin labels everywhere, and a local label picks up other sheets' pin labels
  const named = items.filter((i) => ["label", "glabel", "hlabel", "pinlabel"].includes(i.type))
  const textKey = (t) => t.text
  const shown = (t) => newOverbar(t)
  for (const a of named) {
    for (const b of named) {
      if (a === b || textKey(a) !== textKey(b)) continue
      if (a.type === "hlabel") continue // refs are label, glabel, pinlabel only
      if (a.sheet === b.sheet) uf.union(a.id, b.id)
      else if (b.type === "pinlabel" || (b.type === "glabel" && a.type === "glabel")) uf.union(a.id, b.id)
    }
  }
  // a sheet pin joins the hierarchical label of the same name in the sheet it stands for
  for (const sp of items.filter((i) => i.type === "sheetpin")) {
    for (const h of items.filter((i) => i.type === "hlabel" && i.sheet === sp.child && i.text === sp.text)) uf.union(sp.id, h.id)
  }
  // groups
  const gid = new Map()
  const g = (root) => {
    if (!gid.has(root)) gid.set(root, gid.size + 1)
    return gid.get(root)
  }
  const byGroup = new Map()
  for (const it of items) {
    const r = g(uf.find(it.id))
    ;(byGroup.get(r) ?? byGroup.set(r, []).get(r)).push(it)
  }
  for (const p of pinsOf) {
    if (p.skip) continue
    const k = `${p.path}#${p.pad}`
    const r = g(uf.find(p.id))
    out.pins.set(k, out.pins.has(k) && out.pins.get(k) !== r ? [].concat(out.pins.get(k), r) : r)
    out.pinList.push({ key: k, group: r, ref: p.ref, pad: p.pad })
  }
  // the driver of a group (KiCad 5.1 evalLabelsPriority) and its name
  const prio = { pin: 1, label: 2, hlabel: 3, pinlabel: 4, glabel: 6 }
  const isGlobal = (t) => t === "pinlabel" || t === "glabel"
  const better = (a, b) => {
    if (!isGlobal(a.type) && !isGlobal(b.type) && a.sheet.length !== b.sheet.length) return a.sheet.length < b.sheet.length
    if (prio[a.type] !== prio[b.type]) return prio[a.type] > prio[b.type]
    if (a.text !== b.text) return a.text < b.text
    return (sheetName.get(a.sheet) ?? "") < (sheetName.get(b.sheet) ?? "")
  }
  const driver = new Map()
  for (const [r, list] of byGroup) {
    let best = null
    for (const it of list) if (["label", "glabel", "hlabel", "pinlabel"].includes(it.type) && (!best || better(it, best))) best = it
    if (best) driver.set(r, { name: isGlobal(best.type) ? shown(best.text) : `${sheetName.get(best.sheet) ?? ""}/${shown(best.text)}`.replace(/^\/\//, "/"), bare: shown(best.text), prio: prio[best.type] })
  }
  const netName = (r) => {
    const d = driver.get(r)
    if (d) return d.name
    const cands = (byGroup.get(r) ?? []).filter((i) => i.type === "pin" && !String(i.ref).startsWith("#") && i.ref !== "").map((i) => `Net-(${i.ref}-Pad${i.pad})`).sort()
    return cands[0] ?? null
  }
  out.driver = driver
  out.items = items
  out.netName = netName
  out.groupOf = (k) => out.pins.get(k)
  return out
}
