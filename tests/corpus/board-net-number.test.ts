import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { EXTENSION_NAMES, importKicadBoard } from "../../src/model/kicad/board"
import { CORPUS } from "./shared"

const ALL = new Set(Object.keys(EXTENSION_NAMES))

describe.skipIf(!CORPUS)("the corpus board with a bad net number on a footprint drawing", () => {
  it("WCL-INU slave.kicad_pcb is read, not refused as unreadable", () => {
    const file = join(CORPUS!, "projects/WCL-INU__beehive_temperature_humidity_x27_SHT40_PCB/slave/slave.kicad_pcb")
    if (!existsSync(file)) return
    const text = readFileSync(file, "utf8")
    const real = importKicadBoard(text)
    expect(real.status === "refused" && real.reason === "unreadable").toBe(false)
    expect(real.report.entries.some((e) => e.code === "unreadable-value")).toBe(false)
    const all = importKicadBoard(text, { built: ALL })
    expect(all.status === "refused" && all.reason === "unreadable").toBe(false)
  })
})
