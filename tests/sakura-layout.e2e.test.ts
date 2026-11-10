import type { MeResponse } from "@cherryblossom/api-contract"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearHistory, runCopilot, type CopilotEvent } from "../src/ai/copilot"
import { connectManagedAi } from "../src/ai/managedAi"
import { computeConnectivity } from "../src/model/connectivity"
import { padGap } from "../src/model/decoupling"
import { pcbPads } from "../src/model/instances"
import { createProject } from "../src/model/ops"
import { analyzePcb } from "../src/model/pcb"
import { useAccount } from "../src/store/accountStore"
import { useProjectStore } from "../src/store/projectStore"
import { DEFAULT_SETTINGS } from "../src/store/settings"
import { useUi } from "../src/store/uiStore"

// A scripted model, no real calls: it builds a small buck converter, lays it out, places the
// power stage by hand, widens the power nets, routes, and ends on run_checks. Each turn of the
// script is a function of the conversation so far, so the part id create_part returns is read
// back from its result the way a real model reads it.

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

interface Call {
  name: string
  args: object
}

/** One assistant turn that makes these tool calls together. */
const callsTurn = (turn: number, ...calls: Call[]) =>
  sse(
    ...calls.map((c, i) => ({
      choices: [{ delta: { tool_calls: [{ index: i, id: `call_${turn}_${i}`, function: { name: c.name, arguments: JSON.stringify(c.args) } }] } }],
    })),
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  )

const textTurn = (text: string) => sse({ choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] })

type Message = { role: string; content?: unknown }
let requests: { messages: Message[] }[] = []
let script: ((messages: Message[]) => Response)[] = []

const toolResults = () => (requests.at(-1)?.messages ?? []).filter((m) => m.role === "tool").map((m) => String(m.content))

beforeEach(() => {
  requests = []
  useAccount.setState({ status: "idle", account: null, error: null })
  useUi.setState({ settings: { ...DEFAULT_SETTINGS } })
  connectManagedAi({ getAccessToken: async () => "token-1", getDistinctId: () => "distinct-1" })
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    if (String(url).endsWith("/api/v1/me")) return Response.json(account)
    const body = JSON.parse(String(init.body)) as { messages: Message[] }
    requests.push(body)
    const next = script.shift()
    if (!next) throw new Error("unexpected request")
    return next(body.messages)
  })
  const project = createProject("buck")
  useProjectStore.getState().open(project)
  clearHistory(project.id)
})

afterEach(() => {
  vi.unstubAllGlobals()
  connectManagedAi(null)
})

describe("Sakura lays out a buck converter by hand", () => {
  it("builds it, places the stage, widens the power nets, routes, and passes the checks", async () => {
    const partId = (messages: Message[]) => String(messages.filter((m) => m.role === "tool").at(-1)?.content).match(/part_id "([^"]+)"/)![1]
    const add = (part_id: string, props: object = {}, footprint?: string): Call => ({ name: "add_component", args: { part_id, props, ...(footprint && { footprint }) } })
    const net = (net_name: string, pins: string[]): Call => ({ name: "connect", args: { net_name, pins } })

    script = [
      () =>
        callsTurn(1, {
          name: "create_part",
          args: {
            name: "TPS563200",
            description: "3 A synchronous buck, SOT-23-6",
            category: "Power",
            footprint: "sot23_6",
            pins: [
              { number: "1", name: "GND", kind: "ground" },
              { number: "2", name: "SW", kind: "output" },
              { number: "3", name: "VIN", kind: "power" },
              { number: "4", name: "VFB", kind: "input" },
              { number: "5", name: "EN", kind: "input" },
              { number: "6", name: "VBST", kind: "passive" },
            ],
          },
        }),
      (m) =>
        callsTurn(
          2,
          add(partId(m)),
          add("capacitor", { capacitance: "10uF" }, "0805"),
          add("capacitor", { capacitance: "100nF" }, "0402"),
          add("inductor", { inductance: "2.2uH" }, "1206"),
          add("capacitor", { capacitance: "100nF" }, "0402"),
          add("capacitor", { capacitance: "22uF" }, "0805"),
          add("resistor", { resistance: "100k" }, "0603"),
          add("resistor", { resistance: "22k" }, "0603"),
        ),
      () =>
        callsTurn(
          3,
          net("VIN", ["U1.VIN", "U1.EN", "C1.1", "C2.1"]),
          net("GND", ["U1.GND", "C1.2", "C2.2", "C4.2", "R2.2"]),
          net("SW", ["U1.SW", "L1.1", "C3.2"]),
          net("BST", ["U1.VBST", "C3.1"]),
          net("VOUT", ["L1.2", "C4.1", "R1.1"]),
          net("FB", ["U1.VFB", "R1.2", "R2.1"]),
        ),
      () => callsTurn(4, { name: "layout_pcb", args: {} }),
      () => callsTurn(5, { name: "get_design", args: {} }),
      () =>
        callsTurn(6, {
          name: "place_parts",
          args: {
            placements: [
              { ref: "C2", near: "U1.VIN", max_gap_mm: 1.5 },
              { ref: "C1", near: "U1.VIN", max_gap_mm: 1.5 },
              { ref: "L1", near: "U1.SW", max_gap_mm: 1.6 },
              { ref: "C3", near: "U1.VBST", max_gap_mm: 1.5 },
              { ref: "R1", near: "U1.VFB", direction: "below", max_gap_mm: 2, lock: true },
            ],
          },
        }),
      () => callsTurn(7, { name: "set_net_width", args: { widths: { VIN: 0.5, SW: 0.5, VOUT: 0.5 } } }),
      () => callsTurn(8, { name: "route_pcb", args: {} }),
      () => callsTurn(9, { name: "run_checks", args: {} }),
      () => textTurn("The stage is placed, the power nets are wide, and the checks pass."),
    ]

    const events: CopilotEvent[] = []
    await runCopilot("Lay out the buck converter by hand", { onEvent: (e) => events.push(e) })

    expect(events.filter((e) => e.type === "error")).toEqual([])
    const ends = events.filter((e): e is Extract<CopilotEvent, { type: "tool_end" }> => e.type === "tool_end")
    expect(ends.filter((e) => e.isError)).toEqual([])
    expect(ends.map((e) => e.name)).toContain("place_parts")

    // get_design carried the PCB positions the model reasons with.
    expect(JSON.stringify(requests[5].messages)).toContain('\\"pcb\\":{')

    const state = useProjectStore.getState()
    const p = state.project!
    const comp = (ref: string) => p.components.find((c) => c.ref === ref)!
    const gap = (a: [string, string], b: [string, string]) =>
      padGap(pcbPads(comp(a[0])).find((x) => x.pin === a[1])!, pcbPads(comp(b[0])).find((x) => x.pin === b[1])!)
    expect(gap(["C2", "1"], ["U1", "3"])).toBeLessThanOrEqual(1.5)
    expect(gap(["L1", "1"], ["U1", "2"])).toBeLessThanOrEqual(1.6)
    expect(gap(["C3", "1"], ["U1", "6"])).toBeLessThanOrEqual(1.5)
    expect(comp("R1").pcb.locked).toBe(true)
    expect(p.rules.netWidths).toEqual({ VIN: 0.5, SW: 0.5, VOUT: 0.5 })
    const analysis = analyzePcb(p, computeConnectivity(p))
    expect(analysis.violations.filter((v) => v.kind === "unrouted")).toEqual([])
    expect(p.traces.length).toBeGreaterThan(0)

    const placeResult = toolResults().find((r) => r.startsWith("C2: "))!
    expect(placeResult).toContain("C2: ")
    expect(placeResult).not.toContain("NOT within")
    // The last tool result is run_checks. The only thing it reports is that the buck converter
    // was made from memory, not from a supplier record (no supplier lookup in this test).
    const checks = toolResults().at(-1)!.split("\n").filter((l) => l.startsWith("- "))
    expect(checks).toHaveLength(1)
    expect(checks[0]).toContain("U1 (TPS563200): pinout and footprint not verified")
    // One undo step per tool call that changed the project.
    expect(state.past).toHaveLength(ends.filter((e) => e.changed).length)
    // Undoing place_parts gives back the layout_pcb placement.
    state.undo()
    state.undo()
    state.undo()
    const undone = useProjectStore.getState().project!
    expect(undone.rules.netWidths).toBeUndefined()
  })
})
