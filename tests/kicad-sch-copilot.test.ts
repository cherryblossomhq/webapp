import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { hasKicadSymbols, systemMessageFor, UNITS_NOTE, KICAD_NET_NOTE } from "../src/ai/copilot"
import { TOOL_DEFINITIONS } from "../src/ai/tools"
import { EXAMPLES } from "../src/model/examples"
import { importSheet, place } from "./kicad-sch-parts"

// Sakura's prompt and tool kit are the same for every design drawn in the editor; the note about
// units and KiCad symbols is given only to a design that has such parts.

/** The system prompt as it is on main, as sha1 of its text: a design with no KiCad symbols is given exactly this. */
const BASE_SHA = "bdba4cfa88cde49a8a089ea7908af2c96038ac01"
/**
 * The prompt grew by one bullet (340 characters) that tells Sakura when to split a design into sheets and which tools do it; every design is given it, since a design with one sheet is where the first sheet is made.
 * Then 10 characters shorter: an empty sheet is tidied with whole_sheet rather than no blocks, which is the same to Sakura and the only way that works over MCP.
 * Then 164 characters longer: a bullet that keeps high-voltage nets apart with set_net_class, where an assistant raised every net's clearance instead.
 * Then 59 longer: the library holds basic parts only, so the bullet listing its specific parts says it has no chips and that find_part finds them.
 * Then 401 longer: when to order blocks with arrange_blocks, draw a supply as labels or rename a net with edit_net, and draw by coordinates with
 * get_wiring and draw_wiring, which an assistant laying out a power board had none of.
 * Then 211 longer: set_clearance_rule for a part whose own pins sit closer than its class allows, or one pair of nets, which an assistant
 * on a mains board had no way to set.
 * Then 325 longer: save a version before a change that may be taken back and restore it to go back, never rebuild by hand, and that
 * Sakura can undo its own changes; on October 31 most of a session's replies were Sakura rebuilding earlier states by hand.
 * Then 280 longer: route current-carrying nets first with route_pcb nets, draw what still goes narrower with draw_trace from pin to pin, and
 * carry current in traces, not polygon pours; an assistant poured a rectifier board's bus and phases as strips.
 */
const BASE_CHARS = 11800
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

/** What X20 added, in bytes (432): `set_pour` takes `places` (a sheet, a class or a group a rule area holds), `update_component` takes `classes`, and `place_parts` says it keeps a part inside its area. No tool was added. */
const PLACEMENT_GROWTH = 432
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
/**
 * What an assistant drawing a power board's schematic by hand asked for, in bytes: `get_wiring` (814) and `draw_wiring` (1210), the sheet by
 * its coordinates, which it measured from pictures instead; `edit_net` (651), a rename that keeps the wires and a choice of labels or ports;
 * `arrange_blocks` (785), blocks in an order of its own; and get_design's pointer to get_wiring (64). The budget below was raised by exactly this.
 */
const SCHEMATIC_DRAWING_GROWTH = 3528
/**
 * What get_design's `block` and `refs` added, in bytes (330): a design past the 45,000 characters an answer may hold lists its parts and nets by
 * name, so a board of more than about 100 parts is read a block or some parts at a time. The budget below was raised by exactly this.
 */
const DESIGN_PARTS_GROWTH = 330
/**
 * What an assistant's MCP session on a mains board asked for, in bytes (1180): `set_clearance_rule` (1093), a clearance of its own for one
 * pair of nets or one part's pads, smaller than a class's where a relay's pins sit closer; and get_part_data's word on a part's size (87),
 * which it learned only by placing the part. The budget below was raised by exactly this.
 */
const CLEARANCE_RULES_GROWTH = 1180
/**
 * What going back asked for, in bytes (2165): `save_version`, `list_versions`, `restore_version` and `undo`, the checkpoints and undo a
 * session that rebuilt earlier states by hand 110 times in 212 replies had none of. The budget below was raised by exactly this.
 */
const VERSION_TOOLS_GROWTH = 2165
/**
 * What routing power in traces asked for, in bytes (910): `route_pcb` takes `nets` and says a pad joins its pour by a trace too (314), to route current-carrying nets first, and
 * `draw_trace` takes `from` and `to` pins (596), since it took only coordinates and no tool says where a pad's centre is, so an
 * assistant poured its supply nets as polygons instead. The budget below was raised by exactly this.
 */
const POWER_ROUTING_GROWTH = 910

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
    expect(size - TOOLS_ON_MAIN - BOARD_LANES_GROWTH - SHEET_TOOLS_GROWTH - PLACEMENT_GROWTH - DRAWN_LAND_GROWTH - HAND_TOOLS_GROWTH - SCHEMATIC_DRAWING_GROWTH - DESIGN_PARTS_GROWTH - CLEARANCE_RULES_GROWTH - VERSION_TOOLS_GROWTH - POWER_ROUTING_GROWTH).toBeLessThan(2100)
  })
})
