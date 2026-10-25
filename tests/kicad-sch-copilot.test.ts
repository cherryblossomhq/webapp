import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { hasKicadSymbols, systemMessageFor, UNITS_NOTE } from "../src/ai/copilot"
import { TOOL_DEFINITIONS } from "../src/ai/tools"
import { EXAMPLES } from "../src/model/examples"
import { importSheet, place } from "./kicad-sch-parts"

// Sakura's prompt and tool kit are the same for every design drawn in the editor; the note about
// units and KiCad symbols is given only to a design that has such parts.

/** The system prompt before slice 3b-i, as sha1 of its text (line ends as `\n`). */
const BASE_SHA = "43f54f62ff5c54f2c7772373ead2debe6b136f8d"
const BASE_CHARS = 9042
/** The tool definitions before slice 3b-i, as JSON: what the slice may add is small. */
const TOOLS_BEFORE = 29272

const text = (blocks: ReturnType<typeof systemMessageFor>["content"]) => (typeof blocks === "string" ? [blocks] : blocks.map((b) => b.text))

describe("Sakura's system prompt", () => {
  it("is byte for byte the old prompt for a design with no KiCad symbols, with no note about units", () => {
    for (const ex of EXAMPLES) {
      expect(hasKicadSymbols(ex.project), ex.id).toBe(false)
      const blocks = text(systemMessageFor(ex.project).content)
      expect(blocks).toHaveLength(1)
      expect(blocks[0]).toHaveLength(BASE_CHARS)
      expect(createHash("sha1").update(blocks[0]).digest("hex")).toBe(BASE_SHA)
    }
  })

  it("adds the note about units after the old prompt, which keeps its own cache breakpoint, for a design with a KiCad part", () => {
    const p = importSheet({ symbols: [place("Test:OPA2", "100 100", "U1", { unit: 1 })] })
    expect(hasKicadSymbols(p)).toBe(true)
    const msg = systemMessageFor(p)
    const blocks = text(msg.content)
    expect(blocks).toHaveLength(2)
    expect(createHash("sha1").update(blocks[0]).digest("hex")).toBe(BASE_SHA)
    expect(blocks[1]).toBe(UNITS_NOTE)
    expect(Array.isArray(msg.content) && msg.content[0].cache_control).toEqual({ type: "ephemeral" })
    expect(UNITS_NOTE.length).toBeLessThan(600)
  })

  it("keeps the growth of the tool descriptions and schemas small", () => {
    const size = JSON.stringify(TOOL_DEFINITIONS).length
    expect(size - TOOLS_BEFORE).toBeLessThan(1200)
  })
})
