import { pointOnSegment, samePoint } from "../lib/geometry"
import { numeric, plain } from "../lib/natural"
import { findPart } from "./library"
import { isSchematicPart, powerNetName, schematicPins, unitOwners, type WorldPin } from "./instances"
import { DRIVER, NO_NET, bestDriver, driverName, pinFacts, pinNetName, unitSuffix, type NameDriver, type PinFact } from "./netNames"
import { ROOT_SHEET, isHierarchical, sheetIdOf, sheetUses, symbolsOnSheet, useAt, useOfSymbol, type SheetUse } from "./sheets"
import type { ComponentInstance, Net, NetLabel, PartDef, Project, Vec2, Wire } from "./types"

export class UnionFind {
  private parent = new Map<string, string>()
  find(a: string): string {
    if (!this.parent.has(a)) {
      this.parent.set(a, a)
      return a
    }
    let root = a
    while (this.parent.get(root) !== root) root = this.parent.get(root)!
    while (a !== root) {
      const next = this.parent.get(a)!
      this.parent.set(a, root)
      a = next
    }
    return root
  }
  union(a: string, b: string) {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(ra, rb)
  }
  keys() {
    return [...this.parent.keys()]
  }
}

export interface SchematicConnectivity {
  nets: Net[]
  /** "componentId:pin" -> net id */
  pinNet: Map<string, string>
  wireNet: Map<string, string>
  labelNet: Map<string, string>
  junctions: Vec2[]
  /** Pins of physical parts not connected to anything. */
  unconnectedPins: WorldPin[]
  /** Unconnected pins marked no-connect on purpose. */
  ncPins: WorldPin[]
  /** Net names that were merged with a differently named net. */
  conflicts: { names: string[]; netId: string }[]
  /**
   * S1: for a project with sheet symbols, what each use of a sheet has: its wires' and labels' nets by id and its junction dots. A sheet used
   * twice has the same wire ids in both uses, so the plain maps above hold only the first. Absent for a project of one sheet.
   */
  byUse?: { wireNet: Map<string, Map<string, string>>; labelNet: Map<string, Map<string, string>>; junctions: Map<string, Vec2[]> }
}

export const pinKey = (componentId: string, pin: string) => `${componentId}:${pin}`

/**
 * What to type to name a net: the text of the label or the power symbol that gives it its name, which is
 * `NAME` for the net `/NAME` of a local label. A net nothing names, or any net of a project not named as KiCad
 * names its nets, is named by its own name.
 */
export const bareName = (net: Pick<Net, "name" | "label" | "power">) => net.label?.text ?? net.power?.text ?? net.name

/** The facts of the pins of a unit as they are for naming a net after one of them, kept per component object (a component is replaced, never edited). */
const factsCache = new WeakMap<ComponentInstance, { part: PartDef; facts: PinFact[] }>()
function factsOf(c: ComponentInstance, part: PartDef): PinFact[] {
  const hit = factsCache.get(c)
  if (hit && hit.part === part) return hit.facts
  const facts = pinFacts(c, part)
  factsCache.set(c, { part, facts })
  return facts
}

/**
 * Wire segments by the line they run along: across ones by their height, up and down ones by
 * their x, so a point finds the wires through it whatever their length. Slanted ones, which the
 * editor doesn't draw but files may hold, are always looked at.
 */
export class SegmentIndex {
  private rows = new Map<number, [number, number][]>()
  private cols = new Map<number, [number, number][]>()
  private slanted: [number, number][] = []
  constructor(wires: { points: Vec2[] }[]) {
    wires.forEach((w, wi) => {
      for (let i = 0; i < w.points.length - 1; i++) {
        const a = w.points[i]
        const b = w.points[i + 1]
        if (Math.abs(a.y - b.y) < 1e-9) push(this.rows, key(a.y), [wi, i])
        else if (Math.abs(a.x - b.x) < 1e-9) push(this.cols, key(a.x), [wi, i])
        else this.slanted.push([wi, i])
      }
    })
  }
  /** Wires with a segment that could hold the point, in wire order, each with its segments in order. */
  near(p: Vec2): [number, number[]][] {
    const hits: [number, number][] = [...this.slanted]
    const ky = key(p.y)
    const kx = key(p.x)
    for (const k of [ky - 1, ky, ky + 1]) hits.push(...(this.rows.get(k) ?? []))
    for (const k of [kx - 1, kx, kx + 1]) hits.push(...(this.cols.get(k) ?? []))
    if (!hits.length) return []
    const byWire = new Map<number, number[]>()
    for (const [wi, i] of hits) {
      const list = byWire.get(wi)
      if (!list) byWire.set(wi, [i])
      else if (!list.includes(i)) list.push(i)
    }
    return [...byWire].sort((a, b) => a[0] - b[0]).map(([wi, segs]) => [wi, segs.sort((a, b) => a - b)])
  }
}

/** A coordinate to a thousandth: a point within the editor's tolerance is in this bucket or the next. */
const key = (v: number) => Math.round(v * 1000)
function push<T>(map: Map<number, T[]>, k: number, v: T) {
  const list = map.get(k)
  if (list) list.push(v)
  else map.set(k, [v])
}

const pk = (p: Vec2) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`

/** The use of a sheet the editor's own single sheet is: the root, which KiCad writes `/`. */
const ROOT_USE: SheetUse = { path: "", sheet: ROOT_SHEET, symbol: null, parent: null, name: "", human: "/", depth: 0, page: "1" }

export function computeConnectivity(project: Project): SchematicConnectivity {
  // S2: a project named as KiCad names it picks each net's name by its driver (`netNames.ts`); any other by the editor's rule.
  const kicad = project.netNames
  // S1: with sheet symbols the project is a tree of uses of sheets; a view shows one use of it. Local names, wires and labels are per use.
  const hier = isHierarchical(project)
  const scoped = project.scope !== undefined
  const uses: SheetUse[] = scoped ? [useAt(project, project.scope!)] : hier ? sheetUses(project) : [ROOT_USE]
  const useByPath = new Map(uses.map((u) => [u.path, u]))
  const depthOf = (path: string) => (path === "" ? 0 : (useByPath.get(path)?.depth ?? useAt(project, path).depth))
  const humanOf = (path: string) => (path === "" ? "/" : (useByPath.get(path)?.human ?? useAt(project, path).human))
  const wiresOf = new Map<string, Wire[]>()
  const labelsOf = new Map<string, NetLabel[]>()
  if (hier || scoped) {
    for (const w of project.wires) (wiresOf.get(sheetIdOf(w)) ?? wiresOf.set(sheetIdOf(w), []).get(sheetIdOf(w))!).push(w)
    for (const l of project.labels) (labelsOf.get(sheetIdOf(l)) ?? labelsOf.set(sheetIdOf(l), []).get(sheetIdOf(l))!).push(l)
  } else {
    wiresOf.set(ROOT_SHEET, project.wires)
    labelsOf.set(ROOT_SHEET, project.labels)
  }
  /** Where an item of a use is a node: the root's keep the plain key, so a project with one sheet is worked out as it always was. */
  const wk = (inst: string, id: string) => (inst ? `wire:${inst}|${id}` : `wire:${id}`)
  const lk = (inst: string, id: string) => (inst ? `label:${inst}|${id}` : `label:${id}`)
  const at = (inst: string, p: Vec2) => (inst ? `${inst}@${pk(p)}` : pk(p))
  /**
   * The name a local label, a hierarchical label, a local power symbol or a sheet pin joins others by: on its own use of a sheet only.
   * (A sheet pin is on the sheet below its symbol: it joins the labels of its name there.) Such a name joins the global name of its text
   * where the same use of a sheet has one, which is how KiCad has them (the importer's measurement: `localJoinsGlobal: "same"`).
   */
  const localName = (inst: string, text: string) => `${inst}|${text}`
  /** The text of every name the sheet has, by the name it joins by; and the global names, with the uses of a sheet each is drawn on. */
  const textOfName = new Map<string, string>()
  const localNames: { inst: string; text: string }[] = []
  const globalsOn = new Map<string, Set<string>>()
  const local = (inst: string, text: string) => {
    textOfName.set(localName(inst, text), text)
    localNames.push({ inst, text })
    return localName(inst, text)
  }
  const global = (inst: string, text: string) => {
    textOfName.set(text, text)
    const on = globalsOn.get(text)
    if (on) on.add(inst)
    else globalsOn.set(text, new Set([inst]))
    return text
  }
  /** What each node of a wire or label is. */
  const itemOf = new Map<string, { inst: string; id: string }>()
  const hierDriver = hier || scoped
  /** The drivers each name text has on the sheet: labels, power symbols and hidden power pins. */
  const drivers = new Map<string, NameDriver[]>()
  const addDriver = (text: string, d: NameDriver) => {
    const list = drivers.get(text)
    if (list) list.push(d)
    else drivers.set(text, [d])
  }
  const useDrivers = !!kicad || hierDriver
  const uf = new UnionFind()
  const pins: WorldPin[] = []
  const pointOwners = new Map<string, string[]>()
  const addPointOwner = (p: Vec2, owner: string, inst = "") => {
    const key = at(inst, p)
    const list = pointOwners.get(key)
    if (list) list.push(owner)
    else pointOwners.set(key, [owner])
  }

  // A unit of a part with several is a symbol of its own; its pins are the part's pins (see `unitOwners`).
  const owners = unitOwners(project.components)
  const ownerOf = (id: string) => owners.get(id) ?? id
  /** The node of each pin, by "componentId:pin" or, for the second pin of a number that is not jumpered, "componentId:pin#1". */
  const nodeOf = new Map<WorldPin, string>()
  for (const c of project.components) {
    const part = findPart(c.partId)
    const power = powerNetName(c, part)
    const inst = c.inst ?? ""
    // The editor's own parts join the pins that share a number; a KiCad symbol keeps them apart unless it says they are jumpered.
    const jumpered = !part?.jumpers || part.jumpers.duplicates
    const here = new Set<string>()
    for (const pin of schematicPins(c, part)) {
      // A pin of the type "no connect" is on no net, whatever is drawn to it (KiCad does not connect it).
      if (pin.type === "no_connect") continue
      const key = `pin:${pinKey(c.id, pin.pin)}${pin.slot && !jumpered ? `#${pin.slot}` : ""}`
      uf.find(key)
      pins.push(pin)
      nodeOf.set(pin, key)
      here.add(pin.pin)
      addPointOwner(pin.pos, key, inst)
      // A KiCad power symbol whose Value is empty names its net nothing, which KiCad shows as `<NO NET>`.
      const portName = power === "" && kicad && part?.powerNet && part.jumpers ? NO_NET : power
      if (portName) {
        // A local power symbol is a net of its own use of a sheet (`/VCC` on the root, `/Power/VCC` below it); a global one is the project's.
        const isLocal = !!part?.powerLocal
        const nameKey = isLocal ? local(inst, portName) : global(inst, portName)
        uf.union(key, `name:${nameKey}`)
        if (useDrivers) {
          addDriver(nameKey, { prio: isLocal ? DRIVER.localPower : DRIVER.globalPower, name: driverName(portName, isLocal ? "local" : "global", humanOf(inst)), text: portName, kind: isLocal ? "local" : "global", from: "power", depth: depthOf(inst) })
        }
      }
      // A hidden power-input pin of an ordinary part is on the global net of its name (`SCH_PIN::IsGlobalPower`).
      else if (pin.hidden && pin.type === "power_in" && pin.name.trim()) {
        uf.union(key, `name:${global(inst, pin.name.trim())}`)
        if (useDrivers) addDriver(pin.name.trim(), { prio: DRIVER.globalPower, name: pin.name.trim(), text: pin.name.trim(), kind: "global", from: "power", depth: depthOf(inst) })
      }
    }
    // Pins of different numbers that the part joins inside itself.
    for (const group of part?.jumpers?.groups ?? []) {
      const present = group.filter((n) => here.has(n))
      for (let i = 1; i < present.length; i++) uf.union(`pin:${pinKey(c.id, present[0])}`, `pin:${pinKey(c.id, present[i])}`)
    }
  }

  // Wire vertices coincide with pins / other wire vertices.
  for (const use of uses) {
    for (const w of wiresOf.get(use.sheet) ?? []) {
      const key = wk(use.path, w.id)
      itemOf.set(key, { inst: use.path, id: w.id })
      uf.find(key)
      for (const p of w.points) addPointOwner(p, key, use.path)
    }
  }
  for (const use of uses) {
    for (const l of labelsOf.get(use.sheet) ?? []) {
      const key = lk(use.path, l.id)
      itemOf.set(key, { inst: use.path, id: l.id })
      const text = l.name.trim()
      const isGlobal = l.kind === "global"
      const nameKey = isGlobal ? global(use.path, text) : local(use.path, text)
      uf.union(key, `name:${nameKey}`)
      addPointOwner(l, key, use.path)
      if (useDrivers && text) {
        const kind = isGlobal ? "global" : "local"
        // KiCad 5 ranks a hierarchical label above a local one (KiCad 6 on, below it).
        const prio = isGlobal ? DRIVER.globalLabel : l.kind === "hierarchical" ? DRIVER.hierLabel : kicad === "kicad5" ? DRIVER.hierLabel - 0.5 : DRIVER.label
        addDriver(nameKey, { prio, name: driverName(text, kind, humanOf(use.path)), text, kind, from: "label", depth: use.depth, ...(l.kind === "hierarchical" ? { labelKind: "hierarchical" as const } : {}) })
      }
    }
  }
  // S1: the pins of the sheet symbols drawn on a use are nodes on it, each joined to the hierarchical labels of its name in the use of the sheet below that symbol makes.
  if (hierDriver) {
    for (const use of uses) {
      for (const sym of symbolsOnSheet(project, use.sheet)) {
        const childPath = useOfSymbol(use.path, sym)
        for (const pin of sym.pins) {
          const key = `sheetpin:${use.path}|${sym.id}|${pin.id}`
          const text = pin.name.trim()
          uf.find(key)
          addPointOwner(pin, key, use.path)
          if (!text) continue
          // A sheet pin joins the labels of its name on the sheet below its symbol, but only where that sheet has a hierarchical label of the name (KiCad does not join it to a local label; a view holds one sheet, so it cannot tell); it names the net as a label on the sheet it is drawn on would.
          if (!scoped && !(labelsOf.get(sym.child) ?? []).some((l) => l.kind === "hierarchical" && l.name.trim() === text)) continue
          const nameKey = local(childPath, text)
          uf.union(key, `name:${nameKey}`)
          // KiCad 5 names a net by a label, never by a sheet pin.
          if (useDrivers && kicad !== "kicad5") addDriver(nameKey, { prio: DRIVER.sheetPin, name: driverName(text, "local", humanOf(use.path)), text, kind: "local", from: "pin", depth: use.depth })
        }
      }
    }
  }
  // A local name joins the global name of its text where the same use of a sheet has one.
  for (const { inst, text } of localNames) if (globalsOn.get(text)?.has(inst)) uf.union(`name:${localName(inst, text)}`, `name:${text}`)
  for (const owners of pointOwners.values()) {
    for (let i = 1; i < owners.length; i++) uf.union(owners[0], owners[i])
  }

  // T-junctions: a wire endpoint, pin or label lying on another wire's segment.
  const junctionsByUse = new Map<string, Vec2[]>()
  for (const use of uses) {
    const wires = wiresOf.get(use.sheet) ?? []
    const inst = use.path
    const junctions: Vec2[] = []
    const junctionKeys = new Set<string>()
    const addJunction = (p: Vec2) => {
      const k = pk(p)
      if (!junctionKeys.has(k)) {
        junctionKeys.add(k)
        junctions.push(p)
      }
    }
    const probes: { p: Vec2; owner: string; isWireEnd: boolean }[] = []
    for (const w of wires) {
      if (w.points.length < 2) continue
      probes.push({ p: w.points[0], owner: wk(inst, w.id), isWireEnd: true })
      probes.push({ p: w.points[w.points.length - 1], owner: wk(inst, w.id), isWireEnd: true })
    }
    for (const l of labelsOf.get(use.sheet) ?? []) probes.push({ p: l, owner: lk(inst, l.id), isWireEnd: false })
    // A sheet pin on the side of a wire joins it, as a label does.
    if (hierDriver) for (const sym of symbolsOnSheet(project, use.sheet)) for (const pin of sym.pins) probes.push({ p: pin, owner: `sheetpin:${inst}|${sym.id}|${pin.id}`, isWireEnd: false })

    // Wire segments by the line they run along (`SegmentIndex`), so a probe only looks at wires
    // near it. Wires are still visited in order, and each wire's segments in order, as a plain scan
    // over all of them would.
    const segIndex = new SegmentIndex(wires)
    for (const probe of probes) {
      for (const [wi, segs] of segIndex.near(probe.p)) {
        const w = wires[wi]
        if (wk(inst, w.id) === probe.owner) continue
        for (const i of segs) {
          const a = w.points[i]
          const b = w.points[i + 1]
          if (!pointOnSegment(probe.p, a, b)) continue
          uf.union(probe.owner, wk(inst, w.id))
          if (probe.isWireEnd && !samePoint(probe.p, a) && !samePoint(probe.p, b)) addJunction(probe.p)
          break
        }
      }
    }

    // A point where three or more wire ends meet also gets a dot.
    const endCount = new Map<string, { p: Vec2; n: number }>()
    for (const w of wires) {
      if (w.points.length < 2) continue
      for (const p of [w.points[0], w.points[w.points.length - 1]]) {
        const k = pk(p)
        const e = endCount.get(k)
        if (e) e.n++
        else endCount.set(k, { p, n: 1 })
      }
    }
    for (const { p, n } of endCount.values()) {
      const pinsHere = pointOwners.get(at(inst, p))?.filter((o) => o.startsWith("pin:")).length ?? 0
      if (n + pinsHere >= 3) addJunction(p)
    }
    junctionsByUse.set(use.path, junctions)
  }
  const junctions = junctionsByUse.get(uses[0].path) ?? []

  // Group into nets.
  const groups = new Map<string, string[]>()
  for (const key of uf.keys()) {
    const root = uf.find(key)
    const g = groups.get(root)
    if (g) g.push(key)
    else groups.set(root, [key])
  }

  const nets: Net[] = []
  const pinNet = new Map<string, string>()
  const wireNet = new Map<string, string>()
  const labelNet = new Map<string, string>()
  const useWireNet = new Map<string, Map<string, string>>()
  const useLabelNet = new Map<string, Map<string, string>>()
  const firstUse = new Map<string, string>()
  for (const u of uses) if (!firstUse.has(u.sheet)) firstUse.set(u.sheet, u.path)
  const sheetOfUse = new Map(uses.map((u) => [u.path, u.sheet]))
  const conflicts: SchematicConnectivity["conflicts"] = []
  const refOf = new Map(project.components.map((c) => [c.id, c.ref]))
  const ncSet = new Set(project.components.flatMap((c) => (c.nc ?? []).map((pin) => pinKey(c.id, pin))))
  const nodeParts = new Map(project.components.map((c) => [c.id, c]))
  const labelCount = (members: string[]) => members.filter((m) => m.startsWith("label:")).length
  const physical = new Set(project.components.filter((c) => isSchematicPart(findPart(c.partId))).map((c) => c.id))
  /** The net of every pin node, including the second pin of a number. */
  const nodeNet = new Map<string, string>()
  const split = (k: string) => {
    const idx = k.lastIndexOf(":")
    const pin = k.slice(idx + 1)
    const hash = pin.indexOf("#")
    return { componentId: k.slice(0, idx), pin: hash < 0 ? pin : pin.slice(0, hash), second: hash >= 0 }
  }
  let autoIndex = 1

  const sortedGroups = [...groups.values()].sort((a, b) => plain.compare(a[0], b[0]))
  /** A unit's pins are the part's: a pin of a unit is listed under the component that is on the board. */
  const listed = (k: string) => {
    const { componentId, pin } = split(k)
    return { componentId: ownerOf(componentId), pin }
  }
  const aliased: [string, string][] = []
  for (const members of sortedGroups) {
    const pinMembers = members.filter((m) => m.startsWith("pin:")).map((m) => m.slice(4))
    const hasWire = members.some((m) => m.startsWith("wire:") || m.startsWith("label:"))
    const nameKeys = [...new Set(members.filter((m) => m.startsWith("name:")).map((m) => m.slice(5)))].filter((k) => !!textOfName.get(k))
    // The texts, as the editor has always compared them: the sorted names without the use of a sheet they are on.
    const names = [...new Set(nameKeys.map((k) => textOfName.get(k)!))].sort()
    if (pinMembers.length === 0 && !hasWire) continue
    if (pinMembers.length === 1 && !hasWire && names.length === 0) continue

    const seenPins = new Set<string>()
    const netPins = pinMembers
      .map(listed)
      .filter((p) => {
        const k = pinKey(p.componentId, p.pin)
        if (seenPins.has(k)) return false
        seenPins.add(k)
        return physical.has(p.componentId)
      })
      .sort((a, b) => {
        const ra = refOf.get(a.componentId) ?? ""
        const rb = refOf.get(b.componentId) ?? ""
        return numeric.compare(ra, rb) || numeric.compare(a.pin, b.pin)
      })

    let name: string
    let label: Net["label"]
    let power: Net["power"]
    let named = names.length > 0
    // The driver of the highest priority names the net; with none, a pin does (S2). A project drawn in the editor with several sheets is named the same way where a driver is.
    const best = useDrivers ? bestDriver(nameKeys.flatMap((n) => drivers.get(n) ?? []), kicad === "kicad5") : undefined
    if (kicad) {
      if (best) {
        name = best.name
        named = true
        if (best.from === "label") label = { text: best.text, kind: best.labelKind ?? best.kind }
        else if (best.from === "power") power = { text: best.text, local: best.kind === "local" }
      } else {
        named = false
        name = kicadPinName(kicad, pinMembers, labelCount(members), ownerOf, nodeParts, refOf, physical, ncSet) ?? `N$${autoIndex++}`
      }
    } else if (names.length) {
      name = best && hierDriver ? best.name : names[0]
      if (best && hierDriver && best.from === "label") label = { text: best.text, kind: best.labelKind ?? best.kind }
    } else if (netPins.length) {
      name = `Net-(${refOf.get(netPins[0].componentId)}-${netPins[0].pin})`
    } else {
      name = `N$${autoIndex++}`
    }
    let id = `net:${name}`
    // Two nets that KiCad's rules give one name (a local and a global label of one text on no common wire) stay two nets.
    for (let i = 2; (kicad || hierDriver) && nets.some((n) => n.id === id); i++) id = `net:${name}#${i}`
    if (useDrivers) {
      const texts = [...new Set(nameKeys.flatMap((n) => (drivers.get(n) ?? []).map((d) => d.text)))].sort()
      if (texts.length > 1) conflicts.push({ names: texts, netId: id })
    } else if (names.length > 1) conflicts.push({ names, netId: id })
    nets.push({ id, name, named, pins: netPins, ...(label ? { label } : {}), ...(power ? { power } : {}) })
    for (const m of members) {
      if (m.startsWith("pin:")) {
        const key = m.slice(4)
        nodeNet.set(key, id)
        const { componentId, pin, second } = split(key)
        // The second pin of a number a symbol keeps apart has a key of its own, `<id>:<pin>#<slot>`.
        pinNet.set(key, id)
        if (second) continue
        // The pin of a unit is also a pin of the part on the board.
        if (ownerOf(componentId) !== componentId) aliased.push([pinKey(ownerOf(componentId), pin), id])
      } else if (m.startsWith("wire:") || m.startsWith("label:")) {
        const item = itemOf.get(m)
        if (!item) continue
        const isWire = m.startsWith("wire:")
        const byUse = isWire ? useWireNet : useLabelNet
        const own = byUse.get(item.inst) ?? byUse.set(item.inst, new Map()).get(item.inst)!
        own.set(item.id, id)
        // The plain maps hold the first use of each sheet, which is the only one for a sheet used once.
        if (firstUse.get(sheetOfUse.get(item.inst) ?? ROOT_SHEET) === item.inst) (isWire ? wireNet : labelNet).set(item.id, id)
      }
    }
  }
  // A pin the part's own symbol does not draw is the pin of the unit that does. Where both draw it, its own net stands.
  for (const [key, id] of aliased) if (!pinNet.has(key)) pinNet.set(key, id)

  const netById = new Map(nets.map((n) => [n.id, n]))
  const floating = pins.filter((p) => {
    if (!physical.has(ownerOf(p.componentId))) return false
    const netId = nodeNet.get(nodeOf.get(p)!.slice(4))
    if (!netId) return true
    const net = netById.get(netId)
    return !!net && net.pins.length < 2 && !net.named
  })
  const isNc = (p: WorldPin) => ncSet.has(pinKey(p.componentId, p.pin))
  const unconnectedPins = floating.filter((p) => !isNc(p))
  const ncPins = floating.filter(isNc)

  nets.sort((a, b) => numeric.compare(a.name, b.name))
  return { nets, pinNet, wireNet, labelNet, junctions, unconnectedPins, ncPins, conflicts, ...(hier || scoped ? { byUse: { wireNet: useWireNet, labelNet: useLabelNet, junctions: junctionsByUse } } : {}) }
}

/**
 * The name of a net no label or power symbol names, as KiCad makes it from its pins: the pin among the
 * net's drivers whose `Net-(R1-Pad2)` sorts first, names with `-Pad` last (`candidate_cmp`). A net with a
 * pin and nothing else on it, or a no-connect flag, is `unconnected-(...)`. A pin of a symbol that is not
 * on the board, or whose reference is `#...`, is no candidate (`ResolveDrivers`).
 */
function kicadPinName(
  rule: "kicad" | "kicad6" | "kicad5",
  pinMembers: string[],
  labels: number,
  ownerOf: (id: string) => string,
  byId: Map<string, ComponentInstance>,
  refOf: Map<string, string>,
  physical: Set<string>,
  ncSet: Set<string>,
): string | null {
  const bare = (m: string) => m.replace(/#\d+$/, "")
  const unconnected = (pinMembers.length === 1 && labels === 0) || pinMembers.some((m) => ncSet.has(bare(m)))
  const names: string[] = []
  for (const m of pinMembers) {
    const i = m.lastIndexOf(":")
    const cid = m.slice(0, i)
    const number = bare(m.slice(i + 1))
    const c = byId.get(cid)
    const part = c && findPart(c.partId)
    if (!c || !part || !physical.has(ownerOf(cid)) || c.flags?.onBoard === false || refOf.get(cid)?.startsWith("#")) continue
    const facts = factsOf(c, part)
    const fact = facts.find((f) => f.number === number)
    if (!fact) continue
    // A symbol with no annotation (`U?`) is named by its uuid in KiCad; the editor has the symbol's id, which is as much its own, so two unannotated nets never share a name.
    names.push(pinNetName(rule, refOf.get(cid) ?? "", unitSuffix(c, part), fact, facts, unconnected, c.id))
  }
  if (!names.length) return null
  names.sort((a, b) => Number(a.includes("-Pad")) - Number(b.includes("-Pad")) || (a < b ? -1 : a > b ? 1 : 0))
  return names[0]
}
