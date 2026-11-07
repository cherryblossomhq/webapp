import { describe, expect, it } from "vitest"
import { altiumFiles, altiumNetNames } from "../src/export/altium"
import { computeConnectivity, pinKey } from "../src/model/connectivity"
import { isSchematicPart, pcbPads } from "../src/model/instances"
import { findPart } from "../src/model/library"
import { onBoard } from "../src/model/partFlags"
import { resolvedComponents, withRuleAreaFlags } from "../src/model/ruleAreas"
import { copperCount } from "../src/model/stack"
import type { Project, Vec2 } from "../src/model/types"
import { binaryRecords, milProp, propRecords, readPads, readRegions, readStreams, readTexts, readTracks, readVias, ruleRecords, schCoord, schRecords, type Props } from "./altium/read"
import { built } from "./built"
import { imp } from "./kicad-sheets-fixtures"

// There is no Altium here to open the files, so these read them back as KiCad's Altium importer reads them (the compound file by SheetJS's reader,
// not the writer's own), and hold every pad, track, via and pin to the project. `altium-kicad.test.ts` has KiCad itself read the board.

const EXAMPLES = ["blinker", "regulator", "mcu", "node", "esp32-robot"]
const exported = new Map<string, Awaited<ReturnType<typeof altiumFiles>>>()
async function files(id: string) {
  let hit = exported.get(id)
  if (!hit) exported.set(id, (hit = await altiumFiles(built(id))))
  return hit
}
const bytesOf = (f: Record<string, Uint8Array | string>, ext: string) => Object.entries(f).find(([n]) => n.endsWith(ext))![1] as Uint8Array

/** The board's streams, its origin (where the editor's origin is) and its nets by index. */
function board(bytes: Uint8Array) {
  const s = readStreams(bytes)
  const b = propRecords(s.get("Board6/Data")!)[0]
  const origin = { x: milProp(b.get("ORIGINX")), y: milProp(b.get("ORIGINY")) }
  const nets = propRecords(s.get("Nets6/Data")!).map((n) => n.get("NAME")!)
  const at = (p: Vec2) => ({ x: p.x - origin.x, y: p.y - origin.y })
  return { s, b, origin, nets, at }
}

const near = (a: number, b: number, tol = 1e-4) => Math.abs(a - b) <= tol

describe("altiumFiles", () => {
  it("writes a schematic, a board and a project that lists them", async () => {
    const { files: f } = await files("blinker")
    expect(Object.keys(f).sort()).toEqual(["555-led-blinker.PcbDoc", "555-led-blinker.PrjPcb", "555-led-blinker.SchDoc"])
    const prj = f["555-led-blinker.PrjPcb"] as string
    expect(prj).toMatch(/^\[Design\]\r\n/)
    expect(prj).toContain("DocumentPath=555-led-blinker.SchDoc")
    expect(prj).toContain("DocumentPath=555-led-blinker.PcbDoc")
  }, 120_000)

  it("writes compound files with every storage's count in its header", async () => {
    const { files: f } = await files("blinker")
    const s = readStreams(bytesOf(f, ".PcbDoc"))
    const header = (n: string) => new DataView(s.get(`${n}/Header`)!.buffer).getUint32(0, true)
    expect(new TextDecoder("utf-16le").decode(s.get("FileHeader")!.subarray(4))).toBe("PCB 5.0 Bi")
    for (const n of ["Board6", "Nets6", "Components6", "Polygons6", "Classes6"]) expect(header(n), n).toBe(propRecords(s.get(`${n}/Data`)!).length)
    for (const n of ["Pads6", "Vias6", "Tracks6", "Arcs6", "Texts6", "Regions6"]) expect(header(n), n).toBe(binaryRecords(s.get(`${n}/Data`)!).length)
    expect(header("Rules6")).toBe(ruleRecords(s.get("Rules6/Data")!).length)
    const sch = schRecords(bytesOf(f, ".SchDoc"))
    expect(sch[0].get("HEADER")).toBe("Protel for Windows - Schematic Capture Binary File Version 5.0")
    expect(Number(sch[0].get("WEIGHT"))).toBe(sch.length - 1)
    expect(sch[1].get("RECORD")).toBe("31")
  }, 120_000)

  it("writes primitives in Altium 14's layout: a 120-byte pad, 45-byte track, 56-byte arc, 209-byte via and 230-byte text", async () => {
    const { s } = board(bytesOf((await files("esp32-robot")).files, ".PcbDoc"))
    expect(new Set(binaryRecords(s.get("Pads6/Data")!).map((r) => r.subs[4].byteLength))).toEqual(new Set([120]))
    expect(new Set(readTracks(s.get("Tracks6/Data")!).map((t) => t.length))).toEqual(new Set([45]))
    for (const r of binaryRecords(s.get("Arcs6/Data")!)) expect(r.subs[0].byteLength).toBe(56)
    expect(new Set(readVias(s.get("Vias6/Data")!).map((v) => v.length))).toEqual(new Set([209]))
    expect(new Set(readTexts(s.get("Texts6/Data")!, s.get("WideStrings6/Data")!).map((t) => t.length))).toEqual(new Set([230]))
    // A region's record ends where its last hole's vertices end.
    for (const r of readRegions(s.get("Regions6/Data")!)) expect(r.end).toBe(r.length)
  }, 120_000)

  for (const id of EXAMPLES) {
    it(`puts every pad of ${id} where the board has it, with its size, hole and net`, async () => {
      const source = built(id)
      const project = withRuleAreaFlags(source)
      const sch = computeConnectivity(project)
      const names = altiumNetNames(sch.nets)
      const { s, nets, at } = board(bytesOf((await files(id)).files, ".PcbDoc"))
      const comps = propRecords(s.get("Components6/Data")!)
      const pads = readPads(s.get("Pads6/Data")!)
      let checked = 0
      for (const c of resolvedComponents(project).filter((x) => x.pcb.placed && onBoard(x))) {
        const ci = comps.findIndex((r) => r.get("SOURCEDESIGNATOR") === c.ref)
        if (ci < 0) continue
        expect(comps[ci].get("PATTERN")).toBe(c.footprint)
        const mine = pads.filter((p) => p.component === ci)
        const want = pcbPads(c, copperCount(project.board))
        expect(mine.length, c.ref).toBe(want.length)
        for (const pad of want) {
          const hole = pad.hole ?? pad
          const got = mine.find((p) => p.name === (pad.padNumber ?? "") && near(at(p).x, hole.x) && near(at(p).y, hole.y))
          expect(got, `${c.ref}.${pad.padNumber}`).toBeDefined()
          if (pad.shape !== "polygon" || pad.oriented) {
            expect(near(got!.w, pad.oriented?.width ?? pad.width), `${c.ref}.${pad.padNumber} width`).toBe(true)
            expect(near(got!.h, pad.oriented?.height ?? pad.height), `${c.ref}.${pad.padNumber} height`).toBe(true)
          }
          expect(near(got!.hole, pad.holeDiameter ?? 0)).toBe(true)
          expect(got!.plated).toBe(pad.plated !== false)
          const net = pad.pin && pad.plated !== false ? sch.pinNet.get(pinKey(c.id, pad.pin)) : undefined
          const named = net ? names.get(net) : undefined
          // A pad on a net of its own (one pin) is on the net Altium would name too; one on none has none.
          if (named && sch.nets.find((n) => n.id === net)!.pins.length > 1) expect(nets[got!.net], `${c.ref}.${pad.padNumber}`).toBe(named)
          checked++
        }
      }
      expect(checked).toBeGreaterThan(10)
    }, 120_000)
  }

  it("routes the board as it is: every track segment, arc and via, on its layer and net", async () => {
    const source = built("esp32-robot")
    const { s, nets, at } = board(bytesOf((await files("esp32-robot")).files, ".PcbDoc"))
    const tracks = readTracks(s.get("Tracks6/Data")!).filter((t) => t.layer === 1 || t.layer === 32)
    const copperTracks = tracks.filter((t) => t.component === 0xffff)
    let segments = 0
    for (const t of source.traces) {
      for (let i = 0; i + 1 < t.points.length; i++) {
        segments++
        const a = t.points[i]
        const b = t.points[i + 1]
        const layer = t.layer === "top" ? 1 : 32
        const hit = copperTracks.find((x) => x.layer === layer && near(at(x.a).x, a.x) && near(at(x.a).y, a.y) && near(at(x.b).x, b.x) && near(at(x.b).y, b.y))
        expect(hit, `${t.id}:${i}`).toBeDefined()
        expect(near(hit!.width, t.width)).toBe(true)
        expect(hit!.net).not.toBe(0xffff)
      }
    }
    expect(segments).toBeGreaterThan(50)
    const vias = readVias(s.get("Vias6/Data")!)
    expect(vias).toHaveLength(source.vias.length)
    for (const v of source.vias) {
      const got = vias.find((x) => near(at(x).x, v.x) && near(at(x).y, v.y))!
      expect(got).toBeDefined()
      expect(near(got.diameter, v.diameter) && near(got.hole, v.drill)).toBe(true)
      expect([got.from, got.to]).toEqual([1, 32])
      expect(nets[got.net]).toBeDefined()
    }
  }, 120_000)

  it("pours each zone as a polygon on its net and layer, filled with the copper the editor filled it with", async () => {
    const source = built("blinker")
    const { s, nets } = board(bytesOf((await files("blinker")).files, ".PcbDoc"))
    const polygons = propRecords(s.get("Polygons6/Data")!)
    expect(polygons).toHaveLength(source.zones.length)
    for (const [i, p] of polygons.entries()) {
      expect(nets[Number(p.get("NET"))]).toBe("GND")
      expect(p.get("POLYGONTYPE")).toBe("Polygon")
      expect(readRegions(s.get("Regions6/Data")!).some((r) => r.polygon === i && r.outline.length > 3)).toBe(true)
    }
    expect(polygons.map((p) => p.get("LAYER")).sort()).toEqual(["BOTTOM", "TOP"])
  }, 120_000)

  it("writes the design rules Altium checks by, a pour's clearance first", async () => {
    const source = built("blinker")
    const { s } = board(bytesOf((await files("blinker")).files, ".PcbDoc"))
    const rules = ruleRecords(s.get("Rules6/Data")!)
    const rule = (name: string) => rules.find((r) => r.props.get("NAME") === name)!.props
    expect(milProp(rule("Clearance").get("GAP"))).toBeCloseTo(source.rules.clearance, 4)
    expect(rule("Clearance_Pours").get("SCOPE1EXPRESSION")).toBe("IsPolygon")
    expect(Number(rule("Clearance_Pours").get("PRIORITY"))).toBeLessThan(Number(rule("Clearance").get("PRIORITY")))
    expect(milProp(rule("Width").get("PREFEREDWIDTH"))).toBeCloseTo(source.rules.traceWidth, 4)
    expect(milProp(rule("RoutingVias").get("WIDTH"))).toBeCloseTo(source.rules.viaDiameter, 4)
    expect(milProp(rule("BoardOutlineClearance").get("GAP"))).toBeCloseTo(source.rules.edgeClearance, 4)
    expect(rules.find((r) => r.props.get("NAME") === "BoardOutlineClearance")!.kind).toBe(63)
  }, 120_000)

  it("labels each part with its designator and links it to the schematic's part", async () => {
    const { files: f } = await files("mcu")
    const { s } = board(bytesOf(f, ".PcbDoc"))
    const comps = propRecords(s.get("Components6/Data")!)
    const texts = readTexts(s.get("Texts6/Data")!, s.get("WideStrings6/Data")!)
    const sch = schRecords(bytesOf(f, ".SchDoc")).slice(1)
    const schIds = new Map(sch.filter((r) => r.get("RECORD") === "1").map((r) => [r.get("UNIQUEID"), r]))
    for (const [i, c] of comps.entries()) {
      expect(texts.some((t) => t.designator && t.component === i && t.text === c.get("SOURCEDESIGNATOR"))).toBe(true)
      expect(schIds.has(c.get("SOURCEUNIQUEID")!.replace(/^\\/, ""))).toBe(true)
    }
  }, 120_000)
})

// ---------- the schematic, read back as Altium joins it ----------

const DIRS: Vec2[] = [
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 0, y: -1 },
]

class Union {
  private parent = new Map<string, string>()
  find(k: string): string {
    let p = this.parent.get(k) ?? k
    if (p !== k) {
      p = this.find(p)
      this.parent.set(k, p)
    }
    return p
  }
  join(a: string, b: string) {
    const x = this.find(a)
    const y = this.find(b)
    if (x !== y) this.parent.set(x, y)
  }
}

const key = (p: Vec2) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`
const onSegment = (p: Vec2, a: Vec2, b: Vec2) => {
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
  if (Math.abs(cross) > 1e-3 * Math.hypot(b.x - a.x, b.y - a.y)) return false
  return p.x >= Math.min(a.x, b.x) - 1e-3 && p.x <= Math.max(a.x, b.x) + 1e-3 && p.y >= Math.min(a.y, b.y) - 1e-3 && p.y <= Math.max(a.y, b.y) + 1e-3
}
const at = (r: Props) => ({ x: schCoord(r, "LOCATION.X"), y: schCoord(r, "LOCATION.Y") })

/**
 * The pins each net of the sheets joins, as Altium joins them: a pin's tip (its location and length the way it points), a wire through a point,
 * net labels of one text on one sheet, power ports of one text anywhere, a port with the sheet entry of its name on the sheet symbol for its file.
 */
function schematicNets(sheets: Map<string, Props[]>): Map<string, string> {
  const u = new Union()
  const pins: [string, string][] = []
  for (const [file, all] of sheets) {
    const records = all.slice(1)
    const points: { k: string; p: Vec2 }[] = []
    const designator = new Map<number, string>()
    records.forEach((r) => {
      if (r.get("RECORD") === "34") designator.set(Number(r.get("OWNERINDEX")), r.get("TEXT")!)
    })
    records.forEach((r, i) => {
      const kind = r.get("RECORD")
      const node = `${file}#${i}`
      if (kind === "2") {
        const conglomerate = Number(r.get("PINCONGLOMERATE"))
        const d = DIRS[conglomerate & 3]
        const len = schCoord(r, "PINLENGTH")
        const base = at(r)
        const tip = { x: base.x + d.x * len, y: base.y + d.y * len }
        points.push({ k: node, p: tip })
        pins.push([`${designator.get(Number(r.get("OWNERINDEX")))}:${r.get("DESIGNATOR")}`, node])
      } else if (kind === "25") {
        points.push({ k: node, p: at(r) })
        u.join(node, `label:${file}:${r.get("TEXT")}`)
      } else if (kind === "17") {
        points.push({ k: node, p: at(r) })
        u.join(node, `power:${r.get("TEXT")}`)
      } else if (kind === "18") {
        const p = at(r)
        const w = Number(r.get("WIDTH"))
        const vertical = Number(r.get("STYLE")) >= 4
        points.push({ k: node, p }, { k: node, p: vertical ? { x: p.x, y: p.y + w } : { x: p.x + w, y: p.y } })
        u.join(node, `port:${file}:${r.get("NAME")}`)
      } else if (kind === "16") {
        const sym = records[Number(r.get("OWNERINDEX"))]
        const tl = at(sym)
        const side = Number(r.get("SIDE") ?? 0)
        const d = Number(r.get("DISTANCEFROMTOP")) * 10 + Number(r.get("DISTANCEFROMTOP_FRAC1") ?? 0) / 100000
        const w = schCoord(sym, "XSIZE")
        const h = schCoord(sym, "YSIZE")
        const p = side === 0 ? { x: tl.x, y: tl.y - d } : side === 1 ? { x: tl.x + w, y: tl.y - d } : side === 2 ? { x: tl.x + d, y: tl.y } : { x: tl.x + d, y: tl.y - h }
        points.push({ k: node, p })
        const child = records.find((x) => x.get("RECORD") === "33" && Number(x.get("OWNERINDEX")) === Number(r.get("OWNERINDEX")))
        u.join(node, `port:${child?.get("TEXT")}:${r.get("NAME")}`)
      } else if (kind === "29") points.push({ k: node, p: at(r) })
    })
    const wires = records.map((r, i) => ({ r, i })).filter(({ r }) => r.get("RECORD") === "27")
    for (const { r, i } of wires) {
      const n = Number(r.get("LOCATIONCOUNT"))
      const pts = Array.from({ length: n }, (_, k) => ({ x: schCoord(r, `X${k + 1}`), y: schCoord(r, `Y${k + 1}`) }))
      const node = `${file}#${i}`
      for (const q of points) if (pts.some((a, k) => k + 1 < n && onSegment(q.p, a, pts[k + 1]))) u.join(node, q.k)
      // A wire's end on another wire joins them; two wires that only cross do not.
      for (const { r: o, i: j } of wires) {
        if (j === i) continue
        const m = Number(o.get("LOCATIONCOUNT"))
        const other = Array.from({ length: m }, (_, k) => ({ x: schCoord(o, `X${k + 1}`), y: schCoord(o, `Y${k + 1}`) }))
        for (const end of [pts[0], pts[n - 1]]) if (other.some((a, k) => k + 1 < m && onSegment(end, a, other[k + 1]))) u.join(node, `${file}#${j}`)
      }
    }
    // Points that meet without a wire: a pin's tip on a label or a port.
    const byPoint = new Map<string, string>()
    for (const q of points) {
      const k = key(q.p)
      const seen = byPoint.get(k)
      if (seen) u.join(seen, q.k)
      else byPoint.set(k, q.k)
    }
  }
  return new Map(pins.map(([pin, node]) => [pin, u.find(node)]))
}

/** Every pin of a schematic part the project joins to another, by "REF:PIN", and the net it is on. */
function projectNets(project: Project): { pin: string; net: string }[] {
  const out: { pin: string; net: string }[] = []
  const ref = new Map(project.components.map((c) => [c.id, c]))
  for (const n of computeConnectivity(project).nets) {
    const pins = n.pins.filter((p) => isSchematicPart(findPart(ref.get(p.componentId)!.partId)))
    if (pins.length < 2) continue
    for (const p of pins) out.push({ pin: `${ref.get(p.componentId)!.ref}:${p.pin}`, net: n.id })
  }
  return out
}

function expectSameNets(project: Project, sheets: Map<string, Props[]>, least = 4) {
  const got = schematicNets(sheets)
  const want = projectNets(project)
  expect(want.length).toBeGreaterThanOrEqual(least)
  const groupOf = new Map<string, string>()
  for (const { pin, net } of want) {
    const g = got.get(pin)
    expect(g, pin).toBeDefined()
    const seen = groupOf.get(net)
    if (seen) expect(g, `${pin} joins the other pins of its net`).toBe(seen)
    else groupOf.set(net, g!)
  }
  // ...and no two nets are one.
  expect(new Set(groupOf.values()).size).toBe(groupOf.size)
}

describe("altiumFiles: the schematic", () => {
  for (const id of EXAMPLES) {
    it(`joins the pins of ${id} as the project does`, async () => {
      const { files: f } = await files(id)
      const name = Object.keys(f).find((n) => n.endsWith(".SchDoc"))!
      expectSameNets(built(id), new Map([[name, schRecords(f[name] as Uint8Array)]]))
    }, 120_000)
  }

  it("writes a part's pins with their tips where the project's are, its footprint by the board's name for it, and its value as its comment", async () => {
    const project = built("blinker")
    const { files: f } = await files("blinker")
    const records = schRecords(bytesOf(f, ".SchDoc")).slice(1)
    const u1 = records.findIndex((r) => r.get("RECORD") === "34" && r.get("TEXT") === "U1")
    const owner = Number(records[u1].get("OWNERINDEX"))
    const kids = records.filter((r) => Number(r.get("OWNERINDEX")) === owner)
    const c = project.components.find((x) => x.ref === "U1")!
    expect(kids.filter((r) => r.get("RECORD") === "2").map((r) => r.get("DESIGNATOR")).sort()).toEqual(findPart(c.partId)!.pins.map((p) => p.number).sort())
    expect(kids.find((r) => r.get("RECORD") === "41" && r.get("NAME") === "Comment")!.get("TEXT")).toBe("NE555")
    const list = records.findIndex((r) => r.get("RECORD") === "44" && Number(r.get("OWNERINDEX")) === owner)
    expect(records.find((r) => r.get("RECORD") === "45" && Number(r.get("OWNERINDEX")) === list)!.get("MODELNAME")).toBe(c.footprint)
  }, 120_000)

  it("joins a sheet's port to the sheet entry of its name, a schematic for each sheet", async () => {
    const { project } = imp()
    const { files: f } = await altiumFiles(project)
    const sheets = new Map(Object.entries(f).filter(([n]) => n.endsWith(".SchDoc")).map(([n, b]) => [n, schRecords(b as Uint8Array)]))
    expect(sheets.size).toBe(2)
    const records = [...sheets.values()].flat()
    expect(records.some((r) => r.get("RECORD") === "15")).toBe(true)
    expect(records.some((r) => r.get("RECORD") === "18" && r.get("NAME") === "VIN")).toBe(true)
    expectSameNets(project, sheets, 2)
    // The sheet symbol names the file of the sheet it stands for, which the project lists.
    const root = sheets.get(Object.keys(f).find((n) => n.endsWith(".SchDoc") && !n.startsWith("power"))!)!
    const file = root.find((r) => r.get("RECORD") === "33")!.get("TEXT")!
    expect(sheets.has(file)).toBe(true)
    expect(f[Object.keys(f).find((n) => n.endsWith(".PrjPcb"))!]).toContain(`DocumentPath=${file}`)
  }, 120_000)

  it("keeps a name Windows-1252 cannot hold in UTF-8 beside it", async () => {
    const source = built("blinker")
    const project: Project = { ...source, labels: source.labels.map((l, i) => (i === 0 ? { ...l, name: "VΩ_µ" } : l)) }
    const { files: f } = await altiumFiles(project)
    const label = schRecords(bytesOf(f, ".SchDoc")).find((r) => r.get("RECORD") === "25" && r.get("TEXT") === "VΩ_µ")
    expect(label).toBeDefined()
  }, 120_000)
})
