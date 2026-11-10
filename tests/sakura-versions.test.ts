import type { MeResponse } from "@cherryblossom/api-contract"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearHistory, runCopilot, type CopilotEvent } from "../src/ai/copilot"
import { connectManagedAi } from "../src/ai/managedAi"
import { addComponent, createProject } from "../src/model/ops"
import { useAccount } from "../src/store/accountStore"
import { connectProjectStorage, settleSaves, useProjectStore } from "../src/store/projectStore"
import { DEFAULT_SETTINGS } from "../src/store/settings"
import { openStoredProject, projectRecord } from "../src/store/storage"
import { useUi } from "../src/store/uiStore"
import { memoryStorage } from "./memoryStorage"

/**
 * Sakura going back: `save_version` names a checkpoint in the history, `restore_version` brings one back as one undo step
 * (keeping what it replaces first), and `undo` takes back its own last changes and never the user's. On October 31 a
 * session spent 110 of 212 replies rebuilding earlier states by hand, because none of these existed.
 */

const account: MeResponse = {
  user: { id: "user_1", email: "a@b.c", name: "A" },
  plan: { tier: "pro", name: "Pro", managedAi: true, allowedModels: ["vendor/large"] },
  limits: { maxTokensPerRequest: 64000, requestsPerMinute: 60, requestsPerDay: 600, monthlyTokens: 4_000_000 },
  usage: { requestsThisMinute: 0, minuteResetsAt: null, requestsThisDay: 0, dayResetsAt: null, monthlyTokens: 0, monthResetsAt: null },
  credits: { available: true, balance: 0, balanceCents: 0, autoRefill: false, refilling: false },
}

const sse = (...chunks: object[]) =>
  new Response([...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"].join(""), { status: 200, headers: { "content-type": "text/event-stream" } })

let callId = 0
/** A model turn that makes these tool calls. */
const turn =
  (...list: [string, object][]) =>
  () =>
    sse(
      ...list.map(([name, args], index) => ({ choices: [{ delta: { tool_calls: [{ index, id: `call_${callId++}`, function: { name, arguments: JSON.stringify(args) } }] } }] })),
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    )
const done = () => sse({ choices: [{ delta: { content: "Done." } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] })

let replies: (() => Response)[] = []
let requests: { messages: { role: string; content: unknown }[] }[] = []

const api = () => useProjectStore.getState()
const refs = () => api().project!.components.map((c) => c.ref)

async function run(prompt: string) {
  const events: CopilotEvent[] = []
  await runCopilot(prompt, { onEvent: (e) => events.push(e) })
  await settleSaves()
  return events
}

/** What the tools answered, in order, as the model read them. */
const toolResults = () => requests.at(-1)!.messages.filter((m) => m.role === "tool").map((m) => String(m.content))

async function setup() {
  const memory = memoryStorage()
  connectProjectStorage(memory.storage)
  const { id } = await memory.storage.create(projectRecord(addComponent(createProject("Blinky"), "resistor").project))
  const stored = (await memory.storage.load(id))!
  api().open(openStoredProject(stored), stored)
  clearHistory(id)
  return { memory, id }
}

beforeEach(() => {
  replies = []
  requests = []
  connectManagedAi({ getAccessToken: async () => "token-1", getDistinctId: () => "distinct-1" })
  useAccount.setState({ status: "idle", account: null, error: null })
  useUi.setState({ settings: { ...DEFAULT_SETTINGS } })
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    if (String(url).endsWith("/api/v1/me")) return Response.json(account)
    requests.push(JSON.parse(String(init.body)))
    const next = replies.shift()
    if (!next) throw new Error("unexpected request")
    return next()
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  connectManagedAi(null)
  api().close()
  connectProjectStorage(null)
})

describe("Sakura's checkpoints", () => {
  it("saves one, undoes its own last change, and restores the checkpoint as one undo step, keeping what it replaced", async () => {
    const { memory, id } = await setup()
    replies = [
      turn(["add_component", { part_id: "led", ref: "D1" }]),
      turn(["save_version", { name: "One LED" }]),
      turn(["add_component", { part_id: "led", ref: "D2" }], ["add_component", { part_id: "led", ref: "D3" }]),
      turn(["undo", {}]),
      turn(["restore_version", { version_id: "v0" }]),
      done,
    ]
    const events = await run("add LEDs, then go back")
    const results = toolResults()

    // The checkpoint is named in the history, holding D1: this tab's edit landed before it was named.
    expect(results[1]).toMatch(/^Saved the project as it is now as "One LED" \(version_id v0\)/)
    const checkpoint = memory.versions.find((v) => v.id === "v0")!
    expect(checkpoint).toMatchObject({ kind: "named", name: "One LED" })
    expect(JSON.parse(checkpoint.content).project.components.map((c: { ref: string }) => c.ref)).toEqual(["R1", "D1"])

    // undo took back D3 alone, and said so; it is a change in the transcript though nothing was committed for it.
    expect(results[4]).toMatch(/^Undid your last change, newest first: Added D3/)
    const undoEnd = events.find((e) => e.type === "tool_end" && e.name === "undo")
    expect(undoEnd).toMatchObject({ isError: false, changed: true })

    // The restore brought the checkpoint back exactly, and kept the state it replaced (R1, D1, D2) first.
    expect(results[5]).toMatch(/^Restored the project to the version of .*kept as version v1: restore_version with that id goes back to it, or undo takes this restore back\./)
    expect(refs()).toEqual(["R1", "D1"])
    const backup = memory.versions.find((v) => v.id === "v1")!
    expect(backup).toMatchObject({ kind: "restore" })
    expect(JSON.parse(backup.content).project.components.map((c: { ref: string }) => c.ref)).toEqual(["R1", "D1", "D2"])
    expect(memory.project(id).components.map((c: { ref: string }) => c.ref)).toEqual(["R1", "D1"])

    // Every change is Sakura's own step, named as its transcript names it; the user's Undo takes back the restore.
    expect(api().past.map((s) => [s.by, s.label])).toEqual([
      ["sakura", "Added D1 (LED, red)"],
      ["sakura", "Added D2 (LED, red)"],
      ["sakura", expect.stringMatching(/^Restored the version of /)],
    ])
    api().undo()
    expect(refs()).toEqual(["R1", "D1", "D2"])
    api().redo()
    expect(refs()).toEqual(["R1", "D1"])
  })

  it("never undoes the user's own edit, and says why", async () => {
    await setup()
    replies = [turn(["add_component", { part_id: "led", ref: "D1" }]), done]
    await run("add an LED")
    // The user adds a part by hand after it.
    api().commit((p) => addComponent(p, "resistor").project)
    expect(refs()).toEqual(["R1", "D1", "R2"])

    replies = [turn(["undo", { steps: 2 }]), done]
    await run("undo that")
    expect(toolResults().at(-1)).toMatch(/^Error: The newest change left on the undo stack is the user's own/)
    expect(refs()).toEqual(["R1", "D1", "R2"])

    // Undone by the user, theirs is gone, and Sakura's own is the newest again: undo takes it, and stops at the bottom of the stack.
    api().undo()
    replies = [turn(["undo", { steps: 3 }]), done]
    await run("now undo yours")
    expect(toolResults().at(-1)).toMatch(/^Undid your last change, newest first: Added D1 \(LED, red\)\. .*Stopped after 1 of 3: None of your changes are left/)
    expect(refs()).toEqual(["R1"])
    expect(api().future).toHaveLength(2)
  })

  it("says there are no versions where storage keeps no history", async () => {
    connectProjectStorage(null)
    api().open(addComponent(createProject("Local"), "resistor").project)
    replies = [turn(["save_version", { name: "x" }], ["restore_version", { version_id: "v0" }]), done]
    await run("save")
    expect(toolResults()).toEqual([expect.stringMatching(/keeps no version history/), expect.stringMatching(/keeps no version history/)])
  })
})
