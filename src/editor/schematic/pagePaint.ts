import { SCH_UNIT_MM } from "../../model/drawings"
import { BORDER, innerBox, outerBox, paperBox, titleBlockBox, zones, type TitleBlock } from "../../model/paper"
import type { SheetPaper } from "../../model/types"
import type { SchPalette } from "../theme"
import type { PaintNode } from "./drawingPaint"

// How a sheet's page is painted, as a list of SVG elements in world space (y up): the tint outside it, the border with its zones and
// the title block, laid out as KiCad's default drawing sheet has them. The schematic editor renders the list as React elements and
// `look`'s pictures as SVG text (`ai/vision`), as `drawingPaint.ts` does for drawings.

/** KiCad's line width for the drawing sheet, 0.15 mm, and its text sizes, 1.5 mm and 2 mm for the title. */
const LINE = 0.15 / SCH_UNIT_MM
const TEXT = 1.5 / SCH_UNIT_MM
const TITLE_TEXT = 2 / SCH_UNIT_MM

/** Far enough out that the tint covers whatever part of the sheet is in view. */
const FAR = 1e5

const mm = (v: number) => v / SCH_UNIT_MM
const r4 = (n: number) => Math.round(n * 10000) / 10000

/** A text cut to the width it has, at a typical character width of 0.6 of its size. */
function fit(text: string, width: number, size: number): string {
  const room = Math.floor(width / (size * 0.6))
  return text.length <= room ? text : `${text.slice(0, Math.max(0, room - 1))}…`
}

function textNode(text: string, x: number, y: number, size: number, fill: string, opts: { anchor?: "start" | "middle"; weight?: number; italic?: boolean } = {}): PaintNode {
  return {
    tag: "text",
    attrs: {
      transform: `translate(${r4(x)},${r4(y)}) scale(1,-1)`,
      fontSize: r4(size),
      textAnchor: opts.anchor ?? "start",
      dominantBaseline: "central",
      fill,
      fontWeight: opts.weight ?? 500,
      fontStyle: opts.italic ? "italic" : undefined,
    },
    text,
  }
}

const line = (x1: number, y1: number, x2: number, y2: number, stroke: string, width: number): PaintNode => ({ tag: "line", attrs: { x1: r4(x1), y1: r4(y1), x2: r4(x2), y2: r4(y2), stroke, strokeWidth: width } })

const rect = (b: { minX: number; minY: number; maxX: number; maxY: number }, stroke: string, width: number): PaintNode => ({
  tag: "rect",
  attrs: { x: r4(b.minX), y: r4(b.minY), width: r4(b.maxX - b.minX), height: r4(b.maxY - b.minY), fill: "none", stroke, strokeWidth: width },
})

/** The tint outside the page: a far rectangle with the page cut out of it, which also hides the grid there. */
export function paintOutside(paper: SheetPaper, sch: SchPalette): PaintNode {
  const p = paperBox(paper)
  return {
    tag: "path",
    attrs: {
      d: `M${-FAR},${-FAR}H${FAR}V${FAR}H${-FAR}Z M${r4(p.minX)},${r4(p.minY)}H${r4(p.maxX)}V${r4(p.maxY)}H${r4(p.minX)}Z`,
      fill: sch.outside,
      fillRule: "evenodd",
      stroke: "none",
    },
  }
}

/** The border (two frames and the zones between them) and the title block filled in, at `px` world units per screen pixel. */
export function paintPage(paper: SheetPaper, block: TitleBlock, sch: SchPalette, px: number): PaintNode[] {
  const width = Math.max(LINE, px * 0.8)
  const ink = sch.frame
  const nodes: PaintNode[] = [rect(outerBox(paper), ink, width), rect(innerBox(paper), ink, width)]
  const marks = zones(paper)
  for (const t of marks.ticks) nodes.push(line(t.a.x, t.a.y, t.b.x, t.b.y, ink, width))
  for (const l of marks.labels) nodes.push(textNode(l.text, l.x, l.y, mm(BORDER.zoneText), ink, { anchor: "middle" }))

  // The title block, as KiCad's default lays it out: rows up from the inner frame's corner, measured in mm from it.
  const tb = titleBlockBox(paper)
  const right = tb.maxX
  const bottom = tb.minY
  const at = (fromRight: number) => right - mm(fromRight)
  const up = (fromBottom: number) => bottom + mm(fromBottom)
  nodes.push(rect(tb, ink, width))
  for (const y of [3.5, 6.5, 10.5, 16.5]) nodes.push(line(tb.minX, up(y), right, up(y), ink, width))
  nodes.push(line(at(24), bottom, at(24), up(6.5), ink, width), line(at(88), up(3.5), at(88), up(6.5), ink, width))
  const cell = (text: string, fromRight: number, toRight: number, fromBottom: number, size = TEXT, weight = 500, italic = false) => {
    if (text) nodes.push(textNode(fit(text, mm(fromRight - toRight - 2), size), at(fromRight - 1), up(fromBottom), size, ink, { weight, italic }))
  }
  cell(block.drawnBy ? `Drawn by: ${block.drawnBy}` : "", 108, 24, 1.75)
  cell(`Sheet ${block.number} of ${block.count}`, 24, 0, 1.75)
  cell(`Size: ${block.size}`, 108, 88, 5)
  cell(block.date ? `Date: ${block.date}` : "", 88, 24, 5)
  cell(block.revision ? `Rev: ${block.revision}` : "", 24, 0, 5, TEXT, 700)
  cell(`Title: ${block.title}`, 108, 0, 8.5, TITLE_TEXT, 700, true)
  cell(`Sheet: ${block.sheet}`, 108, 0, 13.5)
  cell(block.company ?? "", 108, 0, 18.5, TEXT, 700)
  // KiCad shows four comments; the drawn-by property has a row of its own, so its comment would say it twice.
  block.comments
    .filter((c) => !/^(author|drawn by): /i.test(c.text))
    .slice(0, 4)
    .forEach((c, i) => cell(c.text, 108, 0, 21 + i * 3))
  return nodes
}
