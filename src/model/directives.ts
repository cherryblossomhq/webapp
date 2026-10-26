import { pointSegmentDistance } from "../lib/geometry"
import { getConnectivity, sameSchematic } from "./connectivityCache"
import { SegmentIndex, pinKey, type SchematicConnectivity } from "./connectivity"
import { schematicPins } from "./instances"
import { findPart } from "./library"
import { classNameProblem, patternMatcher } from "./netClasses"
import { onPolygonEdge, pointInPolygon, polygonHitsWire } from "./polygonHits"
import { isRuleArea, type RuleArea } from "./ruleAreas"
import { ROOT_SHEET, isHierarchical, sheetIdOf, sheetUses, useOf } from "./sheets"
import { directiveShape } from "./sheetItems"
import type { DirectiveShape, DrawingDirective, LabelField, NetClass, Project, Rotation, SchematicDrawing, Vec2 } from "./types"

// S8: directive labels, and the net classes they give. KiCad's `CONNECTION_GRAPH::GenerateNetsAndClasses`-side rule (`GetNetclassesForDriver`,
// connection_graph.cpp:435 of 9.0.0 and :538 of 10.0): every item of a net can say a class, and the net is in all the classes its items say.
// An item says one by a field named `Netclass`, which a directive label has (and a plain label may), or through a rule area: a directive label on the
// edge of a rule area gives its class to the wires, labels and pins inside the area (and, in KiCad 10, the pins of the symbols that touch it).
// The model has one class for a net (`model/netClasses.ts`), so a net that two classes claim is not exact and the import refuses it; the nets a label
// puts in a class are kept in `NetClass.labelNets`, worked out here after every edit of the schematic.

/** What the field is called in KiCad 9.0 and 10.0: `Netclass`, or `Net Class` (sch_field.cpp:1264 of 9.0.0), written with the UI's language in files of older releases. */
const TRANSLATED = [
  "Net Class", "صنف الشبكة", "Верига Клас", "Classe de xarxa", "Třídy spojů", "Netklasse", "Netzklasse", "Κλάση Δικτύου", "Clase de red", "Ühendusniidiklass", "Verkkoluokka", "Classe d'Equipot", "מחלקת רשת",
  "नेट क्लास", "Hálózatosztály", "Kelas Net", "Netclass", "ネットクラス", "ქსელის კლასი", "네트 클래스", "Grandinių klasė", "Tīklu klase", "Nettklasse", "Klasy sieci", "Classes da rede", "Classe de Rede",
  "Класс цепей", "Triedy spojov", "Razred vozlišča", "Класа везе", "Nätklass", "நிகர வகுப்பு", "నెట్ క్లాస్", "เน็ตคลาส", "Ağ Sınıfı", "Клас зв'язків", "Lớp mạng", "网络类", "網路類",
]
const NETCLASS_NAMES: ReadonlySet<string> = new Set(["Netclass", ...TRANSLATED])

/**
 * Whether a field of a label names its net class. KiCad 9.0 and 10.0 read `Netclass` and `Net Class` (and the translation of `Net Class` in the
 * language of the program that reads the file); development builds of what follows 10 read the translations in every language
 * (`SCH_FIELD::IsNetclassLabelFieldName`, sch_field.cpp:109 of master, not in 10.0.0 to 10.0.3). The importer reads all of them, and says so in the report.
 */
export const isNetclassFieldName = (name: string) => NETCLASS_NAMES.has(name)

/** Whether a field's name is one of the two KiCad 9 and 10 read in every language. */
export const isPlainNetclassFieldName = (name: string) => name === "Netclass" || name === "Net Class"

/** KiCad's field that names a class for the symbols in a rule area; the editor keeps it and uses none. */
export const COMPONENT_CLASS_FIELD = "Component Class"

/** A drawing that is a directive label. */
export type Directive = DrawingDirective & { sheet?: string }
export const isDirective = (d: SchematicDrawing): d is Directive => d.type === "directive"

/** The classes a label's fields name, in order and once each; a field with nothing in it names none (`netclass != wxEmptyString`). */
export function fieldClasses(fields: readonly LabelField[] | undefined): string[] {
  const out: string[] = []
  for (const f of fields ?? []) if (isNetclassFieldName(f.name) && f.value !== "" && !out.includes(f.value)) out.push(f.value)
  return out
}

const hasDirectiveCache = new WeakMap<readonly SchematicDrawing[], boolean>()
/** Whether the project has a directive label. */
export function hasDirectives(project: Pick<Project, "drawings">): boolean {
  const list = project.drawings
  if (!list?.length) return false
  let hit = hasDirectiveCache.get(list)
  if (hit === undefined) {
    hit = list.some(isDirective)
    hasDirectiveCache.set(list, hit)
  }
  return hit
}

const labelClassCache = new WeakMap<readonly object[], boolean>()
/** Whether any label of the project names a class by a field of its own. */
function hasLabelClasses(project: Pick<Project, "labels">): boolean {
  const list = project.labels
  if (!list.length) return false
  let hit = labelClassCache.get(list)
  if (hit === undefined) {
    hit = list.some((l) => l.fields?.some((f) => isNetclassFieldName(f.name) && f.value !== ""))
    labelClassCache.set(list, hit)
  }
  return hit
}

/** KiCad's default wire width, 6 mil, in the editor's units: a wire that says no width of its own is this wide when a rule area looks for the wires it covers. */
const DEFAULT_WIRE_WIDTH = 0.012
/** A directive label is on the edge of a rule area within 5 internal units (a nanometre each): the editor's coordinates are rounded to a ten-thousandth of a unit (0.00127 mm). */
const EDGE_TOLERANCE = 1e-4
/** A point is on a wire or a pin where the editor's own connectivity says it is (a pin or a wire end within a thousandth of a unit). */
const ON = 5e-4

const near = (a: Vec2, b: Vec2) => Math.abs(a.x - b.x) <= ON && Math.abs(a.y - b.y) <= ON

/** Points by a grid of a thousandth of a unit, so the points at a place are found without reading them all (the editor's own tolerance is a bucket and its neighbours). */
class PointIndex<T extends Vec2> {
  private cells = new Map<string, T[]>()
  constructor(points: Iterable<T>) {
    for (const p of points) {
      const k = `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`
      const list = this.cells.get(k)
      if (list) list.push(p)
      else this.cells.set(k, [p])
    }
  }
  at(p: Vec2): T[] {
    const out: T[] = []
    const cx = Math.round(p.x * 1000)
    const cy = Math.round(p.y * 1000)
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const q of this.cells.get(`${cx + dx},${cy + dy}`) ?? []) if (near(q, p)) out.push(q)
    return out
  }
}

function boxOf(pts: readonly Vec2[], grow = 0) {
  const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
  for (const p of pts) {
    if (p.x < b.minX) b.minX = p.x
    if (p.x > b.maxX) b.maxX = p.x
    if (p.y < b.minY) b.minY = p.y
    if (p.y > b.maxY) b.maxY = p.y
  }
  return { minX: b.minX - grow, maxX: b.maxX + grow, minY: b.minY - grow, maxY: b.maxY + grow }
}
const inBox = (b: ReturnType<typeof boxOf>, p: Vec2) => p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY
export interface ClassClaim {
  /** The net's name. */
  net: string
  /** The class, as the label writes it. */
  cls: string
}

/**
 * Every net a directive label or a label's own field puts in a class, with the class, for every use of every sheet: the directive that sits on
 * a wire, a pin or a label (or a rule area's edge, and so the wires, labels and pins inside), by where the editor's connectivity has them.
 */
export function labelClassClaims(project: Project, conn: SchematicConnectivity = getConnectivity(project)): ClassClaim[] {
  const directives = (project.drawings ?? []).filter(isDirective)
  if (!directives.length && !hasLabelClasses(project)) return []
  const nets = new Map(conn.nets.map((n) => [n.id, n.name]))
  const uses = isHierarchical(project) ? sheetUses(project) : [{ path: "", sheet: ROOT_SHEET }]
  const claims = new Map<string, ClassClaim>()
  const claim = (netId: string | undefined, cls: string) => {
    const net = netId === undefined ? undefined : nets.get(netId)
    if (net !== undefined && !claims.has(`${net}\u0000${cls}`)) claims.set(`${net}\u0000${cls}`, { net, cls })
  }
  const hier = isHierarchical(project)
  const wireNetOf = (path: string) => (hier ? conn.byUse?.wireNet.get(path) : conn.wireNet)
  const labelNetOf = (path: string) => (hier ? conn.byUse?.labelNet.get(path) : conn.labelNet)
  const wiresOf = new Map<string, typeof project.wires>()
  for (const w of project.wires) (wiresOf.get(sheetIdOf(w)) ?? wiresOf.set(sheetIdOf(w), []).get(sheetIdOf(w))!).push(w)
  const labelsOf = new Map<string, typeof project.labels>()
  for (const l of project.labels) (labelsOf.get(sheetIdOf(l)) ?? labelsOf.set(sheetIdOf(l), []).get(sheetIdOf(l))!).push(l)
  const compsOf = new Map<string, typeof project.components>()
  for (const c of project.components) (compsOf.get(useOf(c)) ?? compsOf.set(useOf(c), []).get(useOf(c))!).push(c)

  // A plain label that names a class by a field of its own: its net.
  for (const u of uses) {
    for (const l of labelsOf.get(u.sheet) ?? []) for (const cls of fieldClasses(l.fields)) claim(labelNetOf(u.path)?.get(l.id), cls)
  }

  const areas = (project.drawings ?? []).filter((d): d is RuleArea => isRuleArea(d) && d.points.length >= 3)
  for (const u of uses) {
    const sheet = u.sheet
    const wireNet = wireNetOf(u.path)
    const labelNet = labelNetOf(u.path)
    const comps = compsOf.get(u.path) ?? []
    const here = directives.filter((d) => sheetIdOf(d) === sheet)
    const sheetWires = wiresOf.get(sheet) ?? []
    const sheetLabels = labelsOf.get(sheet) ?? []
    const named = here.filter((d) => fieldClasses(d.fields).length)
    const wireIndex = named.length ? new SegmentIndex(sheetWires) : null
    const pins = named.length ? new PointIndex(comps.flatMap((c) => schematicPins(c, findPart(c.partId)).filter((p) => !p.slot).map((p) => ({ x: p.pos.x, y: p.pos.y, id: pinKey(c.id, p.pin) })))) : null
    const labelPoints = named.length ? new PointIndex(sheetLabels.map((l) => ({ x: l.x, y: l.y, id: l.id }))) : null
    for (const d of named) {
      const classes = fieldClasses(d.fields)
      const at = { x: d.x, y: d.y }
      // On a wire, a pin or a label: the net there.
      for (const [wi, segs] of wireIndex!.near(at)) {
        const w = sheetWires[wi]
        if (segs.some((i) => pointSegmentDistance(at, w.points[i], w.points[i + 1]) <= ON)) for (const cls of classes) claim(wireNet?.get(w.id), cls)
      }
      for (const p of pins!.at(at)) for (const cls of classes) claim(conn.pinNet.get(p.id), cls)
      for (const l of labelPoints!.at(at)) for (const cls of classes) claim(labelNet?.get(l.id), cls)
    }
    // On the edge of a rule area: every wire, label and pin inside it.
    for (const a of areas) {
      if (sheetIdOf(a) !== sheet) continue
      // Only what is near the polygon's box is looked at, and only a directive label with a class and in the box is tried on the polygon's edge.
      const box = boxOf(a.points, DEFAULT_WIRE_WIDTH * 4)
      const classes = [...new Set(named.filter((d) => inBox(box, d) && onPolygonEdge(a.points, { x: d.x, y: d.y }, EDGE_TOLERANCE)).flatMap((d) => fieldClasses(d.fields)))]
      if (!classes.length) continue
      for (const w of wiresOf.get(sheet) ?? []) {
        const half = (w.look?.width ?? DEFAULT_WIRE_WIDTH) / 2
        const wb = boxOf(w.points)
        if (wb.maxX < box.minX || wb.minX > box.maxX || wb.maxY < box.minY || wb.minY > box.maxY) continue
        for (let i = 0; i < w.points.length - 1; i++) {
          if (polygonHitsWire(a.points, w.points[i], w.points[i + 1], half)) for (const cls of classes) claim(wireNet?.get(w.id), cls)
        }
      }
      for (const l of labelsOf.get(sheet) ?? []) if (inBox(box, l) && pointInPolygon(a.points, l)) for (const cls of classes) claim(labelNet?.get(l.id), cls)
      for (const c of comps) {
        for (const p of schematicPins(c, findPart(c.partId))) if (!p.slot && inBox(box, p.pos) && pointInPolygon(a.points, p.pos)) for (const cls of classes) claim(conn.pinNet.get(pinKey(c.id, p.pin)), cls)
      }
    }
  }
  return [...claims.values()]
}

/** The classes of each net the labels put it in, by the net's name. */
export function labelNetClasses(project: Project, conn?: SchematicConnectivity): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const { net, cls } of labelClassClaims(project, conn)) (out.get(net) ?? out.set(net, []).get(net)!).push(cls)
  return out
}

/** Whether the rules carry anything the labels' classes made. */
const carriesLabelClasses = (rules: Project["rules"]) => !!rules.netClasses?.some((c) => c.labelNets?.length || c.implicit)

const sameList = (a: readonly string[] | undefined, b: readonly string[] | undefined) => (a?.length ?? 0) === (b?.length ?? 0) && (a ?? []).every((x, i) => x === (b as readonly string[])[i])

/**
 * The project with `NetClass.labelNets` brought up to what the labels say now: each class lists the nets a label puts in it, a class that a label names
 * and the project does not define is made (`implicit`: KiCad's class that sets no size, `NET_SETTINGS::GetEffectiveNetClass`), and one made so goes when
 * no label names it. A project with no label that names a class, and no class made by one, is returned as it is.
 */
export function withLabelNetClasses(project: Project, known?: Map<string, string[]>): Project {
  const claims = known ?? ((hasDirectives(project) || hasLabelClasses(project)) ? labelNetClasses(project) : new Map<string, string[]>())
  if (!claims.size && !carriesLabelClasses(project.rules)) return project
  const byClass = new Map<string, string[]>()
  for (const [net, classes] of claims) for (const cls of classes) (byClass.get(cls) ?? byClass.set(cls, []).get(cls)!).push(net)
  for (const nets of byClass.values()) nets.sort()
  const had = project.rules.netClasses ?? []
  const defaultName = project.rules.defaultClass?.name ?? "Default"
  const next: NetClass[] = []
  for (const c of had) {
    const nets = byClass.get(c.name)
    byClass.delete(c.name)
    if (c.implicit && !nets) continue
    if (sameList(c.labelNets, nets)) {
      next.push(c)
      continue
    }
    const { labelNets: _old, ...rest } = c
    next.push(nets ? { ...rest, labelNets: nets } : rest)
  }
  // A class a label names that the project does not define. KiCad's own Default needs none.
  for (const [cls, nets] of byClass) {
    if (cls === "Default" || cls === defaultName) continue
    if (classNameProblem({ ...project.rules, netClasses: next }, cls)) continue
    next.push({ name: cls, nets: [], labelNets: nets, implicit: true })
  }
  const unchanged = next.length === had.length && next.every((c, i) => c === had[i])
  if (unchanged) return project
  const { netClasses: _was, ...rules } = project.rules
  return { ...project, rules: next.length ? { ...rules, netClasses: next } : rules }
}

/**
 * Nets that more than one class claims, the labels' classes counted: KiCad 9 and later combine such classes by priority, which the editor's one class
 * per net does not do (`model/netClasses.ts`), so an import that finds one refuses it.
 */
export function labelClassConflicts(project: Project, claims: Map<string, string[]> = labelNetClasses(project)): string[] {
  const out: string[] = []
  const classes = project.rules.netClasses ?? []
  for (const [net, names] of claims) {
    const claimed = new Set(names)
    for (const c of classes) if (!c.implicit && (c.nets.includes(net) || (c.patterns ?? []).some((p) => patternMatcher(p)(net)))) claimed.add(c.name)
    if (names.length > 1) out.push(net)
    else if (claimed.size > 1) out.push(net)
  }
  return out
}

/**
 * What the store does after an edit: the classes the labels give are brought up to date when the edit could have changed them (a directive label
 * moved, added or deleted, a wire, label or part of the schematic changed, or the classes themselves), and left alone otherwise. A project that has no
 * directive label, no label that names a class and no class made by one is returned as it is, whatever the edit.
 */
export function settleLabelNetClasses(before: Project, after: Project): Project {
  if (!hasDirectives(after) && !hasLabelClasses(after) && !carriesLabelClasses(after.rules)) return after
  if (before.drawings === after.drawings && before.rules.netClasses === after.rules.netClasses && sameSchematic(before, after)) return after
  return withLabelNetClasses(after)
}

/** What an import says about the classes labels give, and the project with them set: the conflicts it cannot hold are refusals, the rest is said. */
export function settleImportedLabelClasses(project: Project, report: { entries: { code: string; severity: string; object: string; why: string; count?: number }[] }): Project {
  const directives = (project.drawings ?? []).filter(isDirective)
  const fields = [...directives.flatMap((d) => d.fields), ...project.labels.flatMap((l) => l.fields ?? [])]
  if (!directives.length && !fields.some((f) => isNetclassFieldName(f.name))) return project
  // The project import settles twice (the sheet's own import, then the merged project): an entry already said is not said again.
  const say = (e: { code: string; severity: string; object: string; why: string; count?: number }) => {
    if (!report.entries.some((x) => x.code === e.code && x.object === e.object)) report.entries.push(e)
  }
  const claims = labelNetClasses(project)
  for (const net of labelClassConflicts(project, claims)) {
    say({
      code: "netclass-conflict",
      severity: "refused",
      object: `the net ${net}`,
      why: `More than one net class claims it (a directive label and another label, the net class settings of the project, or a pattern). KiCad combines classes by priority, which the editor does not do yet (X10): a net is in one class, so the import does not guess which.`,
    })
  }
  const translated = [...new Set(fields.filter((f) => isNetclassFieldName(f.name) && !isPlainNetclassFieldName(f.name)).map((f) => f.name))]
  if (translated.length) {
    say({
      code: "netclass-field-translated",
      severity: "note",
      object: `${translated.length === 1 ? "a property" : "properties"} named ${translated.slice(0, 3).map((n) => `"${n}"`).join(", ")}`,
      why: `${translated.length === 1 ? "It is" : "They are"} the name "Net Class" in another language, which KiCad writes in the language of its interface. KiCad 9 and 10 read it as the net class only in that language, and a later development build reads it in every language; the importer reads it as the net class.`,
      count: translated.length,
    })
  }
  const components = fields.filter((f) => f.name === COMPONENT_CLASS_FIELD && f.value !== "")
  if (components.length) {
    say({
      code: "component-class-not-used",
      severity: "note",
      object: `${components.length} "Component Class" propert${components.length === 1 ? "y" : "ies"} (${[...new Set(components.map((f) => f.value))].slice(0, 4).join(", ")})`,
      why: "They are kept on the labels and written back, and the editor uses no component class: KiCad's custom design rules (.kicad_dru, kept as text) are the only thing that reads one.",
      count: components.length,
    })
  }
  return withLabelNetClasses(project, claims)
}

// ---------- Editing a directive label ----------

/** Where a new field sits on a directive label: beside the end of its pin, KiCad's autoplace puts it there (`SCH_DIRECTIVE_LABEL::AutoplaceFields`). */
function defaultFieldPlace(d: Pick<DrawingDirective, "x" | "y" | "rot" | "shape" | "length">): LabelField["place"] {
  const end = directiveShape(d).bulk[2] ?? { x: d.x, y: d.y }
  return { x: Math.round((end.x - d.x + 0.06) * 1e6) / 1e6, y: Math.round((end.y - d.y) * 1e6) / 1e6, angle: 0, h: "left" }
}

/** The directive with the class its `Netclass` field names set (the first such field; one is added when there is none). An empty class empties the field. */
export function setDirectiveClass(d: DrawingDirective, cls: string): DrawingDirective {
  const i = d.fields.findIndex((f) => isNetclassFieldName(f.name))
  if (i >= 0) return d.fields[i].value === cls ? d : { ...d, fields: d.fields.map((f, k) => (k === i ? { ...f, value: cls } : f)) }
  if (cls === "") return d
  return { ...d, fields: [...d.fields, { name: "Netclass", value: cls, place: defaultFieldPlace(d) }] }
}

/** The directive with another flag shape or another pin length. */
export function setDirectiveShape(d: DrawingDirective, shape: DirectiveShape): DrawingDirective {
  return d.shape === shape ? d : { ...d, shape }
}

export function setDirectiveLength(d: DrawingDirective, length: number): DrawingDirective {
  return Number.isFinite(length) && length >= 0 && length !== d.length ? { ...d, length } : d
}

/** A new directive label at a point: a round flag on KiCad's own 100 mil pin, naming a net class. */
export function newDirective(at: Vec2, cls: string, rot: Rotation = 0): Omit<DrawingDirective, "id"> {
  const base = { type: "directive" as const, text: "", x: at.x, y: at.y, rot, shape: "round" as const, length: 0.2, fields: [] as LabelField[] }
  return setDirectiveClass({ ...base, id: "" }, cls) as Omit<DrawingDirective, "id">
}
