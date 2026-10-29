import { appendFileSync, writeFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { lookupFromSource } from "../src/model/lcscMatch"
import { cases } from "./kicad-roundtrip-cases"
import { compareTrip, exportAndImport, table, type Loss } from "./kicad-roundtrip-editor"
import { recordedSource } from "./fixtures/supplier/source"

// The editor's project to KiCad files and back, over every case, with the table of what was lost, by kind and count. The test says there is nothing in it; to see the
// table (and the first losses of each case) when there is:
//
//   LOSS_OUT=<file> [LOSS_N=<losses to list for each case>] [LOSS_RE=<kinds to list>] [LOSS_LCSC=0 for no LCSC step] npx vitest run tests/kicad-roundtrip-table.test.ts

const OUT = process.env.LOSS_OUT
const log = (s: string) => OUT && appendFileSync(OUT, `${s}\n`)

describe("an editor project written as KiCad files and read again: the table of losses", () => {
  it("has none in any case", async () => {
    if (OUT) writeFileSync(OUT, "")
    const all: Loss[][] = []
    for (const ex of cases()) {
      const t = await exportAndImport(ex.project, process.env.LOSS_LCSC === "0" ? undefined : lookupFromSource(recordedSource()))
      const c = compareTrip(t)
      all.push(c.losses)
      log(`== ${ex.id}: ${JSON.stringify(c.counts)}, ${c.losses.length} losses${t.lcscStats ? ` lcsc ${JSON.stringify(t.lcscStats)}` : ""}`)
      log(
        c.losses
          .filter((l) => new RegExp(process.env.LOSS_RE ?? ".").test(l.kind))
          .slice(0, Number(process.env.LOSS_N ?? 25))
          .map((l) => `   ${l.kind}: ${l.detail}`)
          .join("\n"),
      )
    }
    log(table(all))
    expect(all.flat()).toEqual([])
  }, 600_000)
})
