import { describe, expect, it } from "vitest"
import { addBusItems, addSheetItems } from "../src/export/kicadSheet"
import { typedNetName } from "../src/model/busNames"
import type { NetLabel, SchematicDrawing } from "../src/model/types"

// The uuids the writer makes up for a sheet's drawings must be unique on the sheet: they were derived from the drawing's place in the list (n * 1000 + k, 900000 + i),
// which met other items' uuids on a big sheet.

const page = (p: { x: number; y: number }) => p
const uuidsOf = (text: string) => [...text.matchAll(/\(uuid ([0-9a-f-]+)\)/g)].map((m) => m[1])

describe("the uuids written for a sheet's drawings", () => {
  it("are all different on a sheet of more than a thousand drawings with a 400-segment bus", () => {
    const drawings: SchematicDrawing[] = []
    drawings.push({ id: "bus", type: "bus", points: Array.from({ length: 401 }, (_, i) => ({ x: i * 0.1, y: (i % 2) * 0.1 })) })
    for (let i = 0; i < 1100; i++) drawings.push({ id: `j${i}`, type: i % 2 ? "junction" : "noconnect", x: i, y: 0 })
    drawings.push({ id: "bus2", type: "bus", points: Array.from({ length: 301 }, (_, i) => ({ x: i * 0.1, y: 5 + (i % 2) * 0.1 })) })
    for (let i = 0; i < 50; i++) drawings.push({ id: `e${i}`, type: "busentry", x: i, y: 9, dx: 0.1, dy: 0.1 })
    const labels: NetLabel[] = Array.from({ length: 30 }, (_, i) => ({ id: `l${i}`, name: `D[0..${i + 1}]`, x: i, y: 1, rot: 0 }))
    const sheet = addBusItems(addSheetItems("(kicad_sch\n)\n", drawings, page), labels, [], page)
    const ids = uuidsOf(sheet)
    // 400 + 300 segments, 1100 dots, 50 entries, 30 labels
    expect(ids.length).toBe(400 + 300 + 1100 + 50 + 30)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("stay the same for the same sheet (a file written twice is the same file)", () => {
    const drawings: SchematicDrawing[] = [{ id: "bus", type: "bus", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }, { id: "j", type: "junction", x: 0, y: 0 }]
    expect(addSheetItems("(kicad_sch\n)\n", drawings, page)).toBe(addSheetItems("(kicad_sch\n)\n", drawings, page))
  })
})

describe("typedNetName", () => {
  it("turns spaces into underscores in a name that is no bus group, even with a brace", () => {
    expect(typedNetName("VCC {3V3}")).toBe("VCC_{3V3}")
    expect(typedNetName("VCC {3V3}", true)).toBe("VCC_{3V3}")
    expect(typedNetName("~{RESET N}")).toBe("~{RESET_N}")
    expect(typedNetName("A B")).toBe("A_B")
    expect(typedNetName("a {b c")).toBe("a_{b_c")
  })
  it("keeps the spaces inside the braces of a real bus group", () => {
    expect(typedNetName("{A B}")).toBe("{A B}")
    expect(typedNetName("P{A B}")).toBe("P{A B}")
    expect(typedNetName("USB{DP DM}")).toBe("USB{DP DM}")
  })
  it("keeps the spaces of a group still being typed, and only those", () => {
    expect(typedNetName("{A ", true)).toBe("{A ")
    expect(typedNetName("P{A B", true)).toBe("P{A B")
    expect(typedNetName("X {A B", true)).toBe("X_{A B")
    expect(typedNetName("{A B", false)).toBe("{A_B")
  })
})
