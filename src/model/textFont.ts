import { kicadCjkLoaded, kicadFontLoaded, loadKicadFont, needsCjk } from "../lib/kicadFont/load"
import { valueText } from "./instances"
import type { Project } from "./types"

// When a project needs KiCad's stroke font. A project with KiCad text (a text with a layer, on the board or on a part) is
// laid out with KiCad's own glyphs, which are a module of their own (`lib/kicadFont`), loaded here and only here: a project
// with none, which is every board drawn in the editor, never fetches it and keeps drawing with the editor's own letters.

/** What the project's texts need: nothing, the Latin, Greek, Cyrillic and symbol tables, or the CJK table as well. */
export function textFontNeed(project: Project): "none" | "base" | "cjk" {
  let need: "none" | "base" | "cjk" = "none"
  const see = (s: string | undefined) => {
    if (s && need !== "cjk" && needsCjk(s)) need = "cjk"
  }
  for (const t of project.texts ?? []) {
    if (t.layer === undefined) continue
    if (need === "none") need = "base"
    see(t.text)
  }
  for (const c of project.components) {
    if (!c.texts?.length) continue
    if (need === "none") need = "base"
    for (const t of c.texts) see(t.text)
    see(c.ref)
    see(valueText(c))
    // A text can show a property (`${MPN}`), so what the properties hold is what it may draw.
    for (const v of Object.values(c.props)) see(v)
  }
  return need
}

/** Whether the font the project needs is not loaded yet. */
export function textFontMissing(project: Project): boolean {
  if (kicadFontLoaded() && kicadCjkLoaded()) return false
  const need = textFontNeed(project)
  return need === "base" ? !kicadFontLoaded() : need === "cjk" ? !kicadCjkLoaded() : false
}

/** Load what the project's texts need; true when something was loaded, so what was drawn before is to be drawn again. */
export async function ensureTextFont(project: Project): Promise<boolean> {
  if (!textFontMissing(project)) return false
  await loadKicadFont({ cjk: textFontNeed(project) === "cjk" })
  return true
}
