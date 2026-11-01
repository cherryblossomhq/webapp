import { boxesOverlap, round, snap } from "../lib/geometry"
import { blockFrames, contentsOf, findBlock, lockedBlockOf, type BlockFrame } from "../model/blocks"
import { moveDrawing, updateDrawings } from "../model/drawings"
import { schematicBounds } from "../model/instances"
import { dragSelection } from "../model/schematicEdit"
import { SCH_GRID } from "../model/symbols"
import { BLOCK_GAP } from "../model/tidy"
import type { Project, SchematicBlock, Vec2 } from "../model/types"
import { getConnectivity } from "../store/analysis"
import { SHEET_ARG } from "./sheetTools"
import { fail, ok, type ToolSpec } from "./toolKit"
import { schematicContent } from "./vision/framing"

// `arrange_blocks`: the blocks of a sheet put in rows the caller chooses. A whole-sheet tidy picks
// its own reading order by signal flow, and an assistant that wanted another (inputs on the left
// where tidy put the mirrored connectors on the right) had no way to say so but one edit_block
// move per block, each worked out from frames it had to read first.

const snapSch = (n: number) => round(snap(n, SCH_GRID))

/** Clear of everything on the sheet, where blocks wait between their old places and their new ones. */
const STAGING_MARGIN = 10

const blockNames = (project: Project) => (project.blocks ?? []).map((b) => b.name).join(", ") || "none yet"

const frameText = (f: BlockFrame) => `${f.name} x ${f.box.minX} to ${f.box.maxX}, y ${f.box.minY} to ${f.box.maxY}`

/** The blocks moved whole by `delta`, as dragging a title moves one: refused, with why, where the move would join or cut nets. */
function moveWhole(project: Project, blockIds: string[], delta: Vec2): { project: Project } | { error: string } {
  const held = contentsOf(project, blockIds)
  const moved = dragSelection(project, held, delta, { conn: getConnectivity })
  if (!moved.ok) return { error: moved.message }
  return { project: updateDrawings(moved.project, held.drawings, (d) => moveDrawing(d, delta)) }
}

export const arrangeBlocksTool: ToolSpec = {
  name: "arrange_blocks",
  description:
    "Put the schematic's blocks in rows: rows lists block names, each row left to right, rows top to bottom; frames top-aligned, gap apart (default 0.5), from the named blocks' top-left. Blocks not named go in a last row below. Each block moves whole, as edit_block move_by moves one; a move that would join or cut nets refuses the call. The reply gives each frame.",
  input_schema: {
    type: "object",
    properties: {
      rows: {
        type: "array",
        minItems: 1,
        items: { type: "array", items: { type: "string" }, minItems: 1 },
        description: 'e.g. [["DC IN", "DC BUS"], ["AC IN", "PHASE A"]]',
      },
      gap: { type: "number" },
      sheet: SHEET_ARG,
    },
    required: ["rows"],
  },
  run: (project, input) => {
    const gapIn = input.gap === undefined ? BLOCK_GAP : Number(input.gap)
    if (!Number.isFinite(gapIn) || gapIn < 0) return fail(project, "gap is a distance between frames: 0 or more")
    const gap = snapSch(gapIn)

    // Each row's blocks, by name, each block once.
    const rows: SchematicBlock[][] = []
    const seen = new Set<string>()
    const unknown: string[] = []
    for (const [i, row] of (input.rows as string[][]).entries()) {
      const names = row.map((n) => String(n).trim()).filter(Boolean)
      if (!names.length) return fail(project, `Row ${i + 1} is empty: give each row at least one block`)
      const found: SchematicBlock[] = []
      for (const name of names) {
        const block = findBlock(project, name)
        if (!block) {
          unknown.push(name)
          continue
        }
        if (seen.has(block.id)) return fail(project, `${block.name} is named twice: give each block once`)
        seen.add(block.id)
        found.push(block)
      }
      rows.push(found)
    }
    if (unknown.length) return fail(project, `No block ${unknown.join(", ")}. Blocks: ${blockNames(project)}`)

    const frames = blockFrames(project)
    const frameOf = new Map(frames.map((f) => [f.id, f]))
    const empty = rows.flat().filter((b) => !frameOf.has(b.id))
    if (empty.length) return fail(project, `${empty.map((b) => b.name).join(", ")} ${empty.length > 1 ? "have" : "has"} no parts on this sheet, so no frame to place`)

    // Blocks not named would otherwise be left where the rows may land: they go in a row of their own below.
    const rest = frames.filter((f) => !seen.has(f.id)).sort((a, b) => a.box.minX - b.box.minX || b.box.maxY - a.box.maxY)
    const layout = [...rows.map((row) => row.map((b) => frameOf.get(b.id)!)), ...(rest.length ? [rest] : [])]

    // Where each frame's top-left goes: frames are on the grid, so with the gap on it too, so is every corner.
    const named = rows.flat().map((b) => frameOf.get(b.id)!)
    const left = Math.min(...named.map((f) => f.box.minX))
    let top = Math.max(...named.map((f) => f.box.maxY))
    const target = new Map<string, Vec2>()
    let right = left
    for (const row of layout) {
      let x = left
      let height = 0
      for (const f of row) {
        target.set(f.id, { x, y: top })
        x = round(x + f.box.maxX - f.box.minX + gap)
        right = Math.max(right, x)
        height = Math.max(height, f.box.maxY - f.box.minY)
      }
      top = round(top - height - gap)
    }
    const deltaOf = (f: BlockFrame): Vec2 => {
      const t = target.get(f.id)!
      return { x: snapSch(t.x - f.box.minX), y: snapSch(t.y - f.box.maxY) }
    }
    const moving = layout.flat().filter((f) => {
      const d = deltaOf(f)
      return d.x !== 0 || d.y !== 0
    })
    const order = layout.flat()
    if (!moving.length) return ok(project, `The blocks are already in those rows. Frames: ${order.map(frameText).join("; ")}.`, "Blocks already arranged")

    const locked = lockedBlockOf(project, moving.flatMap((f) => f.contents.components))
    if (locked) return fail(project, `${locked} is a locked group, so its parts can't be moved. Unlock it first, or leave it out.`)

    // Blocks are moved one at a time, and one dropped on its new place could land on another not
    // moved yet: a pin on its wire, a stray part put in line. So with more than one to move, they
    // first go together, as they stand, clear of everything (the sheet and the rows alike), and
    // then each to its place, where nothing is any more.
    let next = project
    if (moving.length > 1) {
      const sheet = schematicContent(project)!
      const from = Math.min(...moving.map((f) => f.box.minX))
      const staged = moveWhole(next, moving.map((f) => f.id), { x: snapSch(Math.max(sheet.maxX, right) + STAGING_MARGIN - from), y: 0 })
      if ("error" in staged) return fail(project, `Did not arrange the blocks: ${staged.error} Nothing was changed.`)
      next = staged.project
    }
    for (const f of moving) {
      const now = blockFrames(next).find((x) => x.id === f.id)
      if (!now) return fail(project, `Did not arrange the blocks: ${f.name} lost its frame on the way. Nothing was changed.`)
      const moved = moveWhole(next, [f.id], deltaOf(now))
      if ("error" in moved) return fail(project, `Did not arrange the blocks: moving ${f.name}, ${moved.error} Nothing was changed.`)
      next = moved.project
    }

    const after = new Map(blockFrames(next).map((f) => [f.id, f]))
    const placed = order.map((f) => after.get(f.id)).filter((f): f is BlockFrame => !!f)
    const said = [`Arranged ${placed.length} blocks in ${layout.length} row${layout.length === 1 ? "" : "s"}: ${placed.map(frameText).join("; ")}.`]
    if (rest.length) said.push(`Not named, so put in the last row: ${rest.map((f) => f.name).join(", ")}.`)
    // Parts in no block stay where they were drawn, and a frame may have landed over one.
    const held = new Set([...after.values()].flatMap((f) => f.contents.components))
    const under = next.components.filter((c) => !held.has(c.id) && placed.some((f) => boxesOverlap(schematicBounds(c), f.box)))
    if (under.length) said.push(`In no block and now inside a frame: ${under.map((c) => c.ref).join(", ")}; move them or group them.`)
    return ok(next, said.join(" "), `Arranged ${placed.map((f) => f.name).join(", ")}`)
  },
}
