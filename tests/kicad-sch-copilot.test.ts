import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { hasKicadSymbols, systemMessageFor, UNITS_NOTE, KICAD_NET_NOTE } from "../src/ai/copilot"
import { TOOL_DEFINITIONS } from "../src/ai/tools"
import { EXAMPLES } from "../src/model/examples"
import { importSheet, place } from "./kicad-sch-parts"

// Sakura's prompt and tool kit are the same for every design drawn in the editor; the note about
// units and KiCad symbols is given only to a design that has such parts.

/** The system prompt as it is on main, as sha1 of its text: a design with no KiCad symbols is given exactly this. */
const BASE_SHA = "9ee8d03b8178fd16d349e4ebbad96253b3f39096"
/**
 * The prompt grew by one bullet (340 characters) that tells Sakura when to split a design into sheets and which tools do it; every design is given it, since a design with one sheet is where the first sheet is made.
 * Then 10 characters shorter: an empty sheet is tidied with whole_sheet rather than no blocks, which is the same to Sakura and the only way that works over MCP.
 * Then 164 characters longer: a bullet that keeps high-voltage nets apart with set_net_class, where an assistant raised every net's clearance instead.
 * Then 59 longer: the library holds basic parts only, so the bullet listing its specific parts says it has no chips and that find_part finds them.
 */
const BASE_CHARS = 10583
/** The tool definitions on main, as JSON bytes: what the KiCad import adds (the board's and the schematic's together) is small. */
const TOOLS_ON_MAIN = 35524
/** What the board lanes added on top of the join, in bytes: X2 (`set_board` takes an outline and cutouts, `place_parts` takes degrees: 617 bytes) and X3 (`set_pour` takes a polygon, a priority, a keepout and an id: 511 bytes); X1, X4 and X5 add the layers to `set_board` and the tracks (245 bytes); X10, X11, X12 and X14 add none. */
const BOARD_LANES_GROWTH = 1373
/**
 * What Sakura's sheet tools added, in bytes (5373, 12 bytes under the 5385 it was before the descriptions were cut): `add_sheet`, `edit_sheet`, `add_hier_label`, `wire_sheet_pin` and `show_sheet` (about 4.6k together, with their
 * descriptions cut to a sentence or two), and a `sheet` input on `add_component`, `group_parts`, `edit_block` and `draw` (about 70 bytes each), so a sheet can be built
 * on, not only read. The budget below was raised by exactly this and no more.
 */
const SHEET_TOOLS_GROWTH = 5373
/**
 * What `create_part`'s `land` added, in bytes: a land pad by pad (number, place, shape, size, drill, slot, paste and mask) or a KiCad
 * footprint's text, for a package no footprint string draws, which an assistant over MCP had no way to describe (a Phoenix 1777558's
 * offset middle pin). The schema's descriptions are cut to a few words each; the budget below was raised by exactly this.
 */
const DRAWN_LAND_GROWTH = 2178
/**
 * What an assistant's first 10 A board asked for, in bytes: `set_net_class` (1206), `draw_trace` (747) and `pcb_text` (689), which it had no
 * way to do (spacing by group of nets, a wide trace by hand, a silkscreen label), `set_design_rules`' thermal_gap (264) and
 * `set_net_width`'s word on necks (94), less what `create_part`'s description lost to fit within what Claude Code shows of it (788).
 * The budget below was raised by exactly this.
 */
const HAND_TOOLS_GROWTH = 2215

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
    // an imported design is named as KiCad names it, which has its own note after the one about units
    expect(blocks).toHaveLength(3)
    expect(createHash("sha1").update(blocks[0]).digest("hex")).toBe(BASE_SHA)
    expect(blocks[1]).toBe(UNITS_NOTE)
    expect(blocks[2]).toBe(KICAD_NET_NOTE)
    expect(KICAD_NET_NOTE.length).toBeLessThan(800)
    // a design drawn here with KiCad symbols only gets the note about units
    expect(text(systemMessageFor({ ...p, netNames: undefined }).content)).toHaveLength(2)
    expect(Array.isArray(msg.content) && msg.content[0].cache_control).toEqual({ type: "ephemeral" })
    expect(UNITS_NOTE.length).toBeLessThan(600)
  })

  it("keeps the growth of the tool descriptions and schemas small", () => {
    const size = Buffer.byteLength(JSON.stringify(TOOL_DEFINITIONS))
    expect(size - TOOLS_ON_MAIN - BOARD_LANES_GROWTH - SHEET_TOOLS_GROWTH - DRAWN_LAND_GROWTH - HAND_TOOLS_GROWTH).toBeLessThan(2100)
  })
})
