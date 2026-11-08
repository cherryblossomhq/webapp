import { describe, expect, it } from "vitest"
import { createProject } from "../src/model/ops"
import { DEFAULT_PAPER, fitPaper, grownPaper, holds, innerBox, nextSize, PAPER_MM, paperBox, paperMm, paperName, titleBlockBox, titleBlockOf, zones } from "../src/model/paper"
import { addSheetInFreeSpace, addSheetUse } from "../src/model/sheetOps"
import type { SheetPaper } from "../src/model/types"

// A sheet's page in KiCad's numbers: its sizes, the default drawing sheet's border, zones and title block, what a page holds, and the title
// block's fields. Sheet units are 12.7 mm, y up, the page's corner its top-left.

const U = 12.7
const A4: SheetPaper = { size: "A4", x: 0, y: 0 }
const box = (minX: number, minY: number, maxX: number, maxY: number) => ({ minX, minY, maxX, maxY })
const close = (a: { minX: number; minY: number; maxX: number; maxY: number }, b: typeof a) => {
  for (const k of ["minX", "minY", "maxX", "maxY"] as const) expect(a[k], k).toBeCloseTo(b[k], 6)
}

describe("sizes", () => {
  it("are KiCad's, landscape unless portrait, and a custom page is its own width and height", () => {
    expect(paperMm(A4)).toEqual({ width: 297, height: 210 })
    expect(paperMm({ ...A4, portrait: true })).toEqual({ width: 210, height: 297 })
    expect(paperMm({ size: "USLedger" })).toEqual({ width: 431.8, height: 279.4 })
    expect(paperMm({ size: "User", width: 300, height: 450 })).toEqual({ width: 300, height: 450 })
    expect(PAPER_MM.A0).toEqual({ width: 1189, height: 841 })
    expect(paperName({ size: "User", width: 300, height: 200 })).toBe("Custom 300 × 200 mm")
  })

  it("starts a sheet on A4 landscape about the origin, its corner on the grid", () => {
    expect(DEFAULT_PAPER).toEqual({ size: "A4", x: -11.7, y: 8.3 })
    const b = paperBox(DEFAULT_PAPER)
    expect(b.minX < 0 && b.maxX > 0 && b.minY < 0 && b.maxY > 0).toBe(true)
  })
})

describe("the border and the title block", () => {
  it("are KiCad's default drawing sheet on A4: frames 10 mm and 12 mm in, a 108 by 32 mm title block in the inner corner", () => {
    close(paperBox(A4), box(0, -210 / U, 297 / U, 0))
    close(innerBox(A4), box(12 / U, -198 / U, 285 / U, -12 / U))
    close(titleBlockBox(A4), box(177 / U, -198 / U, 285 / U, -166 / U))
  })

  it("are zoned every 50 mm, numbered across and lettered down", () => {
    const names = (p: SheetPaper) => [...new Set(zones(p).labels.map((l) => l.text))]
    expect(names(A4)).toEqual(["1", "2", "3", "4", "5", "6", "A", "B", "C", "D"])
    expect(names({ size: "A3", x: 0, y: 0 })).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "A", "B", "C", "D", "E", "F"])
    // A tick each 50 mm along both strips: five across A4's 277 mm frame and three down its 190 mm, top and bottom, left and right.
    expect(zones(A4).ticks).toHaveLength(2 * 5 + 2 * 3)
  })
})

describe("holds", () => {
  const inner = innerBox(A4)
  const title = titleBlockBox(A4)
  it("takes a box inside the inner frame, above the title block or left of it", () => {
    expect(holds(A4, box(inner.minX, title.maxY, inner.maxX, inner.maxY))).toBe(true)
    expect(holds(A4, box(inner.minX, inner.minY, title.minX, inner.maxY))).toBe(true)
  })
  it("refuses a box over the title block's corner, or out of the frame", () => {
    expect(holds(A4, box(inner.minX, inner.minY, inner.maxX, inner.maxY))).toBe(false)
    expect(holds(A4, box(title.minX + 0.1, title.maxY - 0.1, title.minX + 1, title.maxY + 1))).toBe(false)
    expect(holds(A4, box(inner.minX - 0.1, -5, 0, -4))).toBe(false)
  })
})

describe("fitting and growing", () => {
  const ISO_UP = ["A4", "A3", "A2", "A1", "A0"] as const
  it("picks the smallest size that holds a box, centred on it, its corner on the grid", () => {
    const small = box(100, -50, 110, -45)
    const a4 = fitPaper(small, { size: "A4" }, [...ISO_UP])
    expect(a4.size).toBe("A4")
    expect(holds(a4, small)).toBe(true)
    expect(Number.isInteger(Math.round(a4.x * 1e6) / 1e5) && Number.isInteger(Math.round(a4.y * 1e6) / 1e5)).toBe(true)
    const wide = box(0, -5, 25, 0)
    expect(fitPaper(wide, { size: "A4" }, [...ISO_UP]).size).toBe("A3")
    // Too big for A0: A0, centred on it.
    const huge = fitPaper(box(-100, -100, 100, 100), { size: "A4" }, [...ISO_UP])
    expect(huge.size).toBe("A0")
    const h = paperBox(huge)
    expect((h.minX + h.maxX) / 2).toBeCloseTo(0, 0)
  })

  it("keeps the family and orientation it is given, and makes a custom page just big enough", () => {
    expect(fitPaper(box(0, -1, 1, 0), { size: "A4" }).size).toBe("A5")
    expect(fitPaper(box(0, -20, 10, 0), { size: "USLetter", portrait: true })).toMatchObject({ size: "USLedger", portrait: true })
    const custom = fitPaper(box(0, -30, 40, 0), { size: "User" })
    expect(custom.size).toBe("User")
    expect(holds(custom, box(0, -30, 40, 0))).toBe(true)
  })

  it("grows one size within each family, and a custom page to what it must hold, its corner kept", () => {
    const next = (size: SheetPaper["size"]) => nextSize({ size })
    expect(["A5", "A4", "A1", "A0"].map((s) => next(s as SheetPaper["size"]))).toEqual(["A4", "A3", "A0", null])
    expect(["A", "D", "E"].map((s) => next(s as SheetPaper["size"]))).toEqual(["B", "E", null])
    expect(["USLetter", "USLegal", "USLedger"].map((s) => next(s as SheetPaper["size"]))).toEqual(["USLedger", "USLedger", "C"])
    expect(next("User")).toBeNull()
    expect(grownPaper({ size: "A4", portrait: true, x: 1, y: 2 }, [])).toEqual({ size: "A3", portrait: true, x: 1, y: 2 })
    const user: SheetPaper = { size: "User", width: 200, height: 150, x: 0, y: 0 }
    const far = box(1, -30, 40, -1)
    const grown = grownPaper(user, [far])!
    expect([grown.x, grown.y]).toEqual([0, 0])
    expect(holds(grown, far)).toBe(true)
  })
})

describe("the title block", () => {
  it("is filled in from the project: its name, the Revision, Company and Author properties, the date saved, and the rest as comments", () => {
    const p = { ...createProject("Robot", "Two motors and a battery"), updatedAt: Date.UTC(2026, 10, 8), properties: [{ key: "Rev", value: "B" }, { key: "Company", value: "Cherry" }, { key: "Author", value: "Ada" }, { key: "Fab", value: "JLC" }] }
    expect(titleBlockOf(p, "")).toEqual({
      title: "Robot",
      sheet: "Main",
      number: "1",
      count: 1,
      size: "A4",
      date: "2026-11-08",
      revision: "B",
      company: "Cherry",
      drawnBy: "Ada",
      comments: [
        { index: 1, text: "Two motors and a battery" },
        { index: 2, text: "Author: Ada" },
        { index: 3, text: "Fab: JLC" },
      ],
    })
  })

  it("shows a KiCad sub-sheet's own entries, and each use's Sheet N of M", () => {
    let p = createProject("Robot")
    const first = addSheetInFreeSpace(p, "", "Power")
    p = first.project
    p = addSheetUse(p, "", first.symbol.child, { minX: 10, minY: 0, maxX: 12, maxY: 1.2 }, "Power2")!.project
    p = { ...p, sheets: p.sheets!.map((s) => (s.id === first.symbol.child ? { ...s, titleBlock: [{ key: "Title", value: "Power stage" }, { key: "Rev", value: "3" }, { key: "Comment1", value: "12 V in" }] } : s)) }
    const second = titleBlockOf(p, `/${p.sheetSymbols![1].id}`)
    expect(second).toMatchObject({ title: "Power stage", revision: "3", sheet: "Power2", number: "3", count: 3, comments: [{ index: 1, text: "12 V in" }] })
    expect(second.company).toBeUndefined()
    expect(titleBlockOf(p, "")).toMatchObject({ title: "Robot", number: "1", count: 3 })
  })
})
