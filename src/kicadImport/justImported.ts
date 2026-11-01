// A project a KiCad import has just made opens at once, and the editor then says so in one line
// (`ImportedNote`). The import screen marks the project here before it navigates, and the editor takes
// the mark when the project opens: in this tab's session, so it survives the page load into the editor
// and is shown once.

const KEY = "cherryblossom:editor:kicad-just-imported"

export function markJustImported(projectId: string) {
  try {
    sessionStorage.setItem(KEY, projectId)
  } catch {
    // storage blocked: the project opens all the same, without the line
  }
}

/** Whether the project was just made by an import; the mark is taken, so it is said once. */
export function takeJustImported(projectId: string): boolean {
  try {
    if (sessionStorage.getItem(KEY) !== projectId) return false
    sessionStorage.removeItem(KEY)
    return true
  } catch {
    return false
  }
}
