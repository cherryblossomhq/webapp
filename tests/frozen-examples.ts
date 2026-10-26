import { readFileSync } from "node:fs"
import { join } from "node:path"
import { TEMPLATES } from "../src/model/templates"
import type { Project } from "../src/model/types"

// The shipped examples as they were drawn before Tidy redraws them (October 2026), kept as
// fixtures. The tests that hold edits to a rate (fewer than 5% of turns refused, say) run on these,
// so the rate keeps measuring the guard and not the drawing: a tidied sheet packs parts closer,
// and a big jump there lands on a neighbour's wire, which is refused as it should be. The shipped
// examples themselves are still held to the rules that don't depend on how they are drawn (no
// net broken, a refusal says why).

const DIR = join(__dirname, "fixtures", "examples-before-tidy")

export const FROZEN_EXAMPLES: { id: string; project: Project }[] = TEMPLATES.map(({ id }) => ({
  id,
  project: JSON.parse(readFileSync(join(DIR, `${id}.json`), "utf8")) as Project,
}))
