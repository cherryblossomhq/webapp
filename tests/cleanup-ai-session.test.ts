import type { MeResponse } from "@cherryblossom/api-contract"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// A whole-sheet Tidy that refuses, injected, so these hold whether or not Tidy can lay this sheet out.
const tidyRefuses = vi.hoisted(() => ({ on: false }))
vi.mock("../src/model/tidy", async (original) => {
  const real = await original<typeof import("../src/model/tidy")>()
  return {
    ...real,
    tidySchematic: (project: import("../src/model/types").Project, options: { blockId?: string } = {}) =>
      tidyRefuses.on && !options.blockId
        ? { project, changed: false, ok: false, message: "Tidy couldn't find room for everything; nothing was changed.", renamed: {}, dropped: [], loose: { wires: 0, labels: 0, ports: 0 }, problems: [] }
        : real.tidySchematic(project, options),
  }
})
import { clearHistory } from "../src/ai/copilot"
import { connectManagedAi } from "../src/ai/managedAi"
import type { Project } from "../src/model/types"
import { useAccount } from "../src/store/accountStore"
import { useCopilot, type Entry } from "../src/store/copilotStore"
import { useCleanup } from "../src/editor/schematic/cleanupAction"
import { cleanupSummary } from "../src/model/cleanup"
import { useProjectStore } from "../src/store/projectStore"
import { DEFAULT_SETTINGS } from "../src/store/settings"
import { useUi } from "../src/store/uiStore"
import { BLOCKS, firstRequest } from "./sakura-session"

// Problem 4 of the owner's Sakura session: Clean up with AI, against a scripted model that says
// what Sakura said (no request leaves the test).
//
// Needs sakura-session.ts and sakura-session-parts.json beside it.
//
// 1. On the sheet Sakura built, every part is in a block Sakura made, so propose_blocks can only be
//    refused ("The plan puts no loose part in a block", ai/cleanupAi.ts:144) and the button does
//    nothing at all: no plan, no tidy.
// 2. The apply is all or nothing (ai/copilot.ts:315-325, cleanupAi.ts:224): the tidy failed, so the
//    groups were dropped too, but the tool results that said "Block SENSOR holds U2, C4, R5, R6" stay
//    in the conversation and nothing tells the model they were undone. Sakura told the user "I
//    grouped all 19 parts", and in the next request looked for blocks that were never kept ("No
//    block SENSOR. Blocks: OTHER" once the owner had tidied the sheet into OTHER).

const pro: MeResponse = {
  user: { id: "user_1", email: "a@b.c", name: "A" },
  plan: { tier: "pro", name: "Pro", managedAi: true, allowedModels: ["vendor/large"] },
  limits: { maxTokensPerRequest: 64000, requestsPerMinute: 60, requestsPerDay: 600, monthlyTokens: 4_000_000 },
  usage: { requestsThisMinute: 0, minuteResetsAt: null, requestsThisDay: 0, dayResetsAt: null, monthlyTokens: 0, monthResetsAt: null },
  onDemand: { available: true, enabled: false, capCents: 0, creditsThisPeriod: 0, spentCents: 0 },
}

const sse = (...chunks: object[]) =>
  new Response([...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"].join(""), { status: 200, headers: { "content-type": "text/event-stream" } })
const callsTurn = (...calls: { name: string; input: unknown }[]) =>
  sse(
    ...calls.map((c, i) => ({ choices: [{ delta: { tool_calls: [{ index: i, id: `call_${c.name}_${i}`, function: { name: c.name, arguments: JSON.stringify(c.input) } }] } }] })),
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  )
const textTurn = (text: string) => sse({ choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] })

interface Request {
  body: { messages: { role: string; content: unknown }[] }
}
let requests: Request[] = []
let script: (() => Response)[] = []

const PLAN = { blocks: BLOCKS("USB INPUT").map(([name, refs]) => ({ name, refs })) }
const thread = (id: string) => useCopilot.getState().threads[id] ?? []
const planEntry = (id: string) => thread(id).find((e): e is Extract<Entry, { kind: "plan" }> => e.kind === "plan")
const settled = () =>
  vi.waitFor(() => {
    expect(useCopilot.getState().runningProject).toBeNull()
    expect(useCopilot.getState().cleanup).toBeNull()
  })

function open(p: Project) {
  useProjectStore.getState().open(p)
  clearHistory(p.id)
  return p.id
}

beforeEach(() => {
  requests = []
  script = []
  tidyRefuses.on = false
  connectManagedAi({ getAccessToken: async () => "token-1" })
  useAccount.setState({ status: "ready", account: pro, error: null })
  useUi.setState({ settings: { ...DEFAULT_SETTINGS } })
  useCopilot.setState({ threads: {}, runningProject: null, controller: null, cleanup: null })
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit = {}) => {
    requests.push({ body: JSON.parse(String(init.body)) as Request["body"] })
    const next = script.shift()
    if (!next) throw new Error("unexpected request")
    return next()
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  connectManagedAi(null)
})

describe("Clean up with AI on the sheet Sakura built", () => {
  it("says there is nothing to group and asks whether to tidy, without asking the model for a plan nobody can use", () => {
    const before = firstRequest().project
    const id = open(before)
    useCopilot.getState().startCleanup(id)
    // No request: the model is not asked, and nothing happens until the user answers.
    expect(requests).toHaveLength(0)
    expect(planEntry(id)).toBeUndefined()
    const said = thread(id).find((e) => e.kind === "assistant") as { text: string }
    expect(said.text).toContain("Every part is already in a block")
    expect(said.text).not.toContain("I am tidying")
    const phase = useCleanup.getState().phase
    expect(phase.kind).toBe("preview")
    expect(phase.kind === "preview" && cleanupSummary(phase.plan)).toBe("Every part is already in a block. Tidy the sheet?")
    expect(useProjectStore.getState().project).toBe(before)
  })
})

describe("Clean up with AI when the tidy fails", () => {
  /** The sheet cleanup 2 read: 24 components (19 parts and the 5 ports a 3.3V POWER tidy drew), no blocks. */
  function looseSheet() {
    const s = firstRequest()
    s.must("tidy_schematic", { blocks: ["3.3V POWER"] })
    for (const b of [...(s.project.blocks ?? [])]) s.must("edit_block", { block: b.name, ungroup: true })
    expect(s.project.blocks).toBeUndefined()
    return s.project
  }

  async function planAndApply(id: string) {
    script = [() => callsTurn({ name: "get_design", input: {} }), () => callsTurn({ name: "propose_blocks", input: PLAN }), () => textTurn("Here is the plan.")]
    useCopilot.getState().startCleanup(id)
    await settled()
    const entry = planEntry(id)!
    script = [
      () => callsTurn(...PLAN.blocks.map((b) => ({ name: "group_parts", input: { block: b.name, refs: b.refs } }))),
      () => callsTurn({ name: "tidy_schematic", input: { whole_sheet: true } }),
      () => textTurn("I grouped all 19 parts into the 5 blocks, but the tidy failed and changed nothing."),
    ]
    useCopilot.getState().applyPlan(id, entry.id)
    await settled()
  }

  it("keeps nothing, and the panel says so (passes today)", async () => {
    const before = looseSheet()
    const id = open(before)
    tidyRefuses.on = true
    await planAndApply(id)
    expect(useProjectStore.getState().project).toBe(before)
    const errors = thread(id).filter((e) => e.kind === "error").map((e) => (e as { text: string }).text)
    expect(errors).toContain("Sakura did not tidy the sheet, so nothing was changed.")
    const tidy = thread(id).filter((e) => e.kind === "tool").at(-1) as { label: string }
    expect(tidy.label).toContain("find room")
  })

  it("tells the model the groups were not kept, so the next request doesn't look for them (today it doesn't)", async () => {
    const id = open(looseSheet())
    tidyRefuses.on = true
    await planAndApply(id)
    script = [() => textTurn("ok")]
    useCopilot.getState().send(id, "fix everything you can do pls rn")
    await settled()
    const history = requests.at(-1)!.body.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")))
    // What the model was told the apply did: every group_parts result says the block holds its parts.
    expect(history.some((t) => t.startsWith("Block SENSOR holds"))).toBe(true)
    // And nothing after it says none of that was kept.
    expect(history.some((t) => /did not tidy the sheet, so nothing was changed|were not kept|was undone|rolled back/i.test(t))).toBe(true)
  })
})
