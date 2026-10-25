import { bodyBox, flagMarkBox } from "../../model/instances"
import { labelGeometry } from "../../model/labelShapes"
import { primitivePathData } from "../../model/primitiveGeometry"
import { boxCorners, boxTextAt, imageSize, textLines, textLines2 } from "../../model/sheetItems"
import type { ComponentInstance, NetLabel, Rotation, SheetFill, SheetItem, SheetStroke, ShapeLook, TextLook, Vec2 } from "../../model/types"
import { useSch, type SchPalette } from "../theme"
import { WorldText } from "../viewport"
import { dashArray } from "./SymbolView"

// S2 and S4 on the canvas: a label as KiCad draws it (its text, or its flag), and the items a sheet
// carries besides parts, wires and labels. Everything is drawn at the numbers the file gave, in the
// editor's units; the text is the editor's own font at KiCad's size and justification.

/** KiCad's default line width, 6 mil. */
const LINE = 0.012

const fillOf = (fill: SheetFill | undefined, stroke: string, sch: SchPalette) => (!fill ? "none" : fill.kind === "outline" ? stroke : fill.kind === "background" ? sch.body : (fill.color ?? sch.body))

/** A text, in its own look, line by line from where it is anchored. */
export function SheetText({ text, at, rot, look, fill, px }: { text: string; at: Vec2; rot: Rotation; look?: TextLook; fill: string; px: number }) {
  void px
  if (look?.hidden) return null
  return (
    <>
      {textLines2(at, rot, look, textLines(text)).map((l, i) => (
        <WorldText key={i} x={l.x} y={l.y} text={l.text} size={l.size} extent={l.extent} vertical={l.vertical} fill={look?.color ?? fill} weight={look?.bold ? 700 : 500} italic={look?.italic} markup />
      ))}
    </>
  )
}

/** A label from KiCad: its text beside its point, or a flag whose shape says what the signal does. */
export function KicadLabelView({ label, selected, px }: { label: NetLabel; selected: boolean; px: number }) {
  const sch = useSch()
  if (label.look?.hidden) return null
  const g = labelGeometry(label)
  const ink = label.look?.color ?? sch.labelInk
  const edge = selected ? sch.select : sch.wire
  return (
    <g>
      {g.outline.length > 0 && <polygon points={g.outline.map((p) => `${p.x},${p.y}`).join(" ")} fill={sch.label} stroke={edge} strokeWidth={Math.max(LINE, (selected ? 1.6 : 1) * px)} strokeLinejoin="round" />}
      {g.outline.length === 0 && selected && <rect x={g.box.minX} y={g.box.minY} width={g.box.maxX - g.box.minX} height={g.box.maxY - g.box.minY} fill={sch.selectSoft} stroke={sch.select} strokeWidth={px} />}
      <WorldText x={g.text.x} y={g.text.y} text={label.name} size={g.text.size} extent={g.text.extent} vertical={g.text.vertical} fill={selected && g.outline.length === 0 ? sch.select : ink} weight={label.look?.bold ? 700 : 500} italic={label.look?.italic} markup />
    </g>
  )
}

function strokeProps(stroke: SheetStroke | undefined, fallback: string, px: number, selected: boolean, sch: SchPalette) {
  const width = Math.max(stroke?.width ?? LINE, (selected ? 1.6 : 0.8) * px)
  return { stroke: selected ? sch.select : (stroke?.color ?? fallback), strokeWidth: width, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, strokeDasharray: dashArray(stroke?.dash as ShapeLook["dash"], width) }
}

const polygon = (pts: Vec2[]) => pts.map((p) => `${p.x},${p.y}`).join(" ")

/** One item of the sheet. */
export function SheetItemView({ item, selected, px }: { item: SheetItem; selected: boolean; px: number }) {
  const sch = useSch()
  const ink = sch.ink2
  switch (item.kind) {
    case "text":
      return (
        <g>
          {item.look?.href && <title>{item.look.href}</title>}
          <SheetText text={item.text} at={item} rot={item.rot} look={item.look} fill={selected ? sch.select : ink} px={px} />
        </g>
      )
    case "textbox": {
      const corners = boxCorners(item, item.w, item.h, item.rot)
      const at = boxTextAt(item, item.margins, item.look)
      const stroke = strokeProps(item.stroke, sch.wire, px, selected, sch)
      return (
        <g>
          <polygon points={polygon(corners)} fill={fillOf(item.fill, stroke.stroke, sch)} {...stroke} />
          <SheetText text={item.text} at={at} rot={item.rot} look={item.look} fill={selected ? sch.select : ink} px={px} />
        </g>
      )
    }
    case "polyline": {
      const stroke = strokeProps(item.stroke, sch.wire, px, selected, sch)
      const closed = item.points.length > 2 && item.points[0].x === item.points[item.points.length - 1].x && item.points[0].y === item.points[item.points.length - 1].y
      return <polyline points={polygon(item.points)} fill={closed ? fillOf(item.fill, stroke.stroke, sch) : "none"} {...stroke} />
    }
    case "rectangle": {
      const stroke = strokeProps(item.stroke, sch.wire, px, selected, sch)
      return (
        <rect
          x={Math.min(item.a.x, item.b.x)}
          y={Math.min(item.a.y, item.b.y)}
          width={Math.abs(item.b.x - item.a.x)}
          height={Math.abs(item.b.y - item.a.y)}
          rx={item.radius}
          fill={fillOf(item.fill, stroke.stroke, sch)}
          {...stroke}
        />
      )
    }
    case "circle": {
      const stroke = strokeProps(item.stroke, sch.wire, px, selected, sch)
      return <circle cx={item.c.x} cy={item.c.y} r={item.r} fill={fillOf(item.fill, stroke.stroke, sch)} {...stroke} />
    }
    case "arc": {
      const stroke = strokeProps(item.stroke, sch.wire, px, selected, sch)
      const d = primitivePathData({ type: "arc", start: item.start, mid: item.mid, end: item.end, fill: false }) ?? ""
      return <path d={d} fill="none" {...stroke} />
    }
    case "bezier": {
      const stroke = strokeProps(item.stroke, sch.wire, px, selected, sch)
      const d = primitivePathData({ type: "bezier", points: item.points, fill: false }) ?? ""
      return <path d={d} fill={fillOf(item.fill, stroke.stroke, sch)} {...stroke} />
    }
    case "image": {
      const s = imageSize(item)
      return (
        <g transform={`translate(${item.x},${item.y}) scale(1,-1)`}>
          <image href={`data:image/png;base64,${item.data}`} x={-s.w / 2} y={-s.h / 2} width={s.w} height={s.h} preserveAspectRatio="none" />
          {selected && <rect x={-s.w / 2} y={-s.h / 2} width={s.w} height={s.h} fill="none" stroke={sch.select} strokeWidth={px} />}
        </g>
      )
    }
    case "table": {
      const border = strokeProps(item.border.stroke, sch.wire, px, selected, sch)
      const sep = strokeProps(item.separators.stroke, sch.wire, px, selected, sch)
      return (
        <g>
          {item.cells.map((c, i) => (
            <g key={i}>
              {c.fill && <polygon points={polygon(boxCorners(c, c.w, c.h, c.rot))} fill={fillOf(c.fill, ink, sch)} stroke="none" />}
              {c.text && <SheetText text={c.text} at={boxTextAt(c, c.margins, c.look)} rot={c.rot} look={c.look} fill={selected ? sch.select : ink} px={px} />}
            </g>
          ))}
          <TableLines item={item} border={border} sep={sep} />
        </g>
      )
    }
    case "junction": {
      const r = (item.diameter ?? 0.08) / 2
      return <circle cx={item.x} cy={item.y} r={r} fill={selected ? sch.select : (item.color ?? sch.junction)} />
    }
    case "noconnect": {
      const d = 0.06
      return (
        <g stroke={selected ? sch.select : sch.noConnect} strokeWidth={Math.max(sch.stroke, 1.4 * px)} strokeLinecap="round">
          <line x1={item.x - d} y1={item.y - d} x2={item.x + d} y2={item.y + d} />
          <line x1={item.x - d} y1={item.y + d} x2={item.x + d} y2={item.y - d} />
        </g>
      )
    }
  }
}

/** The lines of a table: its outer border, the line under its header row, and the lines between its rows and columns where they are on. */
function TableLines({ item, border, sep }: { item: Extract<SheetItem, { kind: "table" }>; border: ReturnType<typeof strokeProps>; sep: ReturnType<typeof strokeProps> }) {
  const lines: { a: Vec2; b: Vec2; kind: "border" | "sep" }[] = []
  // Each cell's own edges: the ones on the table's edge are the border, the others separators.
  const xs = item.cells.flatMap((c) => boxCorners(c, c.w, c.h, c.rot).map((p) => p.x))
  const ys = item.cells.flatMap((c) => boxCorners(c, c.w, c.h, c.rot).map((p) => p.y))
  const edge = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
  const eq = (a: number, b: number) => Math.abs(a - b) < 1e-6
  const headerBottom = item.cells.length ? Math.min(...item.cells.filter((c) => eq(c.y, edge.maxY)).map((c) => c.y - c.h)) : 0
  for (const c of item.cells) {
    const [p0, p1, p2, p3] = boxCorners(c, c.w, c.h, c.rot)
    const sides: [Vec2, Vec2][] = [
      [p0, p1],
      [p1, p2],
      [p2, p3],
      [p3, p0],
    ]
    for (const [a, b] of sides) {
      const horizontal = eq(a.y, b.y)
      const onEdge = horizontal ? eq(a.y, edge.minY) || eq(a.y, edge.maxY) : eq(a.x, edge.minX) || eq(a.x, edge.maxX)
      if (onEdge) {
        if (item.border.external) lines.push({ a, b, kind: "border" })
      } else if (horizontal ? item.separators.rows : item.separators.cols) lines.push({ a, b, kind: "sep" })
      else if (horizontal && item.border.header && eq(a.y, headerBottom)) lines.push({ a, b, kind: "border" })
    }
  }
  return (
    <g>
      {lines.map((l, i) => (
        <line key={i} x1={l.a.x} y1={l.a.y} x2={l.b.x} y2={l.b.y} {...(l.kind === "border" ? border : sep)} />
      ))}
    </g>
  )
}


/**
 * What KiCad draws over a symbol its flags mark (`SCH_PAINTER::draw` of a symbol): a cross over a part that
 * is not to be populated, and a frame round the body of one left out of simulation.
 */
export function FlagMarks({ c }: { c: ComponentInstance }) {
  const sch = useSch()
  if (!c.flags?.dnp && !c.flags?.excludeFromSim) return null
  const dnp = c.flags.dnp ? flagMarkBox(c) : null
  const sim = c.flags.excludeFromSim ? bodyBox(c) : null
  return (
    <g pointerEvents="none">
      {dnp && (
        <g stroke={sch.danger} strokeWidth={0.036} strokeLinecap="butt" opacity={0.85}>
          <line x1={dnp.minX} y1={dnp.minY} x2={dnp.maxX} y2={dnp.maxY} />
          <line x1={dnp.minX} y1={dnp.maxY} x2={dnp.maxX} y2={dnp.minY} />
        </g>
      )}
      {sim && <rect x={sim.minX - 0.006} y={sim.minY - 0.006} width={sim.maxX - sim.minX + 0.012} height={sim.maxY - sim.minY + 0.012} fill="none" stroke={sch.ink3} strokeWidth={0.012} strokeDasharray="0.04 0.03" />}
    </g>
  )
}
