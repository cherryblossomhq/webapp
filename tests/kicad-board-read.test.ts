import { describe, expect, it } from "vitest"
import { EXTENSION_NAMES, importKicadBoard, outlineOf, padCorners, padWorld, readKicadBoard } from "../src/model/kicad/board"
import { convertOverbar, embeddedKind } from "../src/model/kicad/board/read"
import { KicadReadError, parseSexpr } from "../src/model/kicad/board/sexpr"
import { board, footprint, pad } from "./kicad-board-fixtures"

// The reader, switch by switch: the rows of section 3.3 of docs/kicad-import.md, each with a board
// of a few lines that needs it.

const read = (text: string) => readKicadBoard(text)
const code = (text: string | Uint8Array) => {
  try {
    readKicadBoard(text)
    return null
  } catch (e) {
    return e instanceof KicadReadError ? e.code : "other"
  }
}

describe("the s-expression reader", () => {
  it("skips a byte order mark, reads CRLF and escaped quotes", () => {
    const [root] = parseSexpr('﻿(a\r\n (b "say \\"hi\\"")\r\n)')
    expect(root).toEqual(["a", ["b", 'say "hi"']])
  })

  it("reads a board with a byte order mark and CRLF line ends", () => {
    const text = "﻿" + board({ body: [footprint({ pads: [pad({ at: "0 0" })] })] }).replace(/\n/g, "\r\n")
    expect(read(text).board.footprints).toHaveLength(1)
  })

  it("reads UTF-16 text with a byte order mark", () => {
    const text = board({})
    const bytes = new Uint8Array(2 + text.length * 2)
    bytes[0] = 0xff
    bytes[1] = 0xfe
    for (let i = 0; i < text.length; i++) {
      bytes[2 + i * 2] = text.charCodeAt(i) & 0xff
      bytes[3 + i * 2] = text.charCodeAt(i) >> 8
    }
    const r = readKicadBoard(bytes)
    expect(r.board.version).toBe(20240108)
    expect(r.report.entries.some((e) => e.code === "encoding")).toBe(true)
  })

  it("names a truncated file, an unbalanced one and a nesting too deep, and never crashes", () => {
    expect(code(board({}).slice(0, 120))).toBe("truncated")
    expect(code("(kicad_pcb (version 20240108))))")).toBe("unbalanced")
    expect(code('(kicad_pcb (version 20240108) (general "open')).toBe("truncated")
    expect(code("(kicad_pcb " + "(a ".repeat(500) + ")".repeat(500) + ")")).toBe("too-deep")
    expect(code("")).toBe("empty")
    expect(code("   \n")).toBe("empty")
  })

  it("does not overflow the stack on a deep but allowed nesting", () => {
    expect(() => parseSexpr("(a ".repeat(150) + ")".repeat(150))).not.toThrow()
  })

  it("refuses what is not a board, and says what it is", () => {
    expect(code("(kicad_sch (version 20250114))")).toBe("not-a-board")
    expect(code('(footprint "R" (layer "F.Cu"))')).toBe("not-a-board")
    expect(code("(foo bar)")).toBe("not-a-board")
    expect(code("not s-expressions at all")).toBe("not-a-board")
  })
})

describe("switch 23: a file too old to be s-expressions", () => {
  it("is refused with a message that names the version, never a wrong import", () => {
    const old = "PCBNEW-BOARD Version 1 date Mon 14 Jul 2008\n\n$GENERAL\nEnd"
    expect(code(old)).toBe("legacy-board")
    const r = importKicadBoard(old)
    expect(r.status).toBe("refused")
    if (r.status === "refused") {
      expect(r.reason).toBe("unreadable")
      expect(r.message).toMatch(/PCBNEW-BOARD Version 1/)
      expect(r.message).toMatch(/before version 4/)
    }
  })
})

describe("switch 1: copper layers by position in the table", () => {
  const layers = (rows: string) => `(layers ${rows})`
  it("a KiCad 6 board that writes B.Cu as 31: front is the first row, back the last", () => {
    const b = read(board({ version: 20211014, layers: layers('(0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user)') })).board
    expect(b.copper).toEqual({ names: ["F.Cu", "B.Cu"], front: "F.Cu", back: "B.Cu" })
  })

  it("a KiCad 9 board that writes B.Cu as 2 with inner layers 4 and 6", () => {
    const b = read(board({ version: 20241229, layers: layers('(0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user)') })).board
    expect(b.copper.front).toBe("F.Cu")
    expect(b.copper.back).toBe("B.Cu")
    expect(b.copperLayerCount).toBe(4)
    expect(b.copper.names).toContain("In1.Cu")
  })

  it("a board that names its layers Front and Back, and one at version 3 that lists (15 Front) then (0 Back)", () => {
    const named = read(board({ version: 20171130, layers: '(layers (0 F.Cu signal "Front") (31 B.Cu signal "Back") (44 Edge.Cuts user))' })).board
    expect(named.layers[0].userName).toBe("Front")
    expect(named.copper.back).toBe("B.Cu")
    const v3 = read(board({ version: 3, layers: "(layers (15 Front signal) (0 Back signal) (16 Adhes user))", header: "(host pcbnew \"(2013-01-02 BZR 3881)-testing\")" })).board
    expect(v3.copper).toEqual({ names: ["Front", "Back"], front: "Front", back: "Back" })
    expect(v3.era).toBe("kicad3")
    const bottom = read(board({ version: 3, layers: "(layers (15 Front signal) (0 Back signal))", body: [footprint({ token: "module", layer: "Back", pads: [pad({ at: "0 0" })] })] })).board
    expect(bottom.footprints[0].side).toBe("bottom")
  })

  it("an inner layer is neither front nor back, and a layer the table lacks is refused by the importer, named", () => {
    const b = read(board({ body: ['(segment (start 1 1) (end 2 1) (width 0.2) (layer "In1.Cu") (net 0))'] })).board
    expect(b.copper.names).toEqual(["F.Cu", "B.Cu"])
    const r = importKicadBoard(board({ body: ['(segment (start 1 1) (end 2 1) (width 0.2) (layer "In1.Cu") (net 0))'] }))
    expect(r.status === "refused" && r.message).toMatch(/In1\.Cu/)
  })
})

describe("switch 2: module or footprint, by the token", () => {
  it("a 20240108 board with a (module token reads, as KiCad's parser does", () => {
    const b = read(board({ body: [footprint({ token: "module", pads: [pad({ at: "0 0" })] })] })).board
    expect(b.footprints).toHaveLength(1)
    expect(b.footprints[0].ref).toBe("R1")
  })
  it("a KiCad 5 module with fp_text reference and value", () => {
    const b = read(board({ version: 20171130, body: [footprint({ token: "module", ref: "C7", value: "100nF", pads: [pad({ at: "0 0" })] })] })).board
    expect(b.footprints[0].ref).toBe("C7")
    expect(b.footprints[0].value).toBe("100nF")
  })
})

describe("switch 3: legacy arcs", () => {
  it("the four quarter arcs of a KiCad 5 rounded outline close into one loop with the right radius", () => {
    const arcs = [
      "(gr_arc (start 18 2) (end 18 0) (angle 90) (layer Edge.Cuts) (width 0.1))",
      "(gr_arc (start 18 8) (end 20 8) (angle 90) (layer Edge.Cuts) (width 0.1))",
      "(gr_arc (start 2 8) (end 2 10) (angle 90) (layer Edge.Cuts) (width 0.1))",
      "(gr_arc (start 2 2) (end 0 2) (angle 90) (layer Edge.Cuts) (width 0.1))",
    ]
    const lines = [
      "(gr_line (start 2 0) (end 18 0) (layer Edge.Cuts) (width 0.1))",
      "(gr_line (start 20 2) (end 20 8) (layer Edge.Cuts) (width 0.1))",
      "(gr_line (start 18 10) (end 2 10) (layer Edge.Cuts) (width 0.1))",
      "(gr_line (start 0 8) (end 0 2) (layer Edge.Cuts) (width 0.1))",
    ]
    const o = outlineOf(read(board({ version: 20171130, outline: [...arcs, ...lines].join(" ") })).board)
    expect(o.status).toBe("closed")
    expect(o.shape).toBe("roundrect")
    expect(o.representable).toBe(true)
    expect(o.cornerRadius).toBeCloseTo(2, 6)
    expect(o.box).toEqual({ minX: 0, minY: 0, maxX: 20, maxY: 10 })
    // the same arcs with the sweep the other way round do not close: the sign is what the test pins
    const wrong = outlineOf(read(board({ version: 20171130, outline: [...arcs.map((a) => a.replace("(angle 90)", "(angle -90)")), ...lines].join(" ") })).board)
    expect(wrong.status).not.toBe("closed")
  })

  it("reads centre, first end and sweep as start, middle and end: positive is clockwise on screen", () => {
    const b = read(board({ version: 20171130, outline: "(gr_arc (start 0 0) (end 10 0) (angle 90) (layer Edge.Cuts) (width 0.1))" })).board
    const a = b.shapes[0]
    expect(a.start).toEqual({ x: 10, y: 0 })
    // clockwise on a y-down screen from the right of the centre goes down: the end is at (0, 10)
    expect(a.end!.x).toBeCloseTo(0, 9)
    expect(a.end!.y).toBeCloseTo(10, 9)
    expect(a.mid!.x).toBeCloseTo(Math.SQRT1_2 * 10, 9)
    expect(a.mid!.y).toBeCloseTo(Math.SQRT1_2 * 10, 9)
    expect(a.legacySweep).toBe(90)
  })

  it("a start, mid, end arc at a newer stamp is read as it is", () => {
    const b = read(board({ outline: '(gr_arc (start 10 0) (mid 7.07 7.07) (end 0 10) (stroke (width 0.1) (type default)) (layer "Edge.Cuts"))' })).board
    expect(b.shapes[0].mid).toEqual({ x: 7.07, y: 7.07 })
    expect(b.shapes[0].legacySweep).toBeUndefined()
  })
})

describe("the outline", () => {
  const rect = (stamp: number) => outlineOf(read(board({ version: stamp })).board)
  it("a rectangle, drawn as four lines or as one gr_rect, is a rectangle and fits the model", () => {
    for (const stamp of [20171130, 20240108]) {
      const o = rect(stamp)
      expect(o.status).toBe("closed")
      expect(o.shape).toBe("rect")
      expect(o.representable).toBe(true)
      expect(o.box).toEqual({ minX: 0, minY: 0, maxX: 20, maxY: 10 })
    }
  })

  it("a side drawn in overlapping pieces and a 0.09 mm stub are repaired", () => {
    const o = outlineOf(
      read(
        board({
          version: 20171130,
          outline: [
            "(gr_line (start 0 0) (end 12 0) (layer Edge.Cuts) (width 0.1))",
            "(gr_line (start 10 0) (end 20 0) (layer Edge.Cuts) (width 0.1))",
            "(gr_line (start 20 0) (end 20 10) (layer Edge.Cuts) (width 0.1))",
            "(gr_line (start 20 10) (end 0 10) (layer Edge.Cuts) (width 0.1))",
            "(gr_line (start 0 10) (end 0 0) (layer Edge.Cuts) (width 0.1))",
            "(gr_line (start 5 10) (end 5 10.089) (layer Edge.Cuts) (width 0.1))",
          ].join("\n"),
        }),
      ).board,
    )
    expect(o.status).toBe("closed")
    expect(o.repair.merged).toBe(1)
    expect(o.repair.dropped).toBe(1)
  })

  it("a short piece whose two ends touch other pieces is part of the loop and is kept", () => {
    // a rectangle with one corner cut by a 0.05 mm chamfer drawn exactly
    const o = outlineOf(
      read(
        board({
          version: 20171130,
          outline: [
            "(gr_line (start 0 0) (end 19.95 0) (layer Edge.Cuts) (width 0.1))",
            "(gr_line (start 19.95 0) (end 20 0.05) (layer Edge.Cuts) (width 0.1))",
            "(gr_line (start 20 0.05) (end 20 10) (layer Edge.Cuts) (width 0.1))",
            "(gr_line (start 20 10) (end 0 10) (layer Edge.Cuts) (width 0.1))",
            "(gr_line (start 0 10) (end 0 0) (layer Edge.Cuts) (width 0.1))",
          ].join("\n"),
        }),
      ).board,
    )
    expect(o.repair.dropped).toBe(0)
    expect(o.status).toBe("closed")
  })

  it("a circle drawn as an arc that ends where it starts is a closed loop, and a speck of an arc between two lines is not an open chain", () => {
    const circle = outlineOf(read(board({ outline: '(gr_arc (start 10 5) (mid 15 0) (end 10 5) (stroke (width 0.1) (type default)) (layer "Edge.Cuts"))' })).board)
    expect(circle.status).toBe("closed")
    expect(circle.shape).toBe("circle")
    // two collinear lines with a 0.007 mm arc in the gap between them, inside an otherwise plain rectangle
    const speck = outlineOf(
      read(
        board({
          version: 20211014,
          outline: [
            "(gr_line (start 0 0) (end 20 0) (layer Edge.Cuts) (width 0.1))",
            "(gr_line (start 20 0) (end 20 4.996) (layer Edge.Cuts) (width 0.1))",
            "(gr_arc (start 20 5.003) (mid 20.003 5) (end 20 4.996) (layer Edge.Cuts) (width 0.1))",
            "(gr_line (start 20 5.003) (end 20 10) (layer Edge.Cuts) (width 0.1))",
            "(gr_line (start 20 10) (end 0 10) (layer Edge.Cuts) (width 0.1))",
            "(gr_line (start 0 10) (end 0 0) (layer Edge.Cuts) (width 0.1))",
          ].join(" "),
        }),
      ).board,
    )
    expect(speck.status).toBe("closed")
  })

  it("an outline that does not close names where the gap is, and a board with none says so", () => {
    const open = outlineOf(
      read(board({ version: 20171130, outline: "(gr_line (start 0 0) (end 20 0) (layer Edge.Cuts) (width 0.1)) (gr_line (start 20 0) (end 20 10) (layer Edge.Cuts) (width 0.1)) (gr_line (start 20 10) (end 0 10) (layer Edge.Cuts) (width 0.1)) (gr_line (start 0 10) (end 0 1) (layer Edge.Cuts) (width 0.1))" })).board,
    )
    expect(open.status).not.toBe("closed")
    expect(open.openChains).toBe(1)
    expect(open.gaps[0].width).toBeCloseTo(1, 6)
    const none = outlineOf(read(board({ outline: false })).board)
    expect(none.status).toBe("no outline")
  })

  it("a polygon, a rectangle with a cutout and a rounded rectangle are classified", () => {
    const poly = outlineOf(read(board({ outline: '(gr_poly (pts (xy 0 0) (xy 20 0) (xy 20 10) (xy 10 12) (xy 0 10)) (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts"))' })).board)
    expect(poly.shape).toBe("polygon")
    expect(poly.representable).toBe(false)
    const cut = outlineOf(read(board({ outline: `${"(gr_rect (start 0 0) (end 20 10) (stroke (width 0.1) (type default)) (fill none) (layer \"Edge.Cuts\"))"} (gr_circle (center 10 5) (end 12 5) (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts"))` })).board)
    expect(cut.cutouts).toBe(1)
    expect(cut.representable).toBe(false)
  })
})

describe("switch 5: a footprint with (transform ...)", () => {
  it("reads its place from translate, rotate and scale", () => {
    const text = board({
      version: 20260616,
      body: ['(footprint "R" (layer "F.Cu") (transform (translate 10 20) (rotate 90) (scale 1)) (property "Reference" "R1" (at 0 0 0) (layer "F.SilkS")) (pad "1" smd rect (at 1 0) (size 1 1) (layers "F.Cu")))'],
    })
    const fp = read(text).board.footprints[0]
    expect(fp.at).toEqual({ x: 10, y: 20 })
    expect(fp.angle).toBe(90)
    expect(fp.transformed).toBe(true)
    const w = padWorld(fp, fp.pads[0])
    expect(w.x).toBeCloseTo(10, 9)
    // KiCad's 90 turns counter-clockwise on screen: the pad at +x goes up, to smaller y
    expect(w.y).toBeCloseTo(19, 9)
  })
})

describe("switches 6 and 7: footprint zones and texts before and after stamp 20260616", () => {
  const withZone = (stamp: number) =>
    board({
      version: stamp,
      body: [
        `(footprint "K" (layer "F.Cu") (at 10 10 90) (property "Reference" "K1" (at 0 0 90) (layer "F.SilkS")) (fp_text user note (at 0 0 90) (layer F.SilkS)) (zone (net 0) (net_name "") (layers "F.Cu") (keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour not_allowed) (footprints allowed)) (polygon (pts (xy 10 10) (xy 10 5) (xy 15 5)))) (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu")))`,
      ],
    })
  it("a keepout in a KiCad 8 footprint lands where it is drawn: the board frame is turned into the footprint's", () => {
    const fp = read(withZone(20240108)).board.footprints[0]
    // (10,10) is the footprint's origin; (10,5) is 5 above it, which the footprint, turned 90 counter-clockwise, sees 5 along its own +x
    expect(fp.zones[0].polygon[0].x).toBeCloseTo(0, 9)
    expect(fp.zones[0].polygon[0].y).toBeCloseTo(0, 9)
    expect(fp.zones[0].polygon[1].x).toBeCloseTo(5, 9)
    expect(fp.zones[0].polygon[1].y).toBeCloseTo(0, 9)
    expect(fp.zones[0].kind).toBe("keepout")
    expect(fp.zones[0].inFootprint).toBe(true)
  })
  it("from 20260616 the points are already in the footprint's frame", () => {
    const fp = read(withZone(20260616)).board.footprints[0]
    expect(fp.zones[0].polygon[1]).toEqual({ x: 10, y: 5 })
  })
  it("a text's angle is the stored (board-frame) angle in every release: 20260616 moved the zones and the text's position, not its angle", () => {
    // KiCad's parser turns an old file's absolute angle into the board-frame angle it keeps (parser lines 4640-4653) and reads a new one as it is (lines 4543-4548), and the writer writes that angle unchanged (writer line 2626).
    for (const stamp of [20221018, 20260206, 20260616, 20260901]) {
      const fp = read(withZone(stamp)).board.footprints[0]
      expect(fp.texts.find((t) => t.kind === "reference")!.angle).toBe(90)
      expect(fp.texts.find((t) => t.kind === "user")!.angle).toBe(90)
    }
  })
})

describe("unlocked text (the text may turn upside down with its part)", () => {
  const upright = (at: string, extra = "") => {
    const text = board({ body: [`(footprint "K" (layer "F.Cu") (at 0 0) (property "Reference" "K1" (at ${at}) (layer "F.SilkS")${extra}) ${pad({ at: "0 0" })})`] })
    return read(text).board.footprints[0].texts.find((t) => t.kind === "reference")!.keepUpright
  }
  it("is on by default, off for a bare unlocked in (at x y a unlocked) and for (unlocked yes)", () => {
    expect(upright("0 0 0")).toBe(true)
    expect(upright("0 0 0 unlocked")).toBe(false)
    expect(upright("0 0 0", " (unlocked yes)")).toBe(false)
    expect(upright("0 0 0", " (unlocked no)")).toBe(true)
  })
  it("is carried into the project (X9 is built) as a text that does not keep upright, and is a known word", () => {
    const r = importKicadBoard(board({ body: [`(footprint "K" (layer "F.Cu") (at 0 0) (property "Reference" "K1" (at 0 0 0 unlocked) (layer "F.SilkS")) ${pad({ at: "0 0" })})`] }))
    expect(r.status).toBe("imported")
    expect(r.status === "imported" && r.project.components[0].texts).toMatchObject([{ kind: "reference", upright: false }])
    expect(r.report.account!.unknownAtoms.size).toBe(0)
  })
})

describe("switch 8: a zero margin means inherit in files up to stamp 20240201", () => {
  const needsX7 = (stamp: number, extra: string) => {
    const r = importKicadBoard(board({ version: stamp, body: [footprint({ pads: [pad({ at: "0 0", extra })] })] }), { built: new Set(Object.keys(EXTENSION_NAMES).filter((x) => x !== "X7")) })
    return r.status === "refused" && r.needs.some((n) => n.ext === "X7")
  }
  it("a pad with (solder_mask_margin 0) at 20231212 has no override, and one with 0.05 has", () => {
    expect(needsX7(20231212, "(solder_mask_margin 0)")).toBe(false)
    expect(needsX7(20231212, "(solder_mask_margin 0.05)")).toBe(true)
  })
  it("after 20240201 a zero is a setting", () => {
    expect(needsX7(20240706, "(solder_mask_margin 0)")).toBe(true)
  })
  it("zone_connect and thermal settings are never zero-means-inherit", () => {
    expect(needsX7(20231212, "(zone_connect 0)")).toBe(true)
  })
})

describe("switch 9: the legacy fill rule", () => {
  it("a KiCad 5 gr_poly on F.SilkS is filled, one on Edge.Cuts is not; a zero-width gr_rect is filled", () => {
    const b = read(
      board({
        version: 20171130,
        body: [
          "(gr_poly (pts (xy 0 0) (xy 1 0) (xy 1 1)) (layer F.SilkS) (width 0))",
          "(gr_poly (pts (xy 0 0) (xy 1 0) (xy 1 1)) (layer Edge.Cuts) (width 0.1))",
          "(gr_rect (start 0 0) (end 1 1) (layer F.SilkS) (width 0))",
          "(gr_rect (start 0 0) (end 1 1) (layer F.SilkS) (width 0.2))",
        ],
        outline: false,
      }),
    ).board
    expect(b.shapes.map((s) => s.filled)).toEqual([true, false, true, false])
  })
  it("with a fill token the token decides", () => {
    const b = read(board({ outline: false, body: ['(gr_rect (start 0 0) (end 1 1) (stroke (width 0) (type default)) (fill none) (layer "F.SilkS"))', '(gr_rect (start 0 0) (end 1 1) (stroke (width 0.1) (type default)) (fill solid) (layer "F.SilkS"))'] })).board
    expect(b.shapes.map((s) => s.filled)).toEqual([false, true])
  })
})

describe("switch 10: net ties", () => {
  it("a KiCad 5 footprint whose tags start 'net tie' gets one group of all its pads", () => {
    const b = read(board({ version: 20171130, body: [footprint({ token: "module", pads: [pad({ number: "1", at: "0 0" }), pad({ number: "2", at: "1 0" })], extra: '(tags "net tie, jumper")' })] })).board
    expect(b.footprints[0].netTies).toEqual([["1", "2"]])
  })
  it("a newer footprint has the groups it writes", () => {
    const b = read(board({ body: [footprint({ pads: [pad({ number: "1", at: "0 0" })], extra: '(net_tie_pad_groups "1, 2" "3")' })] })).board
    expect(b.footprints[0].netTies).toEqual([["1", "2"], ["3"]])
  })
})

describe("switch 11: no attr", () => {
  it("is through-hole before stamp 20200826 and neither after", () => {
    const old = read(board({ version: 20171130, body: [footprint({ token: "module", pads: [pad({ at: "0 0" })] })] })).board.footprints[0]
    expect(old.hasAttr).toBe(false)
    expect(old.throughHole).toBe(true)
    const recent = read(board({ body: [footprint({ pads: [pad({ at: "0 0" })] })] })).board.footprints[0]
    expect(recent.throughHole).toBe(false)
    const smd = read(board({ version: 20171130, body: [footprint({ token: "module", pads: [pad({ at: "0 0" })], extra: "(attr smd)" })] })).board.footprints[0]
    expect(smd.attr).toEqual(["smd"])
    expect(smd.throughHole).toBe(false)
  })
})

describe("switch 12: flags and atoms in every spelling", () => {
  it("(locked), (locked yes), a bare locked and (hide) (hide yes) all read", () => {
    const spellings = ["(locked)", "(locked yes)", "locked"]
    for (const s of spellings) {
      const b = read(board({ body: [`(segment (start 0 0) (end 1 0) (width 0.2) (layer "F.Cu") (net 0) ${s})`] })).board
      expect(b.segments[0].locked).toBe(true)
    }
    const off = read(board({ body: ['(segment (start 0 0) (end 1 0) (width 0.2) (layer "F.Cu") (net 0) (locked no))'] })).board
    expect(off.segments[0].locked).toBe(false)
    for (const s of ["(hide)", "(hide yes)", "hide"]) {
      const t = read(board({ body: [footprint({ pads: [pad({ at: "0 0" })], extra: `(fp_text user x (at 0 0) (layer F.SilkS) ${s})` })] })).board.footprints[0].texts.find((x) => x.kind === "user")!
      expect(t.hide).toBe(true)
    }
  })
  it("a net named A|B reads at 20231212 and at 20240706", () => {
    for (const stamp of [20231212, 20240706]) {
      const b = read(board({ version: stamp, nets: ['(net 0 "")', '(net 1 "A|B")'], body: [footprint({ pads: [pad({ at: "0 0", net: '(net 1 "A|B")' })] })] })).board
      expect(b.nets[1].name).toBe("A|B")
      expect(b.footprints[0].pads[0].net).toBe("A|B")
    }
  })
})

describe("switch 13: net-name escapes", () => {
  it("{slash} is / for the user and stays as written in raw", () => {
    const raw = "Net-(J701-DAS{slash}~{DSS}{slash}~{LED1})"
    const b = read(board({ nets: ['(net 0 "")', `(net 1 "${raw}")`], body: [footprint({ pads: [pad({ at: "0 0", net: `(net 1 "${raw}")` })] })] })).board
    expect(b.nets[1].raw).toBe(raw)
    expect(b.nets[1].name).toBe("Net-(J701-DAS/~{DSS}/~{LED1})")
    expect(b.footprints[0].pads[0].net).toBe("Net-(J701-DAS/~{DSS}/~{LED1})")
    expect(b.footprints[0].pads[0].netRaw).toBe(raw)
  })
})

describe("switch 13, the overbar half: ~DSS~ is ~{DSS} before stamp 20210606", () => {
  it("convertOverbar follows KiCad's ConvertToNewOverbarNotation (string_utils.cpp, line 87)", () => {
    const cases: [string, string][] = [
      ["~DSS~", "~{DSS}"],
      ["~RESET~", "~{RESET}"],
      ["~CS", "~{CS}"],
      ["~A B", "~{A} B"],
      ["x~OE~y", "x~{OE}y"],
      ["a~~b", "a~b"],
      ["~{DSS}", "~{DSS}"],
      ["~", "~"],
      ["~~{x}", "~~{x}"],
      ["GND", "GND"],
      ["~A~~B~", "~{A~B}"],
      ["(~A)", "(~{A})"],
    ]
    for (const [old, converted] of cases) expect(convertOverbar(old), old).toBe(converted)
  })
  it("a net named ~DSS~ in a 20210101 board is ~{DSS}, in a 20230101 board it stays as written", () => {
    const text = (stamp: number) => board({ version: stamp, nets: ['(net 0 "")', '(net 1 "~DSS~")'], body: [footprint({ pads: [pad({ at: "0 0", net: '(net 1 "~DSS~")' })] })] })
    const old = read(text(20210101)).board
    expect(old.nets[1].raw).toBe("~{DSS}")
    expect(old.footprints[0].pads[0].netRaw).toBe("~{DSS}")
    const modern = read(text(20230101)).board
    expect(modern.nets[1].raw).toBe("~DSS~")
  })
  it("text in an old board gets the same conversion", () => {
    const fp = read(board({ version: 20210101, body: [footprint({ token: "module", pads: [pad({ at: "0 0" })], value: "~EN~" })] })).board.footprints[0]
    expect(fp.value).toBe("~{EN}")
  })
})

describe("switch 14: a value the reader does not know is reported", () => {
  it("(pad 1 smd hexagon ...) gives a report entry and a refusal, not a skip", () => {
    const r = importKicadBoard(board({ body: [footprint({ pads: [pad({ at: "0 0", shape: "hexagon" })] })] }), { built: new Set(["X1", "X2", "X3", "X4", "X5", "X6", "X7", "X8", "X9", "X10", "X11", "X12", "X13", "X14", "X15", "X19", "X20", "X21", "X22", "X23"]) })
    expect(r.status).toBe("refused")
    if (r.status === "refused") {
      expect(r.reason).toBe("unknown")
      expect(r.report.entries.some((e) => e.code === "unknown-value" && /hexagon/.test(e.object))).toBe(true)
    }
  })
  it("an unknown node is a report entry too", () => {
    const r = importKicadBoard(board({ body: ["(frobnicate 1 2 3)", "(segment (start 0 0) (end 1 0) (width 0.2) (layer \"F.Cu\") (net 0) (wobble 1))"] }))
    expect(r.status).toBe("refused")
    if (r.status === "refused") {
      expect(r.reason).toBe("unknown")
      const names = r.report.entries.filter((e) => e.code === "unknown-node").map((e) => e.object)
      expect(names.some((n) => n.includes("frobnicate"))).toBe(true)
      expect(names.some((n) => n.includes("segment>wobble"))).toBe(true)
    }
  })
})

describe("switch 15: pad position and angle", () => {
  it("the angle is absolute, and the position is in the footprint's own frame turned by its angle", () => {
    const b = read(board({ body: [footprint({ at: "10 5 90", pads: [pad({ at: "2 1 90", size: "2 0.5" })] })] })).board
    const fp = b.footprints[0]
    expect(fp.pads[0].angle).toBe(90)
    expect(fp.pads[0].hasAngle).toBe(true)
    const w = padWorld(fp, fp.pads[0])
    // (2, 1) turned 90 counter-clockwise on screen (y down) is (1, -2): the board position is (11, 3)
    expect(w.x).toBeCloseTo(11, 9)
    expect(w.y).toBeCloseTo(3, 9)
    // 2 by 0.5 at an absolute 90 stands up: its corners span 0.5 in x and 2 in y
    const xs = padCorners(fp, fp.pads[0]).map((p) => p.x)
    const ys = padCorners(fp, fp.pads[0]).map((p) => p.y)
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(0.5, 9)
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(2, 9)
  })
  it("an absent angle is zero", () => {
    const fp = read(board({ body: [footprint({ at: "10 5 90", pads: [pad({ at: "2 1" })] })] })).board.footprints[0]
    expect(fp.pads[0].angle).toBe(0)
    expect(fp.pads[0].hasAngle).toBe(false)
  })
})

describe("switch 16: the 3D model's offset", () => {
  const model = (stamp: number, form: string) => read(board({ version: stamp, body: [footprint({ token: "module", pads: [pad({ at: "0 0" })], extra: `(model "\${KISYS3DMOD}/Resistors_SMD.3dshapes/R_0603.wrl" ${form} (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))` })] })).board.footprints[0].models[0]
  it("(at (xyz ...)) is inches and (offset (xyz ...)) millimetres, at every stamp", () => {
    expect(model(20170101, "(at (xyz 0.1 0 0.05))").offset).toEqual({ x: 2.54, y: 0, z: 1.27 })
    expect(model(20171130, "(offset (xyz 0.1 0 0.05))").offset).toEqual({ x: 0.1, y: 0, z: 0.05 })
    // KiCad's parser multiplies an `at` by 25.4 whatever the file's stamp (parse3DModel, parser lines 981-989), so a newer file that still says `at` is read the same way
    expect(model(20240108, "(at (xyz 0.1 0 0.05))").offset).toEqual({ x: 2.54, y: 0, z: 1.27 })
  })
  it("the later of an at and an offset wins, as in KiCad's parser", () => {
    expect(model(20240108, "(at (xyz 1 1 1)) (offset (xyz 0.5 0 0))").offset).toEqual({ x: 0.5, y: 0, z: 0 })
    expect(model(20240108, "(offset (xyz 0.5 0 0)) (at (xyz 1 0 0))").offset).toEqual({ x: 25.4, y: 0, z: 0 })
  })
})

describe("switch 17: strokes", () => {
  it("(width w) up to 20211228 and (stroke (width) (type)) after both read", () => {
    const a = read(board({ outline: false, version: 20211014, body: ['(gr_line (start 0 0) (end 1 0) (layer "F.SilkS") (width 0.15))'] })).board.shapes[0]
    expect(a.width).toBe(0.15)
    const b = read(board({ outline: false, body: ['(gr_line (start 0 0) (end 1 0) (stroke (width 0.2) (type dash)) (layer "F.SilkS"))'] })).board.shapes[0]
    expect(b.width).toBe(0.2)
    expect(b.dash).toBe("dash")
  })
})

describe("switch 18: dimensions of both forms are kept and accounted for", () => {
  it("a legacy one and a new one", () => {
    const legacy = '(dimension 10 (width 0.15) (layer Dwgs.User) (gr_text "10" (at 5 5) (layer Dwgs.User) (effects (font (size 1 1) (thickness 0.15)))) (feature1 (pts (xy 0 0) (xy 0 5))) (feature2 (pts (xy 10 0) (xy 10 5))) (crossbar (pts (xy 0 4) (xy 10 4))) (arrow1a (pts (xy 0 4) (xy 0.5 4.2))) (arrow1b (pts (xy 0 4) (xy 0.5 3.8))) (arrow2a (pts (xy 10 4) (xy 9.5 4.2))) (arrow2b (pts (xy 10 4) (xy 9.5 3.8))))'
    const modern = '(dimension (type aligned) (layer "Dwgs.User") (uuid "x") (pts (xy 0 0) (xy 10 0)) (height 3) (gr_text "10" (at 5 3 0) (layer "Dwgs.User") (uuid "y") (effects (font (size 1 1) (thickness 0.15)))) (format (units 3) (units_format 0) (precision 4)) (style (thickness 0.1) (arrow_length 1.27) (text_position_mode 0) (extension_height 0.58) (extension_offset 0.5) keep_text_aligned))'
    expect(read(board({ version: 20171130, outline: false, body: [legacy] })).board.dimensions).toHaveLength(1)
    expect(read(board({ outline: false, body: [modern] })).board.dimensions).toHaveLength(1)
    for (const text of [board({ version: 20171130, outline: false, body: [legacy] }), board({ outline: false, body: [modern] })]) {
      const r = importKicadBoard(text)
      // dimensions are built: every node is accounted for and the board comes in with one
      expect(r.report.account!.unknownPaths.size).toBe(0)
      // (these fixtures have no outline, which X2 holds as a state of the board, not a refusal: the board comes in with its dimension)
      expect(r.status === "imported" && r.project.dimensions?.length).toBe(1)
    }
  })
})

describe("switches 19 and 20: nets and net classes", () => {
  it("(net 0 \"\") is no net, and a pad's (net 3 \"GND\") is GND", () => {
    const b = read(board({ nets: ['(net 0 "")', '(net 1 "GND")'], body: [footprint({ pads: [pad({ number: "1", at: "0 0", net: '(net 0 "")' }), pad({ number: "2", at: "1 0", net: '(net 1 "GND")' })] })] })).board
    expect(b.footprints[0].pads.map((p) => p.net)).toEqual([null, "GND"])
  })
  it("a KiCad 5 pad net is a code and a name; a code alone reads through the table", () => {
    const b = read(board({ version: 20171130, nets: ["(net 0 \"\")", "(net 1 GND)"], body: [`(segment (start 0 0) (end 1 0) (width 0.2) (layer F.Cu) (net 1))`] })).board
    expect(b.segments[0].net).toBe("GND")
  })
  it("from stamp 20251028 a net has no number: (net \"GND\")", () => {
    const b = read(board({ version: 20251028, nets: ['(net "GND")', '(net "VCC")'], body: [footprint({ pads: [pad({ at: "0 0", net: '(net "VCC")' })] })] })).board
    expect(b.nets.map((n) => n.name)).toEqual(["GND", "VCC"])
    expect(b.nets[0].code).toBeNull()
    expect(b.footprints[0].pads[0].net).toBe("VCC")
  })
  it("KiCad 5 keeps its net classes in the board", () => {
    const b = read(board({ version: 20171130, body: ['(net_class Default "This is the default net class." (clearance 0.2) (trace_width 0.25) (via_dia 0.8) (via_drill 0.4) (uvia_dia 0.3) (uvia_drill 0.1) (add_net GND) (add_net "Net-(R1-Pad1)"))'] })).board
    expect(b.netClasses[0]).toMatchObject({ name: "Default", clearance: 0.2, traceWidth: 0.25, viaDiameter: 0.8, viaDrill: 0.4, nets: ["GND", "Net-(R1-Pad1)"] })
  })
})

describe("switch 21: a zone's fill is counted, not imported", () => {
  it("filled_polygon marks the zone filled and is 'not needed' in the accounting", () => {
    const text = board({ body: ['(zone (net 0) (net_name "") (layer "F.Cu") (hatch edge 0.5) (connect_pads (clearance 0.5)) (min_thickness 0.25) (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5)) (polygon (pts (xy 0 0) (xy 20 0) (xy 20 10) (xy 0 10))) (filled_polygon (layer "F.Cu") (pts (xy 0 0) (xy 20 0) (xy 20 10))))'] })
    const b = read(text).board
    expect(b.zones[0].filled).toBe(true)
    expect(b.zones[0].polygon).toHaveLength(4)
    // Zones are built (X3): the board imports, the zone is the editor's, and the stored fill is the one thing not kept.
    const r = importKicadBoard(text)
    expect(r.status).toBe("imported")
    if (r.status === "imported") {
      expect(r.project.zones).toHaveLength(1)
      expect([...r.report.account!.notNeeded.keys()].some((k) => /KiCad's own result of its fill/.test(k))).toBe(true)
      expect(r.report.entries.some((e) => e.code === "zones-refilled")).toBe(true)
    }
  })
})

describe("switches 4 and 22: via spans", () => {
  it("through, blind, micro, and buried by its bare atom", () => {
    const via = (kind: string, layers: string) => `(via ${kind} (at 5 5) (size 0.8) (drill 0.4) (layers ${layers}) (net 0))`
    const b = read(
      board({
        version: 20250926,
        layers: '(layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user))',
        body: [via("", '"F.Cu" "B.Cu"'), via("blind", '"F.Cu" "In1.Cu"'), via("micro", '"F.Cu" "In1.Cu"'), via("buried", '"In1.Cu" "In2.Cu"')],
      }),
    ).board
    expect(b.vias.map((v) => v.kind)).toEqual(["through", "blind", "micro", "buried"])
    expect(b.vias[1].layers).toEqual(["F.Cu", "In1.Cu"])
  })
  it("a board with a blind via imports it as a blind via between its two layers, never as a through via (X5)", () => {
    const r = importKicadBoard(board({ layers: '(layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))', body: ['(via blind (at 5 5) (size 0.8) (drill 0.4) (layers "F.Cu" "In1.Cu") (net 0))'] }))
    expect(r.status === "imported" && r.project.vias[0]).toMatchObject({ kind: "blind", from: "top", to: "in1" })
  })
})

describe("switch 24: the link to the schematic symbol", () => {
  it("(path /5A1B2C3D) of KiCad 5 and (path \"/uuid/uuid\") of KiCad 6 and later are kept", () => {
    const old = read(board({ version: 20171130, body: [footprint({ token: "module", pads: [pad({ at: "0 0" })], extra: "(path /5A1B2C3D)" })] })).board.footprints[0]
    expect(old.path).toBe("/5A1B2C3D")
    const modern = read(board({ body: [footprint({ pads: [pad({ at: "0 0" })], extra: '(path "/1e2f3a4b-0000-4000-8000-000000000001/1e2f3a4b-0000-4000-8000-000000000002") (sheetname "Root") (sheetfile "x.kicad_sch")' })] })).board.footprints[0]
    expect(modern.path).toBe("/1e2f3a4b-0000-4000-8000-000000000001/1e2f3a4b-0000-4000-8000-000000000002")
    expect(modern.sheetname).toBe("Root")
  })
})

describe("every era reads", () => {
  it("stamps 3 to 11, with their release", () => {
    const eras: [number, string][] = [
      [3, "kicad3"],
      [4, "kicad4"],
      [20171130, "kicad5"],
      [20200119, "pre6-nightly"],
      [20211014, "kicad6"],
      [20221018, "kicad7"],
      [20240108, "kicad8"],
      [20241229, "kicad9"],
      [20260206, "kicad10"],
      [20261018, "kicad11-dev"],
    ]
    for (const [stamp, era] of eras) {
      const b = read(board({ version: stamp, layers: stamp < 20211014 ? "(layers (0 F.Cu signal) (31 B.Cu signal) (44 Edge.Cuts user))" : undefined })).board
      expect(b.era).toBe(era)
    }
  })
  it("a stamp newer than the reader knows is a note, and the file is still read", () => {
    const r = read(board({ version: 20270101 }))
    expect(r.report.entries.some((e) => e.code === "newer-format")).toBe(true)
    expect(r.board.era).toBe("kicad11-dev")
  })
  it("a file with no version is read by its tokens", () => {
    const r = read(board({}).replace("(version 20240108)", ""))
    expect(r.board.version).toBeNull()
    expect(r.report.entries.some((e) => e.code === "no-version")).toBe(true)
  })
})

describe("unreadable numbers are a refusal, never a guess", () => {
  it("a pad position that is not a number", () => {
    const r = importKicadBoard(board({ body: [footprint({ pads: [pad({ at: "abc def" })] })] }), { built: new Set(["X7", "X8", "X9", "X13"]) })
    expect(r.status).toBe("refused")
    if (r.status === "refused") expect(r.report.entries.some((e) => e.code === "unreadable-value")).toBe(true)
  })
})

describe("two nets that read alike are two nets", () => {
  it("/A/B and /A{slash}B keep their own raw names", () => {
    const b = read(board({ nets: ['(net 0 "")', '(net 1 "/A/B")', '(net 2 "/A{slash}B")'], body: [footprint({ pads: [pad({ number: "1", at: "-1 0", net: '(net 1 "/A/B")' }), pad({ number: "2", at: "1 0", net: '(net 2 "/A{slash}B")' })] })] })).board
    expect(b.footprints[0].pads.map((p) => p.netRaw)).toEqual(["/A/B", "/A{slash}B"])
    expect(b.footprints[0].pads.map((p) => p.net)).toEqual(["/A/B", "/A/B"])
  })
})

describe("plot settings", () => {
  it("padsonsilk true is read, anything else is not", () => {
    const on = read(board({ setup: "(setup (pcbplotparams (padsonsilk true)))" })).board
    const off = read(board({ setup: "(setup (pcbplotparams (padsonsilk false)))" })).board
    const absent = read(board({ setup: "(setup (pad_to_mask_clearance 0))" })).board
    expect([on.padsOnSilk, off.padsOnSilk, absent.padsOnSilk]).toEqual([true, false, false])
  })
})

describe("embedded files are named", () => {
  it("each kind is named for what it is: a worksheet, a PNG, a font, a model", () => {
    expect(embeddedKind("sheet.kicad_wks", "worksheet")).toBe("Drawing sheet (worksheet)")
    expect(embeddedKind("logo.png", "other")).toBe("Image")
    expect(embeddedKind("Roboto.ttf", "font")).toBe("Font")
    expect(embeddedKind("R.step", "model")).toBe("3D model")
    expect(embeddedKind("part.pdf", "datasheet")).toBe("Datasheet")
    expect(embeddedKind("notes.bin", "other")).toBe("File")
    const r = importKicadBoard(board({ body: ['(embedded_files (file (name "sheet.kicad_wks") (type worksheet) (data |AAAA|)) (file (name "logo.png") (type other) (data |BBBB|)))'] }))
    const entries = r.report.entries.filter((e) => e.code === "embedded-file")
    expect(entries.map((e) => e.why)).toEqual(["Drawing sheet (worksheet) embedded in the KiCad file was not brought in.", "Image embedded in the KiCad file was not brought in."])
  })
  it("each embedded model is a report entry that says it was not brought in", () => {
    const r = importKicadBoard(board({ body: ['(embedded_files (file (name "R_0603.step") (type model) (data |AAAA|)) (file (name "C_0603.step") (type model) (data |BBBB|)))'] }))
    const entries = (r.status === "refused" ? r.report : r.report).entries.filter((e) => e.code === "embedded-file")
    expect(entries.map((e) => e.object)).toEqual(["R_0603.step (in the board)", "C_0603.step (in the board)"])
    expect(entries.every((e) => e.why === "3D model embedded in the KiCad file was not brought in.")).toBe(true)
  })
})
