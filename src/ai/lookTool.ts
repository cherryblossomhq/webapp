import { isHierarchical, sheetUses, useAt } from "../model/sheets"
import { resolvedComponents } from "../model/ruleAreas"
import { shownProject } from "../store/sheetScope"
import { preloadImages } from "../store/imageFiles"
import type { Project } from "../model/types"
import { lookRenderer, type Board3dView, type LookImage, type LookRenderer } from "./vision/encode"
import { frame, matchAspect, type FrameRequest } from "./vision/framing"
import { fitSize, imageTokens, MAX_IMAGE_BYTES } from "./vision/limits"
import { describePcb, describeSchematic, measurePcb, measureSchematic, pcbProblems, schematicProblems } from "./vision/measure"
import { DEFAULT_PCB_EXTRAS, PCB_EXTRAS, pcbSvg, type PcbExtra, type PcbSide } from "./vision/pcbSvg"
import { schematicSvg } from "./vision/schematicSvg"
import { fail, ok, type ToolContext, type ToolInput, type ToolSpec } from "./toolKit"
import { onBoard } from "../model/partFlags"

// `look`: a picture of the schematic, the PCB or the 3D board for the model, drawn off screen
// (nothing the user is looking at moves), with the numbers beside it. Models act on a number far
// more reliably than on a picture, so every problem the picture can show is also written out.
// The picture reaches the model in a user message after the tool results, since a Chat
// Completions tool result is text (see `copilot.ts`).

type Target = "schematic" | "pcb" | "3d"

interface Looked {
  /** The tool result: what is shown, the numbers, then notes on how it is drawn. */
  text: string
  image: LookImage | null
  /** How many problems the numbers name, for the transcript line. */
  problems: number
  target: Target
  what: string
}

type Prepared = Looked | { error: string }

const TARGET_NAMES: Record<Target, string> = { schematic: "the schematic", pcb: "the PCB", "3d": "the 3D board" }

const LIMIT_PREFIX = "You have used all"
/** The transcript line for a look refused because the request used up its pictures. */
export const LOOK_LIMIT_SUMMARY = "Look limit reached for this request"
const limitMessage = (max: number) =>
  `${LIMIT_PREFIX} ${max} pictures this request allows. Do not ask for more: tell the user plainly what you saw and what you changed, and that they can send another message to have you look again.`

const refList = (raw: unknown): string[] | undefined =>
  Array.isArray(raw) ? raw.filter((r): r is string => typeof r === "string" && r.trim() !== "") : undefined

function frameRequest(input: ToolInput): FrameRequest {
  const r = input.region as Record<string, unknown> | undefined
  return {
    refs: refList(input.refs),
    selection: input.selection === true,
    region: r ? { x: Number(r.x), y: Number(r.y), width: Number(r.width), height: Number(r.height) } : undefined,
  }
}

/** Make the picture, or say why not: a failed picture still leaves the model the numbers. */
async function makeImage(make: (r: LookRenderer) => Promise<LookImage>, ctx: ToolContext): Promise<{ image: LookImage | null; note: string }> {
  const { signal } = ctx
  const renderer = ctx.renderer ?? (await lookRenderer())
  if (!renderer) return { image: null, note: "No picture could be made here (this editor has nowhere to draw one). The numbers are all there is." }
  if (signal?.aborted) throw new Error("Stopped before the picture was made.")
  try {
    return { image: await make(renderer), note: "" }
  } catch (e) {
    if (signal?.aborted) throw e
    return { image: null, note: `No picture could be made: ${e instanceof Error ? e.message : String(e)} The numbers are all there is.` }
  }
}

/** Over MCP the picture is in the tool result itself; in Sakura's conversation, in a message after it (`vision/messages.ts`). */
const header = (what: string, noun: string, image: LookImage | null, ctx: ToolContext) =>
  image
    ? `${noun} showing ${what}. The picture (${image.width} x ${image.height}, about ${imageTokens(image).toLocaleString("en-US")} tokens) is ${ctx.standalone ? "after this text; if there is none" : "in the next message; if that message has no picture"}, go by the numbers.`
    : `${noun} showing ${what}.`

const SCHEMATIC_KEY =
  "Drawn on a light sheet: red symbols, blue wires and net labels, blue block frames with their titles, and the sheet's drawings (texts, lines and shapes) in their own colours; red dashed boxes outline overlaps (block frames included), wires through symbols and texts over symbols or block titles; hollow red circles are unconnected pins."

function pcbKey(side: PcbSide, extras: ReadonlySet<PcbExtra>) {
  const layers = side === "both" ? "both copper layers (top in front)" : `the ${side} copper layer only`
  return (
    `Drawn: ${layers}, ${extras.size ? [...extras].join(", ") : "copper only"}, from above (not mirrored). ` +
    "Red is top copper, blue bottom copper, cyan and pink the top and bottom silkscreen, white dashes unrouted connections, orange dashes overlapping parts, red dashes parts off the board, red circles check errors."
  )
}

async function look3d(project: Project, input: ToolInput, ctx: ToolContext): Promise<Looked> {
  if (!resolvedComponents(project).some((c) => c.pcb.placed && onBoard(c))) {
    throw new Error("Nothing is placed on the PCB yet, so the 3D board is empty. Run layout_pcb first.")
  }
  const side = (input.side as PcbSide | undefined) ?? "both"
  const view: Board3dView = side === "top" ? "top" : side === "bottom" ? "bottom" : "home"
  const m = measurePcb(project)
  const size = fitSize(4 / 3, input.detail === "high" ? "high" : "normal")
  const { image, note } = await makeImage((r) => r.board3d(project, view, size, MAX_IMAGE_BYTES), ctx)
  const from = { home: "from the front right, three-quarter", top: "from above", bottom: "from below" }[view]
  const lines = [header(`the whole board ${from}`, "A 3D render", image, ctx), ...describePcb(m)]
  if (input.refs || input.selection || input.region) lines.push("The 3D view always shows the whole board; refs, selection and region apply to the schematic and PCB.")
  if (note) lines.push(note)
  return { text: lines.join("\n"), image, problems: pcbProblems(m), target: "3d", what: "the whole board" }
}

async function lookFlat(whole: Project, target: "schematic" | "pcb", input: ToolInput, ctx: ToolContext): Promise<Looked> {
  // A design with sheets: the schematic is the sheet the editor shows (the picture says which); the PCB is the whole board.
  const project = target === "schematic" && isHierarchical(whole) ? shownProject(whole) : whole
  const framed = frame(project, target, frameRequest(input), ctx.selection?.() ?? [])
  const size = fitSize((framed.box.maxX - framed.box.minX) / (framed.box.maxY - framed.box.minY), input.detail === "high" ? "high" : "normal")
  const box = matchAspect(framed.box, size.width / size.height)
  let svg: string
  let numbers: string[]
  let key: string
  let problems: number
  if (target === "schematic") {
    const m = measureSchematic(project)
    svg = schematicSvg(project, box, size, m)
    numbers = describeSchematic(m)
    key = SCHEMATIC_KEY
    problems = schematicProblems(m)
  } else {
    const m = measurePcb(project)
    // A board's reference images are read from the file store first, so the picture has them (a board with none waits for nothing).
    if (project.images?.length) await preloadImages(project)
    const side = (input.side as PcbSide | undefined) ?? "both"
    const wanted = refList(input.layers)
    const extras = new Set<PcbExtra>(wanted ? wanted.filter((l): l is PcbExtra => (PCB_EXTRAS as string[]).includes(l)) : DEFAULT_PCB_EXTRAS)
    svg = pcbSvg(project, box, size, { side, extras }, m)
    numbers = describePcb(m)
    key = pcbKey(side, extras)
    problems = pcbProblems(m)
  }
  const { image, note } = await makeImage((r) => r.svg(svg, size, MAX_IMAGE_BYTES), ctx)
  const lines = [header(framed.what, target === "schematic" ? "The schematic" : "The PCB", image, ctx), ...(target === "schematic" && project !== whole ? [`This is the sheet ${useAt(whole, project.scope ?? "").human} of ${sheetUses(whole).length}; the editor shows it, and get_design lists the others.`] : []), ...numbers, key]
  if (framed.problem) lines.push(framed.problem)
  if (note) lines.push(note)
  return { text: lines.join("\n"), image, problems, target, what: framed.what }
}

export const lookTool: ToolSpec<Prepared> = {
  name: "look",
  description:
    "See the design: a picture of the schematic, the PCB (top, bottom or both) or the 3D board, drawn for you off screen, plus the numbers behind it (overlaps, parts off the board, unrouted connections, unconnected pins, bounds). " +
    "Look only after a big step (building or extending a circuit, tidying, layout_pcb, route_pcb), not after every edit, and at most a few times per request. Read the numbers first; the picture shows what they cannot: parts floating apart, labels on symbols, wires through bodies, empty board areas. " +
    'To read small text or check one area, zoom with refs (e.g. ["U1","C3"]), selection or region instead of looking at the whole thing again.',
  input_schema: {
    type: "object",
    properties: {
      target: { type: "string", enum: ["schematic", "pcb", "3d"], description: "What to look at" },
      side: {
        type: "string",
        enum: ["top", "bottom", "both"],
        description: "PCB: which copper layer to draw (both: top over bottom). 3D: the camera, from above, from below, or three-quarter (both). Default both. Not used for the schematic.",
      },
      layers: {
        type: "array",
        items: { type: "string", enum: [...PCB_EXTRAS] },
        description: "PCB only: what to draw besides copper and the board outline. Default silkscreen, ratsnest, labels, pours.",
      },
      refs: { type: "array", items: { type: "string" }, description: 'Zoom to these parts, e.g. ["U1", "C3"] (schematic and PCB)' },
      selection: { type: "boolean", description: "Zoom to what the user has selected" },
      region: {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } },
        required: ["x", "y", "width", "height"],
        description: "Zoom to a rectangle by its lower-left corner and size: schematic units (y up) or PCB millimetres",
      },
      detail: { type: "string", enum: ["normal", "high"], description: "high is a larger picture (about 1.6 times the tokens) for a crowded view; default normal" },
    },
    required: ["target"],
  },
  async prepare(project, input, ctx) {
    const budget = ctx.looks
    if (!budget) return { error: "Pictures are not available here." }
    if (budget.used >= budget.max) return { error: limitMessage(budget.max) }
    budget.used++
    try {
      const target = input.target as Target
      return target === "3d" ? await look3d(project, input, ctx) : await lookFlat(project, target, input, ctx)
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  },
  run(project, _input, prepared) {
    if (!prepared) return fail(project, "Pictures are not available here.")
    if ("error" in prepared) {
      const out = fail(project, prepared.error)
      return prepared.error.startsWith(LIMIT_PREFIX) ? { ...out, summary: LOOK_LIMIT_SUMMARY } : out
    }
    const { text, image, problems, target, what } = prepared
    const where = target === "3d" ? TARGET_NAMES[target] : `${TARGET_NAMES[target]}, ${what}`
    const summary = `Looked at ${where}${image ? "" : " (numbers only)"}: ${problems ? `${problems} problem(s)` : "no problems"}`
    return { ...ok(project, text, summary), ...(image && { images: [image] }) }
  },
}
