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
 * Plain JSON in and out, and frozen.
 */

type Json = Record<string, unknown>

export function schematicUnits(project: Json): Json {
  return project
}
