import type { MeResponse } from "@cherryblossom/api-contract"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CLEANUP_APPLY_PROMPT, CLEANUP_PROMPT, CLEANUP_REQUEST, checkPlan } from "../src/ai/cleanupAi"
import { clearHistory, MAX_ITERATIONS } from "../src/ai/copilot"
import { connectManagedAi } from "../src/ai/managedAi"
import { createBlock } from "../src/model/blocks"
import { applyCleanup, useCleanup } from "../src/editor/schematic/cleanupAction"
import { createProject } from "../src/model/ops"
import { groupLooseParts } from "../src/model/cleanup/group"
import { tidySchematic } from "../src/model/tidy"
import { computeConnectivity, pinKey } from "../src/model/connectivity"
import { EXAMPLES } from "../src/model/examples"
import { isPhysical, schematicPins } from "../src/model/instances"
import { findPart } from "../src/model/library"
import { normalizeProject } from "../src/model/projectFile"
import type { Project } from "../src/model/types"
import { useAccount } from "../src/store/accountStore"
import { useCopilot, type Entry } from "../src/store/copilotStore"
import { useProjectStore } from "../src/store/projectStore"
import { DEFAULT_SETTINGS } from "../src/store/settings"
import { useUi } from "../src/store/uiStore"

// Clean up with AI, run against a scripted model: no request leaves the test. The model's turns are
// written down, and what the editor does with them is what is checked: the plan is only a plan until
// the user applies it, the apply request can only do what the plan says, and all of it is one undo step.

const pro: MeResponse = {
  user: { id: "user_1", email: "a@b.c", name: "A" },
  plan: { tier: "pro", name: "Pro", managedAi: true, allowedModels: ["vendor/large"] },
  limits: { maxTokensPerRequest: 64000, requestsPerMinute: 60, requestsPerDay: 600, monthlyTokens: 4_000_000 },
  usage: { requestsThisMinute: 0, minuteResetsAt: null, requestsThisDay: 0, dayResetsAt: null, monthlyTokens: 0, monthResetsAt: null },
  onDemand: { available: true, enabled: false, capCents: 0, creditsThisPeriod: 0, spentCents: 0 },
}

const sse = (...chunks: object[]) =>
  new Response([...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"].join(""), { status: 200, headers: { "content-type": "text/event-stream" } })

interface Call {
  name: string
  input: unknown
}
/** One scripted model turn that calls tools. */
const callsTurn = (...calls: Call[]) =>
  sse(
    ...calls.map((c, i) => ({ choices: [{ delta: { tool_calls: [{ index: i, id: `call_${c.name}_${i}`, function: { name: c.name, arguments: JSON.stringify(c.input) } }] } }] })),
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  )
const textTurn = (text: string) => sse({ choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] })

interface Request {
  body: { messages: { role: string; content: unknown }[]; tools: { function: { name: string } }[]; model: string }
}
/** Each scripted reply sees the request it answers, and may check it. */
type Reply = (req: Request, signal?: AbortSignal | null) => Response | Promise<Response>

let requests: Request[] = []
let script: Reply[] = []

const example = (id: string): Project => ({ ...normalizeProject(structuredClone(EXAMPLES.find((e) => e.id === id)!.project)), blocks: undefined })
const ref = (p: Project, r: string) => p.components.find((c) => c.ref === r)!

/** What a sensible model would propose for the 7805 board: by function. */
const PLAN = [
  { name: "POWER INPUT", refs: ["J1", "D1", "C1"] },
  { name: "5V REGULATOR", refs: ["U2", "C2", "C3", "R1", "D2"] },
  { name: "MCU", refs: ["U1", "Y1", "C4", "C5", "R2", "SW1", "C6", "C7", "RV1"] },
  { name: "FTDI", refs: ["J2", "C8"] },
  { name: "I2C", refs: ["J3"] },
  { name: "LED BAR", refs: ["U3", "C9", ...Array.from({ length: 8 }, (_, i) => [`R${3 + i}`, `D${3 + i}`]).flat()] },
]
const planInput = { blocks: PLAN }
const applyCalls: Call[] = [
  ...PLAN.map((b): Call => ({ name: "group_parts", input: { block: b.name, refs: b.refs } })),
  { name: "tidy_schematic", input: { whole_sheet: true } },
]

const thread = (id: string) => useCopilot.getState().threads[id] ?? []
const settled = () =>
  vi.waitFor(() => {
    expect(useCopilot.getState().runningProject).toBeNull()
    expect(useCopilot.getState().cleanup).toBeNull()
  })
const planEntry = (id: string) => thread(id).find((e): e is Extract<Entry, { kind: "plan" }> => e.kind === "plan")

/** The netlist as a partition of physical pins, by name where named. */
function netlist(p: Project) {
  const conn = computeConnectivity(p)
  const byId = new Map(conn.nets.map((n) => [n.id, n]))
  const groups = new Map<string, string[]>()
  for (const c of p.components.filter((x) => isPhysical(findPart(x.partId)))) {
    for (const pin of schematicPins(c)) {
      const id = conn.pinNet.get(pinKey(c.id, pin.pin))
      const net = id ? byId.get(id) : undefined
      if (!net || (!net.named && net.pins.length < 2)) continue
      groups.set(net.id, [...(groups.get(net.id) ?? []), `${c.ref}.${pin.pin}`])
    }
  }
  return [...groups.values()].map((pins) => pins.sort().join(" ")).sort()
}

const blocksByName = (p: Project) => {
  const refOf = new Map(p.components.map((c) => [c.id, c.ref]))
  return Object.fromEntries((p.blocks ?? []).map((b) => [b.name, b.components.map((id) => refOf.get(id)!).sort()]))
}

let before: Project
let id: string

beforeEach(() => {
  requests = []
  script = []
  connectManagedAi({ getAccessToken: async () => "token-1" })
  useAccount.setState({ status: "ready", account: pro, error: null })
  useUi.setState({ settings: { ...DEFAULT_SETTINGS } })
  useCopilot.setState({ threads: {}, runningProject: null, controller: null, cleanup: null })
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit = {}) => {
    requests.push({ body: JSON.parse(String(init.body)) as Request["body"] })
    const next = script.shift()
    if (!next) throw new Error("unexpected request")
    return next(requests[requests.length - 1], init.signal)
  })
  before = example("node")
  useProjectStore.getState().open(before)
  id = before.id
  clearHistory(id)
})

afterEach(() => {
  vi.unstubAllGlobals()
  connectManagedAi(null)
})

/** Plan with the scripted model: read the design, propose, say one sentence. */
async function plan(input: unknown = planInput) {
  script = [() => callsTurn({ name: "get_design", input: {} }), () => callsTurn({ name: "propose_blocks", input }), () => textTurn("Here is the plan.")]
  useCopilot.getState().startCleanup(id)
  await settled()
}

describe("Clean up with AI: the plan", () => {
  it("asks Sakura for a plan with a fixed request and only the tools to read and propose", async () => {
    await plan()
    expect(requests).toHaveLength(3)
    const [first, second] = requests
    expect(first.body.messages.map((m) => m.role)).toEqual(["system", "user"])
    expect(first.body.messages[1].content).toBe(CLEANUP_PROMPT)
    expect(first.body.tools.map((t) => t.function.name)).toEqual(["get_design", "propose_blocks"])
    // The model got the design through get_design.
    const read = second.body.messages.find((m) => m.role === "tool")!
    expect(String(read.content)).toContain('"components"')
    expect(String(read.content)).toContain("ATMEGA328P-AU")
  })

  it("shows the plan in the panel and changes nothing on the sheet", async () => {
    await plan()
    const entry = planEntry(id)!
    expect(entry.status).toBe("pending")
    expect(entry.plan.blocks.map((b) => [b.name, b.existing])).toEqual(PLAN.map((b) => [b.name, false]))
    expect(entry.plan.blocks[2].refs).toEqual(PLAN[2].refs)
    expect(entry.plan.left).toEqual([])
    const kinds = thread(id).map((e) => e.kind)
    expect(kinds.slice(0, 1)).toEqual(["user"])
    expect(kinds).toContain("plan")
    expect(thread(id)[0]).toMatchObject({ kind: "user", text: CLEANUP_REQUEST })
    // Nothing was done to the sheet, not a block, not an undo step.
    const state = useProjectStore.getState()
    expect(state.project).toBe(before)
    expect(state.past).toHaveLength(0)
  })

  it("refuses a plan with a part that isn't there, a symbol, a part twice or a part of a block the user made, and says what to fix", async () => {
    const mine = createBlock(before, "KEEP", [ref(before, "J3").id]).project
    useProjectStore.getState().open(mine)
    const bad = {
      blocks: [
        { name: "A", refs: ["U1", "ZZ9"] },
        { name: "B", refs: ["#GND1", "U1", "J3"] },
      ],
    }
    script = [() => callsTurn({ name: "propose_blocks", input: bad }), (req) => {
      const result = String(req.body.messages[req.body.messages.length - 1].content)
      expect(result).toContain("There is no part ZZ9.")
      expect(result).toContain("#GND1 is a power or ground symbol")
      expect(result).toContain("U1 is in both A and B")
      expect(result).toContain("J3 is already in the block KEEP")
      return callsTurn({ name: "propose_blocks", input: { blocks: [{ name: "A", refs: ["U1"] }] } })
    }, () => textTurn("Fixed.")]
    useCopilot.getState().startCleanup(id)
    await settled()
    const entry = planEntry(id)!
    expect(entry.plan.blocks).toEqual([{ name: "A", refs: ["U1"], existing: false }])
    // The rest of the loose parts are not in the plan: they would go to OTHER.
    expect(entry.plan.left).toContain("C1")
    expect(entry.plan.left).not.toContain("J3")
  })

  it("stops after three plans that don't fit, instead of spending every step, and says nothing was changed", async () => {
    const bad = { blocks: [{ name: "A", refs: ["ZZ9"] }] }
    script = Array.from({ length: MAX_ITERATIONS }, () => () => callsTurn({ name: "propose_blocks", input: bad }))
    useCopilot.getState().startCleanup(id)
    await settled()
    expect(requests).toHaveLength(3)
    expect(planEntry(id)).toBeUndefined()
    expect(thread(id).some((e) => e.kind === "error" && e.text.includes("after 3 tries") && e.text.includes("Nothing was changed"))).toBe(true)
    expect(useProjectStore.getState().project).toBe(before)
  })

  it("plans on a sheet Tidy has already tidied: the parts Tidy put in OTHER are loose", async () => {
    const tidied = tidySchematic(before).project
    useProjectStore.getState().open(tidied)
    await plan()
    const entry = planEntry(id)!
    expect(entry.plan.blocks.map((b) => b.name)).toEqual(PLAN.map((b) => b.name))
    expect(entry.plan.blocks.every((b) => !b.existing)).toBe(true)
    expect(entry.plan.left).toEqual([])
  })

  it("refuses a block named like the one Tidy keeps its leftovers in", () => {
    const tidied = tidySchematic(before).project
    const checked = checkPlan(tidied, { blocks: [{ name: "other", refs: ["U1"] }] })
    expect("problems" in checked && checked.problems.join(" ")).toContain("name the block by what it does")
  })

  it("won't group or tidy while the plan is made", async () => {
    script = [
      () => callsTurn({ name: "group_parts", input: { block: "MCU", refs: ["U1"] } }, { name: "tidy_schematic", input: { whole_sheet: true } }),
      (req) => {
        const results = req.body.messages.filter((m) => m.role === "tool").map((m) => String(m.content))
        expect(results).toHaveLength(2)
        for (const r of results) expect(r).toMatch(/^Error: .* isn't available while the plan is made/)
        return textTurn("Sorry.")
      },
    ]
    useCopilot.getState().startCleanup(id)
    await settled()
    expect(useProjectStore.getState().project).toBe(before)
    expect(planEntry(id)).toBeUndefined()
  })

  it("adds loose parts to a block the user made when the plan uses its name, and leaves its parts where they are", async () => {
    const mine = createBlock(before, "mcu", [ref(before, "U1").id, ref(before, "Y1").id]).project
    useProjectStore.getState().open(mine)
    await plan({ blocks: [{ name: "MCU", refs: ["U1", "Y1", "C4", "C5"] }] })
    const entry = planEntry(id)!
    expect(entry.plan.blocks).toEqual([{ name: "mcu", refs: ["C4", "C5"], existing: true }])
  })

  it("checks a plan the same way when it is applied", () => {
    expect("plan" in checkPlan(before, { blocks: [{ name: "X", refs: ["U1", "C4"] }] })).toBe(true)
    expect("problems" in checkPlan(before, { blocks: [{ name: "X", refs: [] }] })).toBe(true)
    expect("problems" in checkPlan(before, { blocks: [{ name: "", refs: ["U1"] }] })).toBe(true)
    expect("problems" in checkPlan(before, { blocks: [{ name: "x".repeat(40), refs: ["U1"] }] })).toBe(true)
  })
})

describe("Clean up with AI: applying the plan", () => {
  it("groups with group_parts, tidies the whole sheet, reports, and is one undo step that keeps every connection", async () => {
    await plan()
    script = [() => callsTurn(...applyCalls), () => textTurn("Grouped 38 parts into 6 blocks and tidied the sheet.")]
    useCopilot.getState().applyPlan(id, planEntry(id)!.id)
    await settled()

    const [req1, req2] = requests.slice(3)
    expect(req1.body.messages[req1.body.messages.length - 1]).toEqual({ role: "user", content: CLEANUP_APPLY_PROMPT })
    expect(req1.body.tools.map((t) => t.function.name)).toEqual(["group_parts", "tidy_schematic"])
    const results = req2.body.messages.filter((m) => m.role === "tool").slice(-applyCalls.length)
    for (const r of results) expect(String(r.content)).not.toMatch(/^Error/)

    const state = useProjectStore.getState()
    const grouped = blocksByName(state.project!)
    expect(Object.keys(grouped)).toEqual(PLAN.map((b) => b.name))
    for (const b of PLAN) expect(grouped[b.name]).toEqual([...b.refs].sort())
    // Tidied: the parts moved to where the blocks are.
    expect(state.project!.components.some((c) => c.sch.x !== ref(before, c.ref).sch.x || c.sch.y !== ref(before, c.ref).sch.y)).toBe(true)
    expect(netlist(state.project!)).toEqual(netlist(before))
    expect(planEntry(id)!.status).toBe("applied")
    expect(thread(id).filter((e) => e.kind === "tool" && e.label.startsWith("Grouped"))).toHaveLength(PLAN.length)
    expect(thread(id)[thread(id).length - 1]).toMatchObject({ kind: "assistant", text: "Grouped 38 parts into 6 blocks and tidied the sheet." })

    // One undo step, though group_parts ran six times and Tidy once.
    expect(state.past).toHaveLength(1)
    state.undo()
    expect(useProjectStore.getState().project).toBe(before)
  })

  it("does only what the confirmed plan says", async () => {
    await plan()
    script = [
      () =>
        callsTurn(
          { name: "group_parts", input: { block: "SOMETHING ELSE", refs: ["U1"] } },
          { name: "group_parts", input: { block: "MCU", refs: ["U1", "R5"] } },
          { name: "tidy_schematic", input: {} },
          { name: "tidy_schematic", input: { blocks: ["MCU"], whole_sheet: true } },
          { name: "remove_component", input: { ref: "U1" } },
        ),
      (req) => {
        const results = req.body.messages.filter((m) => m.role === "tool").slice(-5).map((m) => String(m.content))
        expect(results[0]).toContain("isn't a block of the plan the user confirmed")
        expect(results[1]).toContain("R5 isn't in MCU in the confirmed plan")
        expect(results[2]).toContain("whole_sheet true")
        expect(results[3]).toContain("whole_sheet true")
        expect(results[4]).toContain("isn't part of applying the plan")
        return textTurn("Done.")
      },
    ]
    useCopilot.getState().applyPlan(id, planEntry(id)!.id)
    await settled()
    // Nothing the plan names was grouped, so nothing is kept, and the user is told.
    const state = useProjectStore.getState()
    expect(state.project).toBe(before)
    expect(state.past).toHaveLength(0)
    expect(planEntry(id)!.status).toBe("cancelled")
    expect(thread(id).some((e) => e.kind === "error" && e.text.includes("did not group"))).toBe(true)
  })

  it("is all or nothing: a model that groups only some of the blocks changes nothing and says so", async () => {
    await plan()
    // POWER INPUT and the regulator, then it stops: the sheet must not keep those two.
    script = [
      () => callsTurn(...applyCalls.slice(0, 2)),
      () => textTurn("Done."),
    ]
    useCopilot.getState().applyPlan(id, planEntry(id)!.id)
    await settled()
    const state = useProjectStore.getState()
    expect(state.project).toBe(before)
    expect(state.project!.blocks).toBeUndefined()
    expect(state.past).toHaveLength(0)
    expect(planEntry(id)!.status).toBe("cancelled")
    const message = thread(id).find((e) => e.kind === "error")
    expect(message).toMatchObject({ kind: "error" })
    expect(message!.kind === "error" && message!.text).toBe("Sakura did not group MCU, FTDI, I2C, LED BAR as planned, so nothing was changed.")
  })

  it("is all or nothing when the model runs out of steps halfway", async () => {
    await plan()
    // Every round grouping the first block again; the rest are never reached.
    script = Array.from({ length: MAX_ITERATIONS }, () => () => callsTurn(applyCalls[0]))
    useCopilot.getState().applyPlan(id, planEntry(id)!.id)
    await settled()
    const state = useProjectStore.getState()
    expect(state.project).toBe(before)
    expect(state.past).toHaveLength(0)
    const errors = thread(id).filter((e) => e.kind === "error").map((e) => (e.kind === "error" ? e.text : ""))
    expect(errors[0]).toContain(`Stopped after ${MAX_ITERATIONS} steps`)
    expect(errors[errors.length - 1]).toContain("so nothing was changed")
    expect(planEntry(id)!.status).toBe("cancelled")
  })

  it("is nothing when every block is grouped but the sheet is never tidied", async () => {
    await plan()
    script = [() => callsTurn(...applyCalls.slice(0, -1)), () => textTurn("Done.")]
    useCopilot.getState().applyPlan(id, planEntry(id)!.id)
    await settled()
    expect(useProjectStore.getState().project).toBe(before)
    expect(useProjectStore.getState().past).toHaveLength(0)
    expect(thread(id).some((e) => e.kind === "error" && e.text === "Sakura did not tidy the sheet, so nothing was changed.")).toBe(true)
  })

  it("keeps a request that finishes exactly on the last step, and shows it as applied", async () => {
    await plan()
    // Every round but the last regrouping the first block, then everything on the last: no round left for the report.
    script = [...Array.from({ length: MAX_ITERATIONS - 1 }, () => () => callsTurn(applyCalls[0])), () => callsTurn(...applyCalls)]
    useCopilot.getState().applyPlan(id, planEntry(id)!.id)
    await settled()
    const state = useProjectStore.getState()
    const grouped = blocksByName(state.project!)
    for (const b of PLAN) expect(grouped[b.name]).toEqual([...b.refs].sort())
    expect(state.past).toHaveLength(1)
    expect(planEntry(id)!.status).toBe("applied")
    expect(thread(id).some((e) => e.kind === "error")).toBe(false)
  })

  it("is nothing when the sheet was tidied before the last block was grouped", async () => {
    await plan()
    const [tidy] = applyCalls.slice(-1)
    script = [() => callsTurn(...applyCalls.slice(0, -2), tidy, applyCalls[applyCalls.length - 2]), () => textTurn("Done.")]
    useCopilot.getState().applyPlan(id, planEntry(id)!.id)
    await settled()
    expect(useProjectStore.getState().project).toBe(before)
    expect(useProjectStore.getState().past).toHaveLength(0)
    expect(thread(id).some((e) => e.kind === "error" && e.text === "Sakura did not tidy the sheet, so nothing was changed.")).toBe(true)
  })

  it("makes a block under the plan's own name when the model writes it in another case", async () => {
    await plan()
    const lower = applyCalls.map((c) => (c.name === "group_parts" ? { ...c, input: { ...(c.input as object), block: (c.input as { block: string }).block.toLowerCase() } } : c))
    script = [() => callsTurn(...lower), () => textTurn("Done.")]
    useCopilot.getState().applyPlan(id, planEntry(id)!.id)
    await settled()
    expect(Object.keys(blocksByName(useProjectStore.getState().project!))).toEqual(PLAN.map((b) => b.name))
  })

  it("with every part already in a block it asks the model nothing, says so, asks to tidy, and then tidies in one undo step", async () => {
    const grouped = groupLooseParts(before).project
    useProjectStore.getState().open(grouped)
    useCopilot.getState().startCleanup(id)
    expect(requests).toHaveLength(0)
    // Nothing happens until the question is answered.
    expect(useCleanup.getState().phase.kind).toBe("preview")
    expect(useProjectStore.getState().project).toBe(grouped)
    applyCleanup()
    await vi.waitFor(() => expect(useProjectStore.getState().past).toHaveLength(1))
    expect(planEntry(id)).toBeUndefined()
    expect(thread(id).some((e) => e.kind === "assistant" && e.text.includes("Every part is already in a block"))).toBe(true)
    expect(netlist(useProjectStore.getState().project!)).toEqual(netlist(before))
    useProjectStore.getState().undo()
    expect(useProjectStore.getState().project).toBe(grouped)
  })

  it("says there is nothing to clean up on an empty sheet, and does not claim to tidy", () => {
    const empty = createProject("empty")
    useProjectStore.getState().open(empty)
    useCopilot.getState().startCleanup(empty.id)
    expect(requests).toHaveLength(0)
    expect(useCleanup.getState().phase.kind).toBe("idle")
    const said = thread(empty.id).find((e) => e.kind === "assistant") as { text: string }
    expect(said.text).toContain("no parts")
    expect(said.text).not.toMatch(/tidying/)
  })

  it("tells the model and the chat when the apply is rolled back, so neither goes on as if the blocks were made", async () => {
    await plan()
    // Everything grouped, then the model reports success, but the tidy is never called: the rollback follows.
    script = [() => callsTurn(...applyCalls.slice(0, -1)), () => textTurn("I grouped all the parts."), () => textTurn("ok")]
    useCopilot.getState().applyPlan(id, planEntry(id)!.id)
    await settled()
    expect(useProjectStore.getState().project).toBe(before)
    // The chat: no "I grouped" after the rollback, the steps marked as not kept, the panel's line there.
    expect(thread(id).some((e) => e.kind === "assistant" && e.text.includes("I grouped"))).toBe(false)
    expect(thread(id).filter((e) => e.kind === "tool" && e.label.startsWith("Not kept: ")).length).toBe(PLAN.length)
    expect(thread(id).some((e) => e.kind === "error" && e.text === "Sakura did not tidy the sheet, so nothing was changed.")).toBe(true)
    // The model: told, in its history, that nothing was kept.
    useCopilot.getState().send(id, "carry on")
    await settled()
    const last = requests[requests.length - 1].body.messages.map((m) => (typeof m.content === "string" ? m.content : ""))
    expect(last.some((t) => t.startsWith("Editor note") && t.includes("nothing from your last request was kept"))).toBe(true)
  })

  it("applies a plan to a sheet Tidy already tidied: the OTHER block's parts are grouped, one undo step", async () => {
    const tidied = tidySchematic(before).project
    useProjectStore.getState().open(tidied)
    await plan()
    script = [() => callsTurn(...applyCalls), () => textTurn("Grouped.")]
    useCopilot.getState().applyPlan(id, planEntry(id)!.id)
    await settled()
    const state = useProjectStore.getState()
    expect(planEntry(id)!.status).toBe("applied")
    const grouped = blocksByName(state.project!)
    for (const b of PLAN) expect(grouped[b.name]).toEqual([...b.refs].sort())
    expect(grouped.OTHER).toBeUndefined()
    expect(state.past).toHaveLength(1)
    state.undo()
    expect(useProjectStore.getState().project).toBe(tidied)
  })

  it("is not applied when the plan is out of date: the sheet changed after it was proposed", async () => {
    await plan()
    // The user puts J3 in a block of their own before pressing Apply.
    useProjectStore.getState().commit((p) => createBlock(p, "MINE", [ref(p, "J3").id]).project)
    const requestsBefore = requests.length
    useCopilot.getState().applyPlan(id, planEntry(id)!.id)
    expect(requests).toHaveLength(requestsBefore)
    expect(planEntry(id)!.status).toBe("stale")
    expect(thread(id).some((e) => e.kind === "error" && e.text.includes("The sheet changed since this plan"))).toBe(true)
    expect(useProjectStore.getState().past).toHaveLength(1)
  })

  it("turns the plan down on Cancel, and a plan is stale once something else is said", async () => {
    await plan()
    const entry = planEntry(id)!
    useCopilot.getState().cancelPlan(id, entry.id)
    expect(planEntry(id)!.status).toBe("cancelled")
    // Applying a cancelled plan does nothing.
    useCopilot.getState().applyPlan(id, entry.id)
    expect(requests).toHaveLength(3)

    await plan()
    script = [() => textTurn("Hi.")]
    useCopilot.getState().send(id, "hello")
    await settled()
    expect(thread(id).filter((e) => e.kind === "plan").map((e) => (e.kind === "plan" ? e.status : ""))).toEqual(["cancelled", "stale"])
  })

  it("commits nothing when it is stopped halfway", async () => {
    await plan()
    script = [
      () => callsTurn(...applyCalls),
      // The model's next turn never comes: the user presses Stop.
      (_req, signal) => new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))),
    ]
    useCopilot.getState().applyPlan(id, planEntry(id)!.id)
    await vi.waitFor(() => expect(requests).toHaveLength(5))
    useCopilot.getState().stop()
    await settled()
    const state = useProjectStore.getState()
    expect(state.project).toBe(before)
    expect(state.past).toHaveLength(0)
    expect(planEntry(id)!.status).toBe("cancelled")
  })

  it("keeps the user's edit and applies nothing when the sheet is edited while Sakura works", async () => {
    await plan()
    script = [
      () => {
        // The user edits the sheet while the model is still answering.
        useProjectStore.getState().commit((p) => ({ ...p, name: "edited meanwhile" }))
        return callsTurn(...applyCalls)
      },
      () => textTurn("Done."),
    ]
    useCopilot.getState().applyPlan(id, planEntry(id)!.id)
    await settled()
    const state = useProjectStore.getState()
    expect(state.project!.name).toBe("edited meanwhile")
    expect(state.project!.blocks).toBeUndefined()
    expect(state.past).toHaveLength(1)
  })
})
