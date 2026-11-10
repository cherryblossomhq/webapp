import type { MeResponse } from "@cherryblossom/api-contract"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearHistory, runCopilot, type CopilotEvent } from "../src/ai/copilot"
import { connectManagedAi } from "../src/ai/managedAi"
import { connectSupplierParts, type SupplierPartsSource } from "../src/ai/supplierParts"
import { findPart } from "../src/model/library"
import { addComponent, createProject } from "../src/model/ops"
import { partFindings } from "../src/model/partChecks"
import { useAccount } from "../src/store/accountStore"
import { useProjectStore } from "../src/store/projectStore"
import { DEFAULT_SETTINGS } from "../src/store/settings"
import { useUi } from "../src/store/uiStore"
import { recordedSource } from "./fixtures/supplier/source"

// The copilot's tool loop end to end, with the model scripted (no model is called) and the
// supplier answering from recorded data: Sakura looks a part up, reads it, builds it and places
// it, and the board ends up with a part whose pins and land are the supplier's.

const account: MeResponse = {
  user: { id: "user_1", email: "a@b.c", name: "A" },
  plan: { tier: "pro", name: "Pro", managedAi: true, allowedModels: ["vendor/large"] },
  limits: { maxTokensPerRequest: 64000, requestsPerMinute: 60, requestsPerDay: 600, monthlyTokens: 4_000_000 },
  usage: { requestsThisMinute: 0, minuteResetsAt: null, requestsThisDay: 0, dayResetsAt: null, monthlyTokens: 0, monthResetsAt: null },
  credits: { available: true, balance: 0, balanceCents: 0, autoRefill: false, refilling: false },
}

const sse = (...chunks: object[]) =>
  new Response([...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"].join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
const toolCall = (id: string, name: string, args: object) =>
  sse(
    { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  )
const toolCalls = (...calls: [string, string, object][]) =>
  sse(
    { choices: [{ delta: { tool_calls: calls.map(([id, name, args], index) => ({ index, id, function: { name, arguments: JSON.stringify(args) } })) } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  )
const say = (text: string) => sse({ choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] })

type Message = { role: string; content: string | null; tool_call_id?: string }
/** One model turn: what it answers, given the conversation the copilot sent. */
type Turn = (messages: Message[]) => Response

let turns: Turn[] = []
let sent: Message[][] = []

const lastToolResult = (messages: Message[]) => String([...messages].reverse().find((m) => m.role === "tool")?.content ?? "")

async function run(prompt: string, signal?: AbortSignal) {
  const events: CopilotEvent[] = []
  await runCopilot(prompt, { signal, onEvent: (e) => events.push(e) })
  return events
}
const toolEnds = (events: CopilotEvent[]) => events.filter((e): e is Extract<CopilotEvent, { type: "tool_end" }> => e.type === "tool_end")

beforeEach(() => {
  turns = []
  sent = []
  connectManagedAi({ getAccessToken: async () => "token-1" })
  useAccount.setState({ status: "idle", account: null, error: null })
  useUi.setState({ settings: { ...DEFAULT_SETTINGS } })
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    if (String(url).endsWith("/api/v1/me")) return Response.json(account)
    const body = JSON.parse(String(init.body)) as { messages: Message[] }
    sent.push(body.messages)
    const next = turns.shift()
    if (!next) throw new Error("the script ran out of turns")
    return next(body.messages)
  })
  const project = createProject("parts")
  useProjectStore.getState().open(project)
  clearHistory(project.id)
})

afterEach(() => {
  vi.unstubAllGlobals()
  connectManagedAi(null)
  connectSupplierParts(null)
})

describe("Sakura building a part from supplier data", () => {
  it("finds, reads, builds and places a verified part", async () => {
    connectSupplierParts(recordedSource())
    turns = [
      () => toolCall("c1", "find_part", { query: "TPS61023" }),
      (m) => {
        // It picks the first candidate the search lists.
        const lcsc = lastToolResult(m).match(/^(C\d+) /)![1]
        return toolCall("c2", "get_part_data", { lcsc })
      },
      (m) => toolCall("c3", "create_part", { lcsc: lastToolResult(m).match(/^(C\d+):/)![1], category: "Power" }),
      (m) => toolCall("c4", "add_component", { part_id: lastToolResult(m).match(/part_id "([^"]+)"/)![1], x: 0, y: 0 }),
      () => say("Added U1, a TPS61023DRLR built from LCSC data."),
    ]
    const events = await run("add a TPS61023 boost converter")

    const ends = toolEnds(events)
    expect(ends.map((e) => [e.name, e.isError])).toEqual([
      ["find_part", false],
      ["get_part_data", false],
      ["create_part", false],
      ["add_component", false],
    ])
    expect(ends[2].summary).toBe("Created part TPS61023DRLR from LCSC C919459")

    // What the model read: candidates with LCSC numbers, the pin map with roles, the supplier's land.
    expect(lastToolResult(sent[1])).toContain("C919459 TPS61023DRLR")
    expect(lastToolResult(sent[2])).toContain("1:FB 2:EN 3:VIN(supply in) 4:GND(ground) 5:SW 6:VOUT(supply out)")
    expect(lastToolResult(sent[2])).toContain("Land (from C919459): 6 pads, 0.5 mm pitch")
    expect(lastToolResult(sent[3])).toContain("from LCSC C919459")

    const project = useProjectStore.getState().project!
    const u1 = project.components.find((c) => c.ref === "U1")!
    const spec = project.parts!.find((s) => s.id === u1.partId)!
    expect(spec.source).toMatchObject({ pins: "supplier", land: "supplier", supplier: { lcsc: "C919459", mpn: "TPS61023DRLR" } })
    expect(findPart(u1.partId)?.pins.map((p) => p.name)).toEqual(["FB", "EN", "VIN", "GND", "SW", "VOUT"])
    expect(u1.footprint).toBe(spec.footprint)
    // The supplier's 3D model comes with its land, placed as the record places it.
    expect(project.models).toEqual([
      {
        part: spec.id,
        footprint: spec.footprint,
        model: expect.objectContaining({
          source: "supplier",
          id: "ec2270bac0544bf5afe06b24e8356512",
          origin: "center",
          offset: { x: 0, y: 0.0299, z: 0 },
          rotation: { x: 0, y: 0, z: 180 },
          attribution: expect.stringContaining("3D models from the JLCEDA/EasyEDA Official Library"),
        }),
      },
    ])
    // Built from data: nothing for the Checks panel to say about it.
    expect(partFindings(project)).toEqual([])
    // Two undoable edits: the part, then the component.
    expect(useProjectStore.getState().past).toHaveLength(2)
  })

  it("refuses a pin map from memory that contradicts the supplier, and the copilot rebuilds from data", async () => {
    connectSupplierParts(recordedSource())
    turns = [
      () =>
        toolCall("c1", "create_part", {
          // Picked from find_part's list (the name alone only has longer part numbers), with the
          // pins and footprint it remembered alongside.
          lcsc: "C919459",
          name: "TPS61023",
          description: "boost",
          category: "Power",
          footprint: "sot23_6",
          pins: "1:SW 2:GND 3:EN 4:FB 5:VOUT 6:VIN".split(" ").map((p) => ({ number: p.split(":")[0], name: p.split(":")[1] })),
        }),
      (m) => toolCall("c2", "create_part", { lcsc: lastToolResult(m).match(/lcsc "(C\d+)"/)![1], category: "Power" }),
      () => say("The pinout I remembered was wrong; I built it from the supplier's data instead."),
    ]
    const events = await run("add a TPS61023")
    const ends = toolEnds(events)
    expect(ends.map((e) => e.isError)).toEqual([true, false])
    const refusal = lastToolResult(sent[1])
    expect(refusal).toContain("pin 6 is VOUT (a supply output), drawn as VIN (a supply input)")
    expect(refusal).toContain("pitch 0.95 mm against the supplier's 0.5 mm")
    expect(useProjectStore.getState().project!.parts).toHaveLength(1)
    expect(useProjectStore.getState().project!.parts![0].source?.pins).toBe("supplier")
  })

  it("falls back to memory with no supplier, marks the part and tells the model to say so", async () => {
    turns = [
      () =>
        toolCall("c1", "create_part", {
          name: "HFCN-650+",
          description: "low pass filter",
          category: "Passives",
          footprint: "1206",
          pins: [
            { number: "1", name: "IN" },
            { number: "2", name: "OUT" },
          ],
        }),
      (m) => toolCall("c2", "add_component", { part_id: lastToolResult(m).match(/part_id "([^"]+)"/)![1] }),
      () => say("Added it. Its pinout is from memory and unverified: check it against the datasheet."),
    ]
    await run("add an HFCN-650+")
    expect(lastToolResult(sent[1])).toContain("UNVERIFIED (supplier lookup isn't available in this editor)")
    const project = useProjectStore.getState().project!
    expect(partFindings(project).map((f) => f.message)).toEqual([
      "X1 (HFCN-650+): footprint 1206 not checked against a supplier land; made from memory (supplier lookup isn't available in this editor)",
    ])
  })
})

describe("the tool loop with lookups in flight", () => {
  it("keeps an edit the user makes while a part is being looked up", async () => {
    const slow: SupplierPartsSource = recordedSource({ delayMs: 40 })
    connectSupplierParts(slow)
    let edited = false
    turns = [
      () => {
        // While create_part waits on the supplier, the user adds a resistor by hand.
        setTimeout(() => {
          useProjectStore.getState().commit((p) => addComponent(p, "resistor").project)
          edited = true
        }, 10)
        return toolCall("c1", "create_part", { lcsc: "C919459", category: "Power" })
      },
      () => say("Done."),
    ]
    const events = await run("add the boost converter")
    expect(edited).toBe(true)
    expect(toolEnds(events)[0]).toMatchObject({ name: "create_part", isError: false, changed: true })
    const project = useProjectStore.getState().project!
    // Both: the user's resistor and the copilot's part.
    expect(project.components.map((c) => c.partId)).toEqual(["resistor"])
    expect(project.parts?.map((s) => s.name)).toEqual(["TPS61023DRLR"])
    // Two undo steps, in the order they happened: the copilot's comes off first and leaves the resistor.
    expect(useProjectStore.getState().past).toHaveLength(2)
    useProjectStore.getState().undo()
    expect(useProjectStore.getState().project!.components).toHaveLength(1)
    expect(useProjectStore.getState().project!.parts ?? []).toHaveLength(0)
    useProjectStore.getState().undo()
    expect(useProjectStore.getState().project!.components).toHaveLength(0)
  })

  it("answers every tool call even when a lookup fails", async () => {
    connectSupplierParts({
      search: async () => {
        throw new Error("Part lookup limit reached (60 lookups a minute). Try again in a minute.")
      },
      part: async () => null,
    })
    turns = [() => toolCall("c1", "find_part", { query: "TPS61023" }), () => say("The lookup limit was reached.")]
    const events = await run("find a boost converter")
    expect(toolEnds(events)[0]).toMatchObject({ isError: true, summary: "Part lookup limit reached (60 lookups a minute). Try again in a minute." })
    expect(sent[1].map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"])
  })
})

describe("Stop during a turn with several tool calls", () => {
  it("runs nothing after the lookup it interrupted, and still answers every call", async () => {
    const controller = new AbortController()
    // Stop is pressed while the supplier is being asked; the lookup then finishes normally.
    connectSupplierParts({
      search: async () => {
        controller.abort()
        return recordedSource().search("TPS61023")
      },
      part: async () => null,
    })
    turns = [
      () =>
        toolCalls(
          ["c1", "find_part", { query: "TPS61023" }],
          ["c2", "add_component", { part_id: "resistor", x: 0, y: 0 }],
          ["c3", "add_component", { part_id: "resistor", x: 4, y: 0 }],
        ),
    ]
    const events = await run("add a boost converter and two resistors", controller.signal)

    // Nothing was added, and nothing the lookup made was applied.
    expect(useProjectStore.getState().project!.components).toEqual([])
    expect(useProjectStore.getState().past).toHaveLength(0)
    // Every call got a result, so the conversation stays valid for the next message.
    expect(toolEnds(events).map((e) => [e.name, e.isError, e.changed])).toEqual([
      ["find_part", true, false],
      ["add_component", true, false],
      ["add_component", true, false],
    ])
    expect(toolEnds(events)[1].summary).toBe("Stopped by the user before this ran.")
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "aborted" })
    // No second model round was spent after Stop.
    expect(sent).toHaveLength(1)
  })

  it("stops between calls that need no lookup either", async () => {
    const controller = new AbortController()
    turns = [
      () => toolCalls(["c1", "get_design", {}], ["c2", "add_component", { part_id: "resistor", x: 0, y: 0 }]),
    ]
    const events: CopilotEvent[] = []
    await runCopilot("add a resistor", {
      signal: controller.signal,
      onEvent: (e) => {
        events.push(e)
        // Stop lands while the first call's result is being shown.
        if (e.type === "tool_end" && e.id === "c1") controller.abort()
      },
    })
    expect(useProjectStore.getState().project!.components).toEqual([])
    expect(toolEnds(events).map((e) => [e.id, e.isError])).toEqual([
      ["c1", false],
      ["c2", true],
    ])
  })
})


describe("a model repeating the same failing call", () => {
  it("is refused on the third identical attempt, with the supplier asked only twice", async () => {
    let searches = 0
    connectSupplierParts({
      search: async () => {
        searches++
        throw new Error("The parts supplier answered 503 (search).")
      },
      part: async () => null,
    })
    const same = { query: "TPS61023" }
    turns = [
      () => toolCall("c1", "find_part", same),
      () => toolCall("c2", "find_part", same),
      () => toolCall("c3", "find_part", same),
      () => say("The supplier is down; I could not look it up."),
    ]
    const events = await run("find a boost converter")
    expect(toolEnds(events).map((e) => e.isError)).toEqual([true, true, true])
    expect(searches).toBe(2)
    expect(lastToolResult(sent[3])).toContain("find_part has already failed 2 times with exactly this input, so it was not run again.")
    // A different input is a new call, and runs.
    turns = [() => toolCall("c4", "find_part", { query: "TPS61023DRLR" }), () => say("Still down.")]
    await run("try once more")
    expect(searches).toBe(3)
  })
})
