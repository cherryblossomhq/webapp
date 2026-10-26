import type { MeResponse } from "@cherryblossom/api-contract"
import { createHash } from "node:crypto"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { clearHistory, runCopilot } from "../../src/ai/copilot"
import { connectManagedAi } from "../../src/ai/managedAi"
import { executeTool, runTool, TOOL_DEFINITIONS } from "../../src/ai/tools"
import { setLookRenderer, type LookRenderer } from "../../src/ai/vision/encode"
import { newLookBudget } from "../../src/ai/vision/limits"
import { placedComponents } from "../../src/editor/three/buildBoard"
import { buildBoardTextures } from "../../src/editor/three/boardTextures"
import { buildFabricationFiles, slugify } from "../../src/export/bundle"
import { circuitJsonFile } from "../../src/export/circuitJson"
import { kicadFiles } from "../../src/export/kicad"
import { componentMatrix, stepBoard } from "../../src/export/step3d"
import { autoroute } from "../../src/model/autoroute"
import { cleanupSheet } from "../../src/model/cleanup"
import { computeConnectivity } from "../../src/model/connectivity"
import { registerProjectParts } from "../../src/model/customParts"
import { runErc } from "../../src/model/erc"
import { EXAMPLES } from "../../src/model/examples"
import { pcbPads, isPhysical } from "../../src/model/instances"
import { findPart } from "../../src/model/library"
import { createProject, freeSchematicSpot, removeItems, updateComponent } from "../../src/model/ops"
import { analyzePcb } from "../../src/model/pcb"
import { parseProjectFile, serializeProject } from "../../src/model/projectFile"
import { pasteItems, rotateSelection } from "../../src/model/schematicEdit"
import { routeAroundStitching } from "../../src/model/stitch"
import { tidySchematic } from "../../src/model/tidy"
import type { Project, Rotation } from "../../src/model/types"
import { withStableIds } from "../../src/lib/id"
import { useAccount } from "../../src/store/accountStore"
import { useProjectStore } from "../../src/store/projectStore"
import { DEFAULT_SETTINGS } from "../../src/store/settings"
import { useUi } from "../../src/store/uiStore"

// Golden outputs. For every shipped example, as shipped and with one part unplaced, moved and
// turned, and flipped to the bottom, this computes what a user or Sakura is shown (the saved file,
// the checks, the fabrication files, the exports, what Sakura reads and sees, the 3D board's
// drawing, and the results of a few edits) with the editor's own functions, and compares a sha256
// of each with `editor-examples.golden.json`. A change that alters any of them fails here, naming
// the output.
//
//   UPDATE_GOLDEN=1   write the golden files instead of comparing (run it after an intended change,
//                     with GOLDEN_FULL=1 so the slow outputs are written too; review the diff)
//   GOLDEN_FULL=1     also run the slow outputs (see SLOW below)
//
// Writing the golden file computes every output twice and requires the same, so nothing in it is
// there unless it is reproducible; a plain run does the same check whenever an output differs.
// What is masked is listed in MASKS and written to the golden file.

const HERE = dirname(fileURLToPath(import.meta.url))
const GOLDEN = join(HERE, "editor-examples.golden.json")
const TEXTS = join(HERE, "editor-examples.texts.json")
const UPDATE = process.env.UPDATE_GOLDEN === "1"
const FULL = process.env.GOLDEN_FULL === "1"

/** Outputs behind GOLDEN_FULL: an example and an output name, as "example/output". Only the shipped variant has them. */
const SLOW = new Set<string>(["esp32-robot/edit.autoroute"])

/** Small text outputs keep their text beside the hash, so a failure can show what changed. */
const KEEP_TEXT_UP_TO = 6000

const MASKS = [
  "project.file, project.roundtrip, and every edit's project: the file's \"version\" digit, so a format bump alone does not change a hash (the migration is tested in project-file.test.ts). The id, createdAt and updatedAt are not in the file at all.",
  "kicad.*: every uuid (8-4-4-4-12 hex, wherever written, so which element shares which uuid is not checked) and every ISO timestamp (the .kicad_pro \"created\" and \"modified\") and the title block date (an edit stamps today, in UTC), since the converter makes them from random numbers and the clock. Nothing else.",
  "edits (tidy, clean up, paste, delete, rotate, autoroute): ids the edit makes are numbered from zero (withStableIds), as the shipped examples are built, since a real id carries the time and a random number.",
]

// ---------- hashing and text ----------

let last = Date.now()
/** GOLDEN_TIMING=<file> appends how long each group of outputs took to that file. */
const tick = (label: string) => {
  if (process.env.GOLDEN_TIMING) appendFileSync(process.env.GOLDEN_TIMING, `  ${label}: ${Date.now() - last} ms
`)
  last = Date.now()
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex")

/** JSON with maps and sets written as sorted entries, so analysis results can be hashed. */
function stable(value: unknown): string {
  return JSON.stringify(
    value,
    (_k, v) => {
      if (v instanceof Map) return { map: [...v.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))) }
      if (v instanceof Set) return { set: [...v].sort() }
      return v
    },
    1,
  )
}

const maskVersion = (text: string) => text.replace(/^(\{"format":"cherryblossom\.project","version":)\d+/, "$1V")

/** The converter's uuids (any 8-4-4-4-12 hex id, wherever it is written), ISO timestamps and the title block date. */
const maskKicad = (text: string) =>
  text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "UUID")
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "TIMESTAMP")
    .replace(/\(date "\d{4}-\d\d-\d\d"\)/g, '(date "DATE")')

const file = (p: Project) => maskVersion(serializeProject(p))

// ---------- variants ----------

const physical = (p: Project) => p.components.filter((c) => c.pcb.placed && isPhysical(findPart(c.partId)))

/** Which part each variant changes: the first, second and third placed part, by the file's order. */
function variantsOf(p: Project): [string, Project][] {
  const parts = physical(p)
  const [a, b, c] = parts
  return [
    ["shipped", p],
    ["unplaced", updateComponent(p, a.id, { pcb: { placed: false } })],
    ["moved-turned", updateComponent(p, b.id, { pcb: { x: b.pcb.x + 2.5, y: b.pcb.y - 1.5, rot: ((b.pcb.rot + 90) % 360) as Rotation } })],
    ["flipped", updateComponent(p, c.id, { pcb: { side: c.pcb.side === "top" ? "bottom" : "top" } })],
  ]
}

// ---------- the 3D board texture, against a fake canvas ----------

/** Records every property set and every call on the board texture's 2D canvases, in order. */
function recordTextures(project: Project): string {
  const log: string[] = []
  const arg = (v: unknown) => (typeof v === "object" ? JSON.stringify(v) : String(v))
  let canvases = 0
  const fakeDocument = {
    createElement(tag: string) {
      const id = canvases++
      const canvas = {
        tag,
        width: 0,
        height: 0,
        getContext(kind: string, opts: unknown) {
          log.push(`c${id}.getContext(${kind},${arg(opts)}) size ${canvas.width}x${canvas.height}`)
          const state: Record<string, unknown> = {}
          return new Proxy(state, {
            get: (_t, prop: string) => (prop in state ? state[prop] : (...args: unknown[]) => void log.push(`c${id}.${prop}(${args.map(arg).join(",")})`)),
            set: (_t, prop: string, v) => {
              state[prop] = v
              log.push(`c${id}.${prop}=${arg(v)}`)
              return true
            },
          })
        },
      }
      return canvas
    },
  }
  vi.stubGlobal("document", fakeDocument)
  try {
    const placed = placedComponents(project)
    const set = buildBoardTextures({
      project,
      placed,
      padsByComponent: new Map(placed.map((c) => [c.id, pcbPads(c)])),
      fills: analyzePcb(project, computeConnectivity(project)).zoneFills,
      anisotropy: 1,
    })
    set.dispose()
  } finally {
    vi.unstubAllGlobals()
  }
  return log.join("\n")
}

// ---------- what Sakura sees ----------

const seen: string[] = []
const fakeRenderer: LookRenderer = {
  async svg(svg, size) {
    seen.push(svg)
    return { mediaType: "image/png", base64: "", width: size.width, height: size.height, bytes: 0 }
  },
  async board3d(_project, _view, size) {
    return { mediaType: "image/png", base64: "", width: size.width, height: size.height, bytes: 0 }
  },
}

/** A look as the tool runs it: the numbers it answers with, then the SVG it drew. */
async function look(project: Project, input: Record<string, unknown>): Promise<string> {
  seen.length = 0
  const out = await executeTool(project, () => project, "look", input, { looks: newLookBudget() })
  return `${out.result}\n----\n${seen.join("\n====\n")}`
}

// ---------- the outputs of one design ----------

type Outputs = Record<string, string>

async function designOutputs(project: Project): Promise<Outputs> {
  const out: Outputs = {}
  const conn = computeConnectivity(project)
  const refOf = new Map(project.components.map((c) => [c.id, c.ref]))

  // The project.
  out["project.file"] = file(project)
  const again = parseProjectFile(serializeProject(project), { id: project.id })
  out["project.roundtrip"] = file(again)
  expect(serializeProject(again), "load then save is identical").toBe(serializeProject(project))

  tick("project")
  // Checks.
  out["checks.nets"] = stable(conn.nets.map((n) => ({ name: n.name, named: n.named, pins: n.pins.map((p) => `${refOf.get(p.componentId)}.${p.pin}`).sort() })))
  out["checks.erc"] = stable(runErc(project, conn))
  const pcb = analyzePcb(project, conn)
  out["checks.pcb-analysis"] = stable({ ratsnest: pcb.ratsnest, items: pcb.items, island: pcb.island, islandNet: pcb.islandNet, traceNet: pcb.traceNet, viaNet: pcb.viaNet, zoneFills: pcb.zoneFills })
  out["checks.drc"] = stable(pcb.violations)
  out["checks.run_checks"] = runTool(project, "run_checks", {}).result

  tick("checks")
  // Fabrication files, as the download writes them.
  const base = slugify(project.name)
  for (const [name, text] of Object.entries(buildFabricationFiles(project))) out[`fab.${name.startsWith(`${base}-`) ? name.slice(base.length + 1) : name}`] = text

  tick("fab")
  // Exports.
  const kicad = await kicadFiles(project)
  for (const [name, text] of Object.entries(kicad.files)) out[`kicad.${name.slice(name.lastIndexOf(".") + 1)}`] = maskKicad(text)
  out["kicad.notes"] = kicad.notes.join("\n")
  tick("kicad")
  const cj = circuitJsonFile(project)
  out["circuit-json.file"] = cj.text
  out["circuit-json.notes"] = cj.notes.join("\n")
  out["step.board-solid"] = stable({ board: stepBoard(project), parts: placedComponents(project).map((c) => ({ ref: c.ref, matrix: componentMatrix(project, c).elements })) })

  tick("circuit-json+step")
  // Sakura: what it reads, and what it sees.
  out["sakura.get_design"] = runTool(project, "get_design", {}).result
  out["sakura.look-pcb-both"] = await look(project, { target: "pcb", side: "both" })
  out["sakura.look-pcb-top"] = await look(project, { target: "pcb", side: "top" })
  out["sakura.look-pcb-bottom"] = await look(project, { target: "pcb", side: "bottom" })
  out["sakura.look-schematic"] = await look(project, { target: "schematic" })

  tick("sakura")
  // 3D.
  out["3d.board-texture-drawing"] = recordTextures(project)

  tick("3d")
  return out
}

/** Edits, run on a fresh copy each time, with the ids they make numbered from zero. */
async function editOutputs(project: Project, example: string, variant: string): Promise<Outputs> {
  const out: Outputs = {}
  const stableRun = <T>(f: () => T) => withStableIds(f)
  const summary = (r: object, ...skip: string[]) => stable(Object.fromEntries(Object.entries(r).filter(([k]) => k !== "project" && k !== "plan" && !skip.includes(k))))
  const result = (r: { project: Project } & object, ...skip: string[]) => `${summary(r, ...skip)}\n----\n${file(r.project)}`

  // Tidy, twice: the second run on what the first made.
  const tidy1 = stableRun(() => tidySchematic(project))
  const tidy2 = stableRun(() => tidySchematic(tidy1.project))
  tick("tidy x2")
  out["edit.tidy-1"] = result(tidy1)
  out["edit.tidy-2"] = result(tidy2)
  out["edit.cleanup"] = (() => {
    const r = stableRun(() => cleanupSheet(project))
    return `${stable({ changed: r.changed, ok: r.ok, message: r.message, tidy: r.tidy && { changed: r.tidy.changed, message: r.tidy.message } })}\n----\n${file(r.project)}`
  })()

  tick("cleanup")
  const parts = project.components.filter((c) => isPhysical(findPart(c.partId)))
  const first = parts[0]
  // Paste a copy of the first part (and the second) where the sheet has room.
  out["edit.paste"] = stableRun(() => {
    const spot = freeSchematicSpot(project, findPart(first.partId))
    const clip = { project, components: parts.slice(0, 2).map((c) => c.id), wires: [], labels: [], blocks: [] }
    const r = pasteItems(project, clip, { x: spot.x - first.sch.x, y: spot.y - first.sch.y })
    return r.ok ? `ok ${r.selection.length} inline=${!!r.inline}\n----\n${file(r.project)}` : `refused: ${r.message}`
  })
  out["edit.delete"] = stableRun(() => file(removeItems(project, { components: [first.id] })))
  out["edit.rotate"] = stableRun(() => {
    const r = rotateSelection(project, { components: [first.id], labels: [] })
    return r.ok ? `ok ${r.note ?? ""}\n----\n${file(r.project)}` : `refused: ${r.message}`
  })

  tick("paste+delete+rotate")
  // Autoroute from scratch: every trace and via off, no time limit (the limit makes it depend on the clock).
  // The slow one (esp32-robot, 75 s a run on this machine) is run on the board as shipped only.
  if (!SLOW.has(`${example}/edit.autoroute`) || (FULL && variant === "shipped")) {
    out["edit.autoroute"] = stableRun(() => {
      const bare: Project = { ...project, traces: [], vias: [] }
      const r = routeAroundStitching(bare, (p) => autoroute(p, { timeLimitMs: Infinity }))
      return result(r)
    })
  }
  tick("autoroute")
  return out
}

// ---------- the golden files ----------

interface Golden {
  note: string
  masks: string[]
  /** Bytes of what Sakura is sent every request. */
  sizes: { systemPrompt: number; toolDefinitions: number; toolCount: number }
  hashes: Record<string, string>
}

const readJson = <T>(path: string, empty: T): T => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : empty)
const golden = readJson<Golden>(GOLDEN, { note: "", masks: [], sizes: { systemPrompt: 0, toolDefinitions: 0, toolCount: 0 }, hashes: {} })
const goldenTexts = readJson<Record<string, string>>(TEXTS, {})
const computed = new Map<string, { hash: string; text: string }>()
const computedPrefixes = new Set<string>()
let computedSizes: Golden["sizes"] | null = null

/** The first `limit` lines that differ, as "line n: was ... / now ...". */
function shortDiff(was: string, now: string, limit = 30): string {
  const a = was.split("\n")
  const b = now.split("\n")
  const lines: string[] = []
  for (let i = 0; i < Math.max(a.length, b.length) && lines.length < limit; i++) {
    if (a[i] === b[i]) continue
    const cut = (s: string | undefined) => (s === undefined ? "(no line)" : s.length > 160 ? `${s.slice(0, 160)}...` : s)
    lines.push(`    line ${i + 1}: was ${cut(a[i])}`, `    ${" ".repeat(String(i + 1).length + 6)}now ${cut(b[i])}`)
  }
  return lines.join("\n")
}

/**
 * Compute an output set and keep its hashes for the comparison. Writing the golden file (and a
 * GOLDEN_FULL run) computes it twice and requires the same; a plain run does that only when
 * something differs from the golden file, so a failure says whether it is a change or noise.
 */
async function record(prefix: string, make: () => Promise<Outputs>) {
  if (process.env.GOLDEN_TIMING) appendFileSync(process.env.GOLDEN_TIMING, `${prefix}
`)
  const one = await make()
  const differs = Object.entries(one).some(([name, text]) => golden.hashes[`${prefix}/${name}`] !== sha(text))
  if (UPDATE || FULL || differs) {
    const two = await make()
    const unstable = [...new Set([...Object.keys(one), ...Object.keys(two)])].filter((k) => one[k] !== two[k])
    expect(unstable, `${prefix}: these outputs differ between two runs, so they cannot be golden`).toEqual([])
  }
  computedPrefixes.add(prefix)
  for (const [name, text] of Object.entries(one)) computed.set(`${prefix}/${name}`, { hash: sha(text), text })
}

function compare(prefix: string) {
  if (UPDATE) return
  const changed: string[] = []
  for (const [key, now] of computed) {
    if (!key.startsWith(`${prefix}/`)) continue
    const was = golden.hashes[key]
    if (was === now.hash) continue
    const [where, ...rest] = key.slice(prefix.length + 1).split("/")
    const label = `${prefix.split("/").join(" / ")} / ${[where, ...rest].join("/")}`
    if (was === undefined) {
      changed.push(`  ${label}: no golden hash (run with UPDATE_GOLDEN=1 if this output is new)`)
      continue
    }
    const text = goldenTexts[key]
    changed.push(`  ${label}: changed (${now.text.length} chars now)${text === undefined ? "; too large to keep a copy, so only the hash is known" : `\n${shortDiff(text, now.text)}`}`)
  }
  const missing = Object.keys(golden.hashes).filter((k) => k.startsWith(`${prefix}/`) && !computed.has(k) && (FULL || !SLOW.has(`${prefix.split("/")[0]}/${k.slice(prefix.length + 1)}`)))
  for (const k of missing) changed.push(`  ${k}: in the golden file but no longer produced`)
  expect(changed, `\n${changed.length} output(s) of ${prefix} changed. If the change is intended, run UPDATE_GOLDEN=1 GOLDEN_FULL=1 and review the diff of the golden files.\n${changed.join("\n")}\n`).toEqual([])
}

// ---------- Sakura's request ----------

const account: MeResponse = {
  user: { id: "user_1", email: "a@b.c", name: "A" },
  plan: { tier: "pro", name: "Pro", managedAi: true, allowedModels: ["vendor/small", "vendor/large"] },
  limits: { maxTokensPerRequest: 64000, requestsPerMinute: 60, requestsPerDay: 600, monthlyTokens: 4_000_000 },
  usage: { requestsThisMinute: 0, minuteResetsAt: null, requestsThisDay: 0, dayResetsAt: null, monthlyTokens: 0, monthResetsAt: null },
  onDemand: { available: true, enabled: false, capCents: 0, creditsThisPeriod: 0, spentCents: 0 },
}

/** The first request the copilot sends, captured as it goes out: the system message and the tools. */
async function sakuraRequest(): Promise<{ body: Record<string, unknown>; outputs: Outputs }> {
  let body: Record<string, unknown> | undefined
  connectManagedAi({ getAccessToken: async () => "token", getDistinctId: () => "distinct" })
  useAccount.setState({ status: "idle", account: null, error: null })
  useUi.setState({ settings: { ...DEFAULT_SETTINGS } })
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    if (String(url).endsWith("/api/v1/me")) return Response.json(account)
    body = JSON.parse(String(init.body)) as Record<string, unknown>
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })
  })
  try {
    const project = createProject("golden")
    useProjectStore.getState().open(project)
    clearHistory(project.id)
    await runCopilot("hello", { onEvent: () => {} })
  } finally {
    vi.unstubAllGlobals()
    connectManagedAi(null)
  }
  if (!body) throw new Error("the copilot sent no request")
  const { messages, tools, session_id: _session, ...rest } = body as { messages: { role: string }[]; tools: unknown; session_id?: unknown } & Record<string, unknown>
  return {
    body,
    outputs: {
      "sakura.system-prompt": JSON.stringify(messages[0], null, 1),
      "sakura.tool-definitions": JSON.stringify(tools, null, 1),
      "sakura.request-settings": stable({ ...rest, firstMessageRole: messages[1]?.role, messageCount: messages.length }),
    },
  }
}

// ---------- the tests ----------

beforeAll(() => setLookRenderer(fakeRenderer))
afterEach(() => vi.unstubAllGlobals())
afterAll(() => {
  setLookRenderer(undefined)
  if (!UPDATE) return
  // Keep what this run did not compute (a filtered run, or the slow outputs without GOLDEN_FULL).
  const hashes: Record<string, string> = {}
  const texts: Record<string, string> = {}
  for (const [key, h] of Object.entries(golden.hashes)) {
    const slow = SLOW.has(`${key.split("/")[0]}/${key.split("/").slice(2).join("/")}`)
    const owner = [...computedPrefixes].some((p) => key.startsWith(`${p}/`))
    if (!owner || (slow && !computed.has(key))) {
      hashes[key] = h
      if (goldenTexts[key] !== undefined) texts[key] = goldenTexts[key]
    }
  }
  for (const [key, { hash, text }] of computed) {
    hashes[key] = hash
    if (text.length <= KEEP_TEXT_UP_TO) texts[key] = text
  }
  const sorted = <T>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)))
  const next: Golden = {
    note: "Written by tests/golden/editor-examples.test.ts with UPDATE_GOLDEN=1 GOLDEN_FULL=1. One sha256 per output: key is example/variant/output.",
    masks: MASKS,
    sizes: computedSizes ?? golden.sizes,
    hashes: sorted(hashes),
  }
  writeFileSync(GOLDEN, `${JSON.stringify(next, null, 2)}\n`)
  writeFileSync(TEXTS, `${JSON.stringify(sorted(texts), null, 1)}\n`)
})

describe("golden outputs: what Sakura is sent", () => {
  it("is the same system prompt, tool definitions and request settings", async () => {
    const run = async () => (await sakuraRequest()).outputs
    const one = await run()
    expect(await run(), "the request is the same twice").toEqual(one)
    const sizes = {
      systemPrompt: Buffer.byteLength(one["sakura.system-prompt"]),
      toolDefinitions: Buffer.byteLength(JSON.stringify(TOOL_DEFINITIONS)),
      toolCount: TOOL_DEFINITIONS.length,
    }
    // The tools in the request are the tools the editor defines.
    expect(JSON.parse(one["sakura.tool-definitions"])).toEqual(JSON.parse(JSON.stringify(TOOL_DEFINITIONS)))
    computedPrefixes.add("global")
    for (const [name, text] of Object.entries(one)) computed.set(`global/${name}`, { hash: sha(text), text })
    computedSizes = sizes
    if (!UPDATE) {
      expect(sizes, "Sakura's prompt and tool definitions are a different size (bytes)").toEqual(golden.sizes)
      compare("global")
    }
  })
})

describe.each(EXAMPLES.map((e) => [e.id, e.project] as const))("golden outputs: %s", (id, shipped) => {
  registerProjectParts(shipped)
  for (const [variant, project] of variantsOf(shipped)) {
    it(
      variant,
      async () => {
        const prefix = `${id}/${variant}`
        await record(prefix, async () => ({ ...(await designOutputs(project)), ...(await editOutputs(project, id, variant)) }))
        compare(prefix)
      },
      600_000,
    )
  }
})
