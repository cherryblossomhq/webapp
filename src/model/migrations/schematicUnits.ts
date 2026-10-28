/**
 * A sub-step of the step from version 2 to 3 of the project file (October 2026): the KiCad schematic import (see `projectFile.ts`).
 *
 * Symbols with units, body styles, a mirror, fields with a place of their own, chosen pin alternates, and
 * symbol drawings kept in the project; a label's `kind`, `shape`, `look`, `fields` and `fieldsAutoplaced`; the
 * project's `netNames` (KiCad's names for its nets); a wire's `look`; a block's `locked`; and the sheet's
 * drawings widened to what a KiCad sheet draws (arcs, curves, circles, text boxes, pictures, tables, junction
 * dots and no-connect flags, and a stroke, fill and text look said exactly). Every one of those is a new
 * optional field, and a version 2 document has none of them, so for a document that came from the board track
 * or from before the schematic one the step changes no value; it only says that what comes after it may hold
 * them, which is what an older reader would have dropped on its next save.
 *
 * Two shapes that only a development build of the schematic track wrote are
 * rewritten here, so such a file opens in the joined editor:
 *
 * - a component's symbol flags (`flags: { inBom: false, onBoard: false, inPosFiles: false, dnp, excludeFromSim,
 *   fieldsAutoplaced }`) become the one set of part flags (`excludeFromBom`, `notOnBoard`, `excludeFromPos`, `dnp`,
 *   `excludeFromSim`, all `true` when set) with `fieldsAutoplaced` on the component itself; where a component
 *   also has flags in the new shape (a board's footprint attributes), the two are joined and a key the new shape
 *   already says is kept;
 * - the sheet's `items` (each with a `kind`) become `drawings` (each with a `type`), after the drawings the
 *   drawing tools made: a polyline is a line, a rectangle a box by its lower-left corner and size, a circle has
 *   its centre as `x`, `y` and a `radius`, a text keeps its anchor and says its justification and look as the
 *   drawing's own fields, a fill is `paint`, a junction's colour is `dotColor`.
 *
 * Plain JSON in and out, and frozen: it imports nothing from the live model.
 */

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v)

/** A component's flags in the one shape, with the old shape's keys rewritten; and `fieldsAutoplaced` moved onto the component. */
function mergeComponent(c: Json): Json {
  if (!isObject(c.flags)) return c
  const { inBom, onBoard, inPosFiles, fieldsAutoplaced, ...rest } = c.flags
  const legacy = inBom === false || onBoard === false || inPosFiles === false || fieldsAutoplaced === true
  if (!legacy) return c
  const flags: Json = { ...rest }
  if (inBom === false) flags.excludeFromBom = true
  if (onBoard === false) flags.notOnBoard = true
  if (inPosFiles === false) flags.excludeFromPos = true
  const { flags: _old, ...component } = c
  void _old
  return { ...component, ...(Object.keys(flags).length ? { flags } : {}), ...(fieldsAutoplaced === true ? { fieldsAutoplaced: true } : {}) }
}

const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback)

/** One of the old sheet items as a drawing, or null when it is not one this step knows (it is dropped, as the reader would have). */
function itemToDrawing(item: Json): Json | null {
  const { kind, fill, stroke, look, color, ...rest } = item
  const withStroke = (own: boolean): Json => ({ ...(isObject(stroke) ? { stroke } : own ? { stroke: {} } : {}), ...(isObject(fill) ? { paint: fill } : {}) })
  switch (kind) {
    case "text": {
      const l = isObject(look) ? look : {}
      const pen: Json = { ...(typeof l.thickness === "number" ? { width: l.thickness } : {}), ...(typeof l.color === "string" ? { color: l.color } : {}) }
      const { rot, ...r } = rest
      return {
        ...r,
        type: "text",
        size: num(l.size, 0.1),
        align: l.h === "left" || l.h === "right" ? l.h : "center",
        valign: l.v === "top" ? "top" : l.v === "bottom" ? "bottom" : "middle",
        ...(rot === 90 || rot === 180 || rot === 270 ? { rot } : {}),
        ...(l.bold === true ? { bold: true } : {}),
        ...(l.italic === true ? { italic: true } : {}),
        ...(typeof l.face === "string" ? { face: l.face } : {}),
        ...(l.mirror === true ? { mirror: true } : {}),
        ...(typeof l.href === "string" ? { href: l.href } : {}),
        ...(l.hidden === true ? { hidden: true } : {}),
        ...(typeof l.lineSpacing === "number" ? { lineSpacing: l.lineSpacing } : {}),
        ...(Object.keys(pen).length ? { stroke: pen } : {}),
      }
    }
    case "textbox":
      return { ...rest, type: "textbox", ...(isObject(look) ? { look } : {}), ...withStroke(false) }
    case "polyline":
      return { ...rest, type: "line", ...withStroke(true) }
    case "rectangle": {
      const { a, b, radius, ...r } = rest
      if (!isObject(a) || !isObject(b)) return null
      const [ax, ay, bx, by] = [num(a.x, 0), num(a.y, 0), num(b.x, 0), num(b.y, 0)]
      return { ...r, type: "rect", x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay), ...(typeof radius === "number" && radius > 0 ? { radius } : {}), ...withStroke(true) }
    }
    case "circle": {
      const { c, r: radius, ...r } = rest
      if (!isObject(c)) return null
      return { ...r, type: "circle", x: c.x, y: c.y, radius, ...withStroke(false) }
    }
    case "arc":
    case "bezier":
      return { ...rest, type: kind, ...withStroke(false) }
    case "image":
    case "table":
    case "noconnect":
      return { ...rest, type: kind }
    case "junction":
      return { ...rest, type: "junction", ...(typeof color === "string" ? { dotColor: color } : {}) }
  }
  return null
}

export function schematicUnits(project: Json): Json {
  const components = Array.isArray(project.components) ? project.components.map((c) => (isObject(c) ? mergeComponent(c) : c)) : project.components
  const { items, ...rest } = project
  const converted = Array.isArray(items) ? items.flatMap((i) => (isObject(i) ? (itemToDrawing(i) ?? []) : [])) : []
  const drawings = [...(Array.isArray(project.drawings) ? project.drawings : []), ...converted]
  return {
    ...rest,
    ...(project.components !== undefined ? { components } : {}),
    ...(drawings.length ? { drawings } : {}),
  }
}
