// A sub-step of the step from version 2 to 3 (see `projectFile.ts`): hierarchical sheets (S1). A version 2 project is one sheet, which version 3 calls the root sheet: it is listed
// as `{ id: "root" }`, and its parts, wires, labels and drawings, which name no sheet, are on it. Nothing else is rewritten: a
// project with no sheet symbols draws and connects exactly as it did. The bump is what keeps an older reader, which would drop the
// sheets, the sheet symbols and the hierarchical labels of a version 3 document and save the loss back, from opening one.

type Json = Record<string, unknown>

export function sheetsRoot(project: Json): Json {
  if (Array.isArray(project.sheets) && project.sheets.length) return project
  return { ...project, sheets: [{ id: "root" }] }
}
