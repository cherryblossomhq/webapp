import type { PartIndexPart } from "@cherryblossom/api-contract"
import { join } from "node:path"
import { convertLibraries, type Imported } from "../src/model/kicad/library"

// KiCad's fixture libraries as the parts index would store them: converted once, then served as
// the wire part `GET /api/v1/parts/index/{id}` answers.

const FIXTURES = join(__dirname, "fixtures", "kicad")
const ATTRIBUTION = "Symbols, footprints and 3D models from the KiCad libraries (https://gitlab.com/kicad/libraries), © KiCad library contributors, CC BY-SA 4.0."

export const loadImported = (): Promise<Imported> => convertLibraries({ symbols: join(FIXTURES, "symbols"), footprints: join(FIXTURES, "footprints"), release: "10.0.7" })

export function storedPart(imported: Imported, key: string, id = "42"): PartIndexPart {
  const row = imported.parts.find((p) => p.key === key)
  const land = imported.lands.find((l) => l.key === row?.landKey)
  if (!row || !land) throw new Error(`${key} isn't in the converted fixtures`)
  return {
    id,
    source: "kicad",
    sourceKey: row.key,
    mpn: row.name,
    manufacturer: null,
    package: row.package,
    description: row.description || null,
    datasheet: row.datasheet,
    lcsc: null,
    keywords: row.keywords,
    refPrefix: row.refPrefix,
    category: row.category,
    pins: row.pins,
    land: land.land,
    verification: null,
    model3d: null,
    provenance: {
      converter: "kicad@1",
      release: row.release,
      footprint: row.footprintKey,
      licence: "CC-BY-SA-4.0 WITH KiCad-libraries-exception",
      attribution: ATTRIBUTION,
      fetchedAt: "2026-10-22T00:00:00.000Z",
    },
  }
}
