/**
 * Version 2 to 3 of the project file (October 2026): symbols with units, body styles, a mirror,
 * fields with a place of their own, chosen pin alternates, and symbol drawings kept in the project.
 *
 * Every one of those is a new optional field, and a version 2 document has none of them: its parts
 * are the discrete symbols and boxes the editor draws, its components are placed unit 1, body style
 * 1, not mirrored, with their reference and value where the symbol has them. So the step changes no
 * value; it only says that what comes after it may hold them, which is what an older reader would
 * have dropped on its next save.
 *
 * Slice 3b-ii adds to the same step, all optional fields a version 2 document does not have: a label's
 * `kind`, `shape`, `look`, `fields` and `fieldsAutoplaced`, the project's `netNames` (KiCad's names for
 * its nets), a wire's `look`, `items` (text, text boxes, drawings, pictures, tables, junction dots and
 * no-connect flags of their own), a component's `flags` (do not populate, not in the BOM, not on the board,
 * not simulated, not in the position file) and a block's `locked`. Each is read only when it says
 * something, and an older reader would drop them on its next save.
 *
 * Plain JSON in and out, and frozen.
 */

type Json = Record<string, unknown>

export function schematicUnits(project: Json): Json {
  return project
}
