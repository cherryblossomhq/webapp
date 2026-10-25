import { parseSexpr } from "./kicad-census/sexpr.mjs"

// What KiCad 9.0's schematic parser accepts inside each drawing node of the sheet, read from
// eeschema/sch_io/kicad_sexpr/sch_io_kicad_sexpr_parser.cpp (9.0 branch): parseSchRectangle (start, end, stroke, fill,
// uuid), parseSchArc, parseSchCircle, parseSchPolyLine, parseSchBezier, parseSchTextBoxContent. Any other token
// makes KiCad 9 throw "Expecting ...", so the file does not open.
export const KICAD9_SHEET_TOKENS: Record<string, string[]> = {
  rectangle: ["start", "end", "stroke", "fill", "uuid"],
  arc: ["start", "mid", "end", "stroke", "fill", "uuid"],
  circle: ["center", "radius", "stroke", "fill", "uuid"],
  polyline: ["pts", "stroke", "fill", "uuid"],
  bezier: ["pts", "stroke", "fill", "uuid"],
  text_box: ["exclude_from_sim", "start", "end", "at", "size", "stroke", "fill", "margins", "effects", "uuid"],
}

/** The problems a KiCad 9 parser would throw on, one line each; empty when the sheet's drawing nodes are all fine. */
export function kicad9SheetProblems(text: string): string[] {
  const root = parseSexpr(text) as unknown[][]
  const sch = root[0] as unknown[]
  const out: string[] = []
  for (const node of sch.slice(1)) {
    if (!Array.isArray(node)) continue
    const allowed = KICAD9_SHEET_TOKENS[node[0] as string]
    if (!allowed) continue
    for (const kid of node.slice(1)) {
      if (Array.isArray(kid) && !allowed.includes(kid[0] as string)) out.push(`${node[0]}: KiCad 9 does not accept (${kid[0]} ...)`)
    }
  }
  return out
}
