import { atomKids, fileVersion, hasLists, listNamed, parseAt, roundKey, scanList, type SNode, type Span } from "./sexp"

// Writing back only what the user changed.
//
// Three texts of one KiCad file are at hand: the ORIGINAL the user brought, BEFORE (what the editor's exporter writes for the project
// as it was imported) and AFTER (what it writes for the project as it is now). The exporter writes the whole file from the model, so
// it spells things its own way and leaves out what the model does not hold; BEFORE and AFTER are in the same spelling, so what differs
// between THEM is exactly what the user changed. This carries that difference, and nothing else, into the ORIGINAL:
//
//  - a top level item (a footprint, a track, a symbol, a wire) that is the same in BEFORE and AFTER is not touched: its bytes stay;
//  - one that is not the same is changed in the original where it differs (a child replaced, added or removed), so a footprint the user
//    moved keeps its 3D model offsets, its fields' places and every attribute the editor has no model for, and a pad is replaced only
//    if the pad differs;
//  - one that is in BEFORE and not in AFTER is cut out; one that is only in AFTER is added at the end.
//
// An item is told in the three texts by what it is (its place, layer, text), not by an id: the exporter numbers uuids afresh and the
// editor's ids are random per import. A footprint that was moved or renamed is told by its other half (the name, or the place).
// Anything that cannot be told with certainty (a changed or deleted item that the original has no match for) makes the file not
// patchable (`ok: false`), and the caller writes the whole file as before: a wrong patch is worse than a plain export.

export type Kind = "board" | "schematic"

export interface PatchResult {
  ok: boolean
  text: string
  /** Why the file could not be patched, when `ok` is false. */
  reason?: string
  /** What was done, for the notes and the tests. */
  stats: { kept: number; changed: number; added: number; removed: number }
}

interface Edit extends Span {
  text: string
  seq: number
}

/** Why a file cannot be patched. */
class Unpatchable extends Error {}

// ---------- reading a file as units ----------

interface Unit {
  span: Span
  head: string
  canon: string
  /** The uuid the unit says of itself at its own top level. */
  uuid: string | null
  node?: SNode
  key?: string
}

interface Doc {
  text: string
  /** The root list's own place. */
  root: Span
  units: Unit[]
  /** `(net N "name")` rows of the table; empty for a file that names nets in place (KiCad 10). */
  nets: Map<number, string>
  byUuid: Map<string, Unit>
}

const UUID_RE = /\s*\((?:uuid|tstamp)\s+"?[0-9A-Za-z-]+"?\s*\)/g
const NET_RE = /\(net (\d+)(?: "((?:[^"\\]|\\.)*)")?\)/g
const ANY_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const SERIAL_UUID_RE = /^00000000-0000-4000-8000-[0-9a-f]{12}$/
const MEMBERS_RE = /\(members((?:\s+"?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"?)*)\s*\)/g

/** A text with what does not matter for "is this the same item" taken out: uuids, net numbers (by the net's name instead) and the layout. */
function canonOf(text: string, nets: Map<number, string>, keepUuids = false): string {
  const out = text
    .replace(UUID_RE, "")
    .replace(NET_RE, (_m, n: string, inline?: string) => `(net "${nets.get(Number(n)) ?? inline ?? n}")`)
    .replace(/\s+/g, " ")
  // A uuid that is made from an id (a sheet's, in the instance paths) says nothing of the item either.
  return keepUuids ? out : out.replace(ANY_UUID_RE, "U")
}

/** The uuid a list says of itself, among its own children (not in what they hold). */
function topUuid(text: string, span: Span): string | null {
  const l = scanList(text, span.start)
  for (const k of l.kids) {
    if (text.charCodeAt(k.start) !== 40) continue
    const m = /^\(\s*(?:uuid|tstamp)\s+"?([0-9A-Za-z-]+)"?\s*\)$/.exec(text.slice(k.start, k.end))
    if (m) return m[1]
  }
  return null
}

function readDoc(text: string, skip: ReadonlySet<string>): Doc {
  const root = scanList(text, 0)
  const nets = new Map<number, string>()
  const units: Unit[] = []
  const rows: Span[] = []
  for (const k of root.kids) {
    if (text.charCodeAt(k.start) !== 40) continue
    const l = scanList(text, k.start)
    if (l.head === "net") {
      const m = /^\(\s*net\s+(\d+)\s+"((?:[^"\\]|\\.)*)"\s*\)$/.exec(text.slice(k.start, k.end))
      if (m) {
        nets.set(Number(m[1]), m[2])
        rows.push(k)
        continue
      }
    }
    if (skip.has(l.head)) continue
    units.push({ span: k, head: l.head, canon: "", uuid: null })
  }
  const doc: Doc = { text, root: { start: root.start, end: root.end }, units, nets, byUuid: new Map() }
  for (const u of units) {
    u.uuid = topUuid(text, u.span)
    u.canon = canonOf(text.slice(u.span.start, u.span.end), nets)
    if (u.uuid) doc.byUuid.set(u.uuid, u)
  }
  // A group lists its members by uuid, and a uuid says nothing across files: by what the member is instead.
  for (const u of units) {
    if (u.head !== "group" && u.head !== "generated") continue
    u.canon = canonOf(text.slice(u.span.start, u.span.end), nets, true)
      .replace(MEMBERS_RE, (_m, list: string) => {
        const keys = [...list.matchAll(ANY_UUID_RE)].map((x) => doc.byUuid.get(x[0])?.canon ?? "?").sort()
        return `(members ${keys.length}:${keys.join("|")})`
      })
      .replace(ANY_UUID_RE, "U")
  }
  return doc
}

// ---------- the key of an item: what it is, in all three texts ----------

const SKIP_IN_GEOMETRY = new Set(["filled_polygon", "render_cache", "effects", "stroke", "fill", "uuid", "tstamp", "property", "net", "net_name", "width", "locked", "pad", "model", "fp_text", "fp_line", "fp_circle", "fp_arc", "fp_rect", "fp_poly", "fp_curve", "stackup", "teardrop", "connect_pads", "min_thickness", "filled_areas_thickness", "fill_segments", "keepout", "hatch", "priority", "attr", "descr", "tags", "sheetname", "sheetfile", "path", "embedded_fonts", "embedded_files"])
const COORD = new Set(["start", "end", "mid", "center", "at", "xy", "pos", "origin", "size"])
const SYMMETRIC = new Set(["segment", "gr_line", "fp_line", "wire", "bus", "arc", "gr_arc", "fp_arc"])
const TEXTY = new Set(["gr_text", "gr_text_box", "text", "text_box", "label", "global_label", "hierarchical_label", "directive_label", "netclass_flag", "group", "image"])

function collect(node: SNode, text: string, out: string[], layers: string[], depth: number) {
  for (const k of node.kids ?? []) {
    if (k.kids === undefined) continue
    if (k.head === "layer" || k.head === "layers") {
      layers.push(...(k.kids.slice(1).map((a) => a.value ?? "")))
      continue
    }
    if (SKIP_IN_GEOMETRY.has(k.head)) continue
    if (COORD.has(k.head)) {
      out.push(`${k.head}:${k.kids.slice(1).map((a) => roundKey(a.raw)).join(",")}`)
      continue
    }
    if (depth < 4) collect(k, text, out, layers, depth + 1)
  }
}

/** What an item is, from its geometry and text: the same in the original and in the exporter's spelling of it. */
export function keyOf(node: SNode, text: string, kind: Kind): string {
  const head = node.head
  if (kind === "schematic" && (head === "symbol" || head === "sheet")) {
    const u = listNamed(node, "uuid")
    const v = u?.kids?.[1]?.value
    if (v) return `${head}|${v}`
  }
  if (head === "property") return `property|${node.kids?.[1]?.value ?? ""}`
  const parts: string[] = []
  const layers: string[] = []
  collect(node, text, parts, layers, 0)
  if (SYMMETRIC.has(head)) {
    const ends = parts.filter((p) => p.startsWith("start:") || p.startsWith("end:") || p.startsWith("xy:")).map((p) => p.slice(p.indexOf(":") + 1)).sort()
    const rest = parts.filter((p) => !(p.startsWith("start:") || p.startsWith("end:") || p.startsWith("xy:")))
    parts.length = 0
    parts.push(`ends:${ends.join("/")}`, ...rest)
  }
  const extra = TEXTY.has(head) ? (node.kids?.[1]?.raw === undefined ? "" : (node.kids[1].value ?? "")) : ""
  return `${head}|${extra}|${layers.join(",")}|${parts.join(";")}`
}

interface FootprintKey {
  exact: string
  ref: string
  pos: string
}

/** A footprint: its reference, name and place, in the way a footprint is told when it moved (by the reference) or was renamed (by the place). */
function footprintKey(node: SNode): FootprintKey {
  const name = node.kids?.[1]?.value ?? ""
  let ref = ""
  for (const k of node.kids ?? []) {
    if (k.kids === undefined) continue
    if (k.head === "property" && k.kids[1]?.value === "Reference") ref = k.kids[2]?.value ?? ""
    else if (k.head === "fp_text" && k.kids[1]?.value === "reference") ref = k.kids[2]?.value ?? ""
    if (ref) break
  }
  const at = listNamed(node, "at")
  const layer = listNamed(node, "layer")?.kids?.[1]?.value ?? ""
  const x = roundKey(at?.kids?.[1]?.raw)
  const y = roundKey(at?.kids?.[2]?.raw)
  const a = roundKey(at?.kids?.[3]?.raw ?? "0")
  return { exact: `fp|${ref}|${name}|${x}|${y}|${a}|${layer}`, ref: `fp|${ref}|${name}|${layer}`, pos: `fp|${name}|${x}|${y}|${a}|${layer}` }
}

// ---------- the keys of the children inside an item ----------

const BY_FIRST_ATOM = new Set(["property", "pad", "model", "fp_text", "layer_alias"])
const GEOMETRIC_KIDS = new Set(["fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly", "fp_curve", "fp_text_box", "gr_line", "gr_rect", "gr_circle", "gr_arc", "gr_poly", "gr_curve", "gr_text", "gr_text_box", "segment", "arc", "via", "zone", "dimension", "polyline", "rectangle", "circle", "bezier", "wire", "bus", "junction", "no_connect", "bus_entry", "label", "global_label", "hierarchical_label", "directive_label", "text", "text_box", "image", "pin"])

function childBase(k: SNode, text: string, kind: Kind): string {
  if (k.head === "filled_polygon") return `filled_polygon|${listNamed(k, "layer")?.kids?.[1]?.value ?? ""}`
  if (k.head === "symbol" && k.kids?.[1]?.raw !== undefined) return `symbol|${k.kids[1].value}`
  if (k.head === "pin" && kind === "schematic") return `pin|${k.kids?.[1]?.value ?? ""}`
  if (BY_FIRST_ATOM.has(k.head)) return `${k.head}|${k.kids?.[1]?.value ?? ""}`
  if (GEOMETRIC_KIDS.has(k.head)) return keyOf(k, text, kind)
  if (k.head === "path" || k.head === "project") return `${k.head}|${k.kids?.[1]?.value ?? ""}`
  return k.head
}

/** The list children of a node by key; a key that repeats is told by its place among those that share it. */
function keyedKids(node: SNode, text: string, kind: Kind): { keys: string[]; byKey: Map<string, SNode> } {
  const keys: string[] = []
  const byKey = new Map<string, SNode>()
  const seen = new Map<string, number>()
  for (const k of node.kids ?? []) {
    if (k.kids === undefined) continue
    const base = childBase(k, text, kind)
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    const key = `${base}#${n}`
    keys.push(key)
    byKey.set(key, k)
  }
  return { keys, byKey }
}

// ---------- the patch ----------

function lineIndent(text: string, pos: number): string {
  const nl = text.lastIndexOf("\n", pos - 1)
  const m = /^[ \t]*/.exec(text.slice(nl + 1, pos))
  return m ? m[0] : ""
}

function hash32(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0
  return h
}

/** A uuid made from a text, the same every time. */
function uuidOf(text: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193
  let c = 0x9747b28c
  let d = 0x85ebca6b
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i)
    a = Math.imul(a ^ k, 0x01000193) >>> 0
    b = Math.imul(b ^ (k + i), 0x85ebca6b) >>> 0
    c = Math.imul(c ^ (k << 1), 0xc2b2ae35) >>> 0
    d = Math.imul(d + k, 0x27d4eb2f) >>> 0
  }
  const hex = (n: number) => n.toString(16).padStart(8, "0")
  const h = hex(a) + hex(b) + hex(c) + hex(d)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

interface Options {
  kind: Kind
  /** Root children left exactly as the original has them. */
  skip: ReadonlySet<string>
}


class Patcher {
  readonly edits: Edit[] = []
  private seq = 0
  readonly O: string
  readonly oDoc: Doc
  readonly unitUsed = new Set<Unit>()
  private oByHead = new Map<string, Unit[]>()
  private oKeys = new Map<Unit, { key: string; fp?: FootprintKey }>()
  private oNode = new Map<Unit, SNode>()
  readonly uuidMap = new Map<string, string>()
  private newNets = new Map<string, number>()
  private oNetByName = new Map<string, number>()
  private nextNet = 1
  private tab: boolean
  private salt: string
  stats = { kept: 0, changed: 0, added: 0, removed: 0 }

  constructor(
    original: string,
    readonly B: Doc,
    readonly C: Doc,
    readonly opts: Options,
  ) {
    this.O = original
    this.oDoc = readDoc(original, opts.skip)
    for (const u of this.oDoc.units) {
      const list = this.oByHead.get(u.head)
      if (list) list.push(u)
      else this.oByHead.set(u.head, [u])
    }
    for (const [n, name] of this.oDoc.nets) {
      this.oNetByName.set(name, n)
      this.nextNet = Math.max(this.nextNet, n + 1)
    }
    this.tab = /\n\t/.test(original.slice(0, 5000))
    this.salt = `${original.length}:${hash32(original)}`
  }

  // ----- the original's items -----

  private oNodeOf(u: Unit): SNode {
    let n = this.oNode.get(u)
    if (!n) {
      n = parseAt(this.O, u.span.start, u.span.end)
      this.oNode.set(u, n)
    }
    return n
  }

  private oKeyOf(u: Unit) {
    let k = this.oKeys.get(u)
    if (!k) {
      const node = this.oNodeOf(u)
      k = { key: keyOf(node, this.O, this.opts.kind), ...(u.head === "footprint" ? { fp: footprintKey(node) } : {}) }
      this.oKeys.set(u, k)
    }
    return k
  }

  /** The unit of the original that is the same item as this one of BEFORE, or null. */
  findOriginal(b: Unit, bNode: SNode): Unit | null {
    const candidates = (this.oByHead.get(b.head) ?? []).filter((u) => !this.unitUsed.has(u))
    if (!candidates.length) return null
    if (b.head === "footprint") {
      const bk = footprintKey(bNode)
      for (const pick of ["exact", "ref", "pos"] as const) {
        const hit = candidates.find((u) => this.oKeyOf(u).fp![pick] === bk[pick])
        if (hit) return hit
      }
      return null
    }
    const key = keyOf(bNode, this.B.text, this.opts.kind)
    return candidates.find((u) => this.oKeyOf(u).key === key) ?? null
  }

  // ----- emitting text -----

  private render(c: SNode, cText: string, oBase: string): string {
    const slice = cText.slice(c.start, c.end)
    const cBase = lineIndent(cText, c.start)
    const lines = slice.split("\n")
    const unit = this.tab ? "\t" : "  "
    return lines
      .map((line, i) => {
        if (i === 0) return line
        const stripped = line.startsWith(cBase) ? line.slice(cBase.length) : line.trimStart()
        const lead = /^ */.exec(stripped)![0].length
        const rest = stripped.slice(lead)
        if (!rest) return ""
        return oBase + unit.repeat(Math.floor(lead / 2)) + " ".repeat(lead % 2) + rest
      })
      .join("\n")
  }

  private edit(start: number, end: number, text: string) {
    this.edits.push({ start, end, text, seq: this.seq++ })
  }

  private mapUuids(o: SNode, c: SNode) {
    const ou = listNamed(o, "uuid")?.kids?.[1]?.value ?? listNamed(o, "tstamp")?.kids?.[1]?.value
    const cu = listNamed(c, "uuid")?.kids?.[1]?.value ?? listNamed(c, "tstamp")?.kids?.[1]?.value
    if (ou && cu) this.uuidMap.set(cu, ou)
  }

  private replaceNode(o: SNode, c: SNode) {
    this.mapUuids(o, c)
    this.edit(o.start, o.end, this.render(c, this.C.text, lineIndent(this.O, o.start)))
  }

  private addChild(parent: SNode, c: SNode) {
    const kids = parent.kids!
    const last = kids[kids.length - 1]
    const firstList = kids.find((k) => k.kids !== undefined)
    const indent = firstList ? lineIndent(this.O, firstList.start) : lineIndent(this.O, parent.start) + (this.tab ? "\t" : "  ")
    this.edit(last.end, last.end, `\n${indent}${this.render(c, this.C.text, indent)}`)
  }

  private removeChild(parent: SNode, k: SNode) {
    const kids = parent.kids!
    const i = kids.indexOf(k)
    this.edit(kids[i - 1].end, k.end, "")
  }

  /** Brings what differs between `b` and `c` into `o`. */
  mergeNode(o: SNode, b: SNode, c: SNode) {
    const kind = this.opts.kind
    if (canonOf(this.B.text.slice(b.start, b.end), this.B.nets) === canonOf(this.C.text.slice(c.start, c.end), this.C.nets)) return
    if (o.head !== b.head || b.head !== c.head || (!hasLists(b) && !hasLists(c))) return this.replaceNode(o, c)
    const ba = atomKids(b).map((a) => a.raw!)
    const ca = atomKids(c).map((a) => a.raw!)
    if (ba.join(" ") !== ca.join(" ")) {
      const oa = atomKids(o)
      if (oa.length === ba.length && ca.length === ba.length) {
        ca.forEach((raw, i) => {
          if (raw !== ba[i]) this.edit(oa[i].start, oa[i].end, raw)
        })
      } else return this.replaceNode(o, c)
    }
    const kb = keyedKids(b, this.B.text, kind)
    const kc = keyedKids(c, this.C.text, kind)
    const ko = keyedKids(o, this.O, kind)
    for (const key of kc.keys) {
      const ck = kc.byKey.get(key)!
      const bk = kb.byKey.get(key)
      const ok = ko.byKey.get(key)
      if (!bk) {
        if (ok) this.replaceNode(ok, ck)
        else this.addChild(o, ck)
      } else if (canonOf(this.B.text.slice(bk.start, bk.end), this.B.nets) !== canonOf(this.C.text.slice(ck.start, ck.end), this.C.nets)) {
        if (ok) this.mergeNode(ok, bk, ck)
        else this.addChild(o, ck)
      }
    }
    for (const key of kb.keys) {
      if (kc.byKey.has(key)) continue
      const ok = ko.byKey.get(key)
      if (ok) this.removeChild(o, ok)
    }
  }

  // ----- the root -----

  /** The final text of something taken from AFTER: its nets numbered as the original numbers them, its uuids those of the items it stands for. */
  finalize(text: string): string {
    const withMembers = text.replace(MEMBERS_RE, (m, list: string) => {
      for (const x of list.matchAll(ANY_UUID_RE)) this.resolveMember(x[0])
      return m
    })
    const nets = withMembers.replace(NET_RE, (_m, n: string, inline?: string) => {
      const name = this.C.nets.get(Number(n)) ?? inline ?? ""
      return this.netRef(name, inline !== undefined)
    })
    return nets.replace(ANY_UUID_RE, (u) => this.uuidMap.get(u) ?? (SERIAL_UUID_RE.test(u) ? this.fresh(u) : u))
  }

  private fresh(u: string): string {
    const made = uuidOf(`${this.salt}:${u}`)
    this.uuidMap.set(u, made)
    return made
  }

  private netRef(name: string, withName: boolean): string {
    const numeric = this.oDoc.nets.size > 0
    if (!numeric) return `(net ${JSON.stringify(name)})`
    let n = this.oNetByName.get(name) ?? this.newNets.get(name)
    if (n === undefined) {
      n = this.nextNet++
      this.newNets.set(name, n)
    }
    return withName ? `(net ${n} ${JSON.stringify(name)})` : `(net ${n})`
  }

  /** A member of a changed group: the uuid of the original's item that stands for it. */
  private resolveMember(u: string) {
    if (this.uuidMap.has(u)) return
    const cu = this.C.byUuid.get(u)
    if (!cu) throw new Unpatchable(`a group names an item (${u}) the file does not have`)
    const twins = this.bByCanon.get(cu.canon)
    const b = twins?.[0]
    if (!b) throw new Unpatchable("a group's member is not an item of the file as it was")
    const bNode = parseAt(this.B.text, b.span.start, b.span.end)
    const o = this.findOriginalAny(b, bNode)
    if (!o?.uuid) throw new Unpatchable("a group's member has no counterpart in the original")
    this.uuidMap.set(u, o.uuid)
  }

  /** Like `findOriginal`, but an original already matched to another item of the same kind is fine: the member is that item. */
  private findOriginalAny(b: Unit, bNode: SNode): Unit | null {
    const found = this.findOriginal(b, bNode)
    if (found) return found
    const key = b.head === "footprint" ? footprintKey(bNode).exact : keyOf(bNode, this.B.text, this.opts.kind)
    return (this.oByHead.get(b.head) ?? []).find((u) => (b.head === "footprint" ? this.oKeyOf(u).fp!.exact : this.oKeyOf(u).key) === key) ?? null
  }


  private bByCanon = new Map<string, Unit[]>()

  private parse(doc: Doc, u: Unit): SNode {
    return (u.node ??= parseAt(doc.text, u.span.start, u.span.end))
  }

  private keyIn(u: Unit, doc: Doc): string {
    const node = this.parse(doc, u)
    return u.head === "footprint" ? footprintKey(node).exact : keyOf(node, doc.text, this.opts.kind)
  }

  /** Pairs the items of BEFORE and AFTER that are left, by `key` (read the same way from each side). */
  private pairLeft(freeB: Set<Unit>, freeC: Set<Unit>, pairs: { b: Unit; c: Unit }[], keyFor: (u: Unit, doc: Doc) => string | null) {
    const index = new Map<string, Unit[]>()
    for (const b of freeB) {
      const k = keyFor(b, this.B)
      if (k === null) continue
      const l = index.get(k)
      if (l) l.push(b)
      else index.set(k, [b])
    }
    for (const c of [...freeC]) {
      const k = keyFor(c, this.C)
      if (k === null) continue
      const hit = index.get(k)?.shift()
      if (hit) {
        pairs.push({ b: hit, c })
        freeB.delete(hit)
        freeC.delete(c)
      }
    }
  }

  run(): string {
    const { B, C } = this
    for (const u of B.units) {
      const l = this.bByCanon.get(u.canon)
      if (l) l.push(u)
      else this.bByCanon.set(u.canon, [u])
    }
    // The items of BEFORE and AFTER that have no identical twin on the other side: what the user changed.
    const remaining = new Map<string, Unit[]>()
    for (const [k, l] of this.bByCanon) remaining.set(k, [...l])
    const addedC: Unit[] = []
    for (const u of C.units) {
      const l = remaining.get(u.canon)
      if (l?.length) l.pop()
      else addedC.push(u)
    }
    const freeB = new Set([...remaining.values()].flat())
    const freeC = new Set(addedC)
    this.stats.kept = C.units.length - addedC.length

    // Pair what is left: the same item changed (same key), and a footprint that moved or was renamed.
    const pairs: { b: Unit; c: Unit }[] = []
    this.pairLeft(freeB, freeC, pairs, (u, doc) => this.keyIn(u, doc))
    for (const pick of ["ref", "pos"] as const) this.pairLeft(freeB, freeC, pairs, (u, doc) => (u.head === "footprint" ? footprintKey(this.parse(doc, u))[pick] : null))

    // Changed items: found in the original, merged.
    for (const { b, c } of pairs) {
      const bNode = this.parse(B, b)
      const o = this.findOriginal(b, bNode)
      if (!o) throw new Unpatchable(`a changed ${b.head} was not found in the original file`)
      this.unitUsed.add(o)
      const oNode = this.oNodeOf(o)
      this.mapUuids(oNode, this.parse(C, c))
      this.mergeNode(oNode, bNode, this.parse(C, c))
      this.stats.changed++
    }
    // Removed items: cut out of the original.
    const root = scanList(this.O, this.oDoc.root.start)
    for (const b of freeB) {
      const o = this.findOriginal(b, this.parse(B, b))
      if (!o) throw new Unpatchable(`a deleted ${b.head} was not found in the original file`)
      this.unitUsed.add(o)
      const i = root.kids.findIndex((k) => k.start === o.span.start)
      this.edit(i > 0 ? root.kids[i - 1].end : root.start + 1 + root.head.length, o.span.end, "")
      this.stats.removed++
    }
    // Added items, after the last item of the original.
    const units = this.oDoc.units
    const anchor = units.length ? units[units.length - 1].span : null
    if (freeC.size && !anchor) throw new Unpatchable("the original has no item to add after")
    if (freeC.size) {
      const base = lineIndent(this.O, anchor!.start)
      const chunks = [...freeC].map((c) => `\n${base}${this.render(this.parse(C, c), C.text, base)}`)
      this.edit(anchor!.end, anchor!.end, chunks.join(""))
      this.stats.added = freeC.size
    }
    return this.build()
  }

  private build(): string {
    // What was taken from AFTER is given the original's numbers for nets and its items' uuids now that every pairing is known.
    for (const e of this.edits) if (e.text) e.text = this.finalize(e.text)
    if (this.newNets.size) {
      const rows = scanList(this.O, this.oDoc.root.start).kids.filter((k) => this.O.charCodeAt(k.start) === 40 && /^\(\s*net\s+\d+\s+"/.test(this.O.slice(k.start, k.start + 40)))
      const last = rows[rows.length - 1]
      if (!last) throw new Unpatchable("the original has no net table to add to")
      const base = lineIndent(this.O, last.start)
      this.edit(last.end, last.end, [...this.newNets].map(([name, n]) => `\n${base}(net ${n} ${JSON.stringify(name)})`).join(""))
    }
    const sorted = [...this.edits].sort((a, b) => a.start - b.start || a.seq - b.seq)
    let out = ""
    let at = 0
    for (const e of sorted) {
      if (e.start < at) throw new Unpatchable("two changes overlap")
      out += this.O.slice(at, e.start) + e.text
      at = e.end
    }
    return out + this.O.slice(at)
  }
}

const SKIP: Record<Kind, ReadonlySet<string>> = {
  board: new Set(["version", "generator", "generator_version"]),
  schematic: new Set(["version", "generator", "generator_version", "uuid"]),
}

/**
 * The original file with what differs between `before` and `after` brought in. `before` and `after` are what the exporter writes for the
 * project as it was imported and as it is now. Returns the original itself when they are the same.
 */
export function patchFile(kind: Kind, original: string, before: string, after: string): PatchResult {
  const stats = { kept: 0, changed: 0, added: 0, removed: 0 }
  if (before === after) return { ok: true, text: original, stats }
  try {
    const B = readDoc(before, SKIP[kind])
    const C = readDoc(after, SKIP[kind])
    const patcher = new Patcher(original, B, C, { kind, skip: SKIP[kind] })
    const text = patcher.run()
    return { ok: true, text, stats: patcher.stats }
  } catch (e) {
    if (e instanceof Unpatchable) return { ok: false, text: original, reason: e.message, stats }
    throw e
  }
}

/** The version of the format a file says it is. */
export { fileVersion }

/** A file's text without its uuids and layout: two files that say the same thing but for the ids made afresh each time are the same here. */
export const neutralText = (text: string): string => text.replace(UUID_RE, "").replace(ANY_UUID_RE, "U").replace(/\s+/g, " ")
