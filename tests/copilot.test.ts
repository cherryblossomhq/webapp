import type { MeResponse } from "@cherryblossom/api-contract"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearHistory, runCopilot, type CopilotEvent } from "../src/ai/copilot"
import { coalesceReasoningDetails, connectManagedAi } from "../src/ai/managedAi"
import { createProject } from "../src/model/ops"
import { limitOffer, useAccount } from "../src/store/accountStore"
import { DEFAULT_SETTINGS } from "../src/store/settings"
import { useProjectStore } from "../src/store/projectStore"
import { useUi } from "../src/store/uiStore"

const account = (plan: Partial<MeResponse["plan"]> = {}): MeResponse => ({
  user: { id: "user_1", email: "a@b.c", name: "A" },
  plan: { tier: "pro", name: "Pro", managedAi: true, allowedModels: ["vendor/small", "vendor/large"], ...plan },
  limits: { maxTokensPerRequest: 64000, requestsPerMinute: 60, requestsPerDay: 600, monthlyTokens: 4_000_000 },
  usage: { requestsThisMinute: 0, minuteResetsAt: null, requestsThisDay: 0, dayResetsAt: null, monthlyTokens: 0, monthResetsAt: null },
  onDemand: { available: true, enabled: false, capCents: 0, creditsThisPeriod: 0, spentCents: 0 },
})

/** An OpenAI-style SSE stream of chunks, ending in [DONE]. */
const sse = (...chunks: object[]) =>
  new Response([...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"].join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })

const toolTurn = () =>
  sse(
    { choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", index: 0, text: "Need an " }] } }] },
    { choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", index: 0, text: "LED.", signature: "sig" }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "add_component", arguments: '{"part_id":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"led","x":1,"y":0}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  )

const textTurn = (text = "Added D1.") =>
  sse({ choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }, { choices: [], usage: { total_tokens: 3 } })

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body?: Record<string, unknown>
}

let calls: Call[] = []
let me: () => Response
let replies: (() => Response)[] = []

async function run(prompt: string) {
  const events: CopilotEvent[] = []
  await runCopilot(prompt, { onEvent: (e) => events.push(e) })
  return events
}

const chatCalls = () => calls.filter((c) => c.url.endsWith("/chat/completions"))

beforeEach(() => {
  calls = []
  replies = []
  me = () => Response.json(account())
  connectManagedAi({ getAccessToken: async () => "token-1", getDistinctId: () => "distinct-1" })
  useAccount.setState({ status: "idle", account: null, error: null })
  useUi.setState({ settings: { ...DEFAULT_SETTINGS } })
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const call: Call = {
      url: String(url),
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    }
    calls.push(call)
    if (call.url.endsWith("/api/v1/me")) return me()
    const next = replies.shift()
    if (!next) throw new Error("unexpected request")
    return next()
  })
  const project = createProject("copilot")
  useProjectStore.getState().open(project)
  clearHistory(project.id)
})

afterEach(() => {
  vi.unstubAllGlobals()
  connectManagedAi(null)
})

describe("copilot over managed AI", () => {
  it("streams text, runs tool calls and commits undoable changes", async () => {
    replies = [toolTurn, () => textTurn()]
    const events = await run("add an LED")

    expect(events.map((e) => e.type)).toEqual(["tool_start", "tool_end", "text", "done"])
    const state = useProjectStore.getState()
    expect(state.project?.components.map((c) => c.ref)).toEqual(["D1"])
    expect(state.past).toHaveLength(1)

    const [first, second] = chatCalls()
    expect(first.url).toBe("/api/v1/chat/completions")
    expect(first.headers).toMatchObject({ authorization: "Bearer token-1", "x-posthog-distinct-id": "distinct-1", "content-type": "application/json" })
    expect(first.headers["x-trace-id"]).toMatch(/^[0-9a-f-]{36}$/)
    expect(second.headers["x-trace-id"]).toBe(first.headers["x-trace-id"])
    // The plan's strongest model, the proxy's own wire format, and nothing the proxy refuses.
    expect(first.body).toMatchObject({ model: "vendor/large", stream: true, tool_choice: "auto", reasoning: { effort: "medium" } })
    for (const field of ["provider", "models", "fallbacks", "plugins"]) expect(first.body).not.toHaveProperty(field)
    const tools = first.body!.tools as { type: string; function: { name: string } }[]
    expect(tools.every((t) => t.type === "function")).toBe(true)
    expect(tools.map((t) => t.function.name)).toContain("create_part")

    const messages = second.body!.messages as Record<string, unknown>[]
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"])
    // Thinking goes back whole: fragments of one block merged, signature attached.
    expect(messages[2]).toMatchObject({
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "add_component", arguments: '{"part_id":"led","x":1,"y":0}' } }],
      reasoning_details: [{ type: "reasoning.text", index: 0, text: "Need an LED.", signature: "sig" }],
    })
    expect(messages[3]).toMatchObject({ role: "tool", tool_call_id: "call_1" })
    expect(String(messages[3].content)).toContain("Added D1")
  })

  it("uses the model the user picked while the plan allows it", async () => {
    useUi.setState({ settings: { ...DEFAULT_SETTINGS, model: "vendor/small" } })
    replies = [() => textTurn()]
    await run("hi")
    expect(chatCalls()[0].body?.model).toBe("vendor/small")

    useUi.setState({ settings: { ...DEFAULT_SETTINGS, model: "vendor/retired" } })
    replies = [() => textTurn()]
    await run("hi again")
    expect(chatCalls()[1].body?.model).toBe("vendor/large")
  })

  it("drops a prompt nothing answered, so the next message doesn't resend it", async () => {
    replies = [() => Response.json({ error: { type: "upstream_error", message: "Failed to reach the model provider." } }, { status: 502 }), () => textTurn()]
    const failed = await run("add 10 LEDs")
    expect(failed.find((e) => e.type === "error")).toMatchObject({ message: "Failed to reach the model provider.", kind: "error" })

    await run("add a regulator")
    const messages = chatCalls()[1].body!.messages as { role: string; content: unknown }[]
    expect(messages.slice(1)).toEqual([{ role: "user", content: "add a regulator" }])
  })

  it("surfaces plan and rate-limit refusals with their server message", async () => {
    replies = [() => Response.json({ error: { type: "rate_limited", message: "Daily limit reached on Pro." } }, { status: 429, headers: { "retry-after": "60" } })]
    expect((await run("route it")).find((e) => e.type === "error")).toMatchObject({ kind: "limit", message: "Daily limit reached on Pro." })

    replies = [() => Response.json({ error: { type: "model_not_allowed", message: "vendor/large needs Ultra." } }, { status: 403 })]
    expect((await run("route it")).find((e) => e.type === "error")).toMatchObject({ kind: "plan", message: "vendor/large needs Ultra." })
    // A limit and a plan refusal each refresh what the panel knows of the plan.
    await vi.waitFor(() => expect(calls.filter((c) => c.url.endsWith("/me"))).toHaveLength(3))
  })

  it("offers Ultra and pay-as-you-go when Pro runs out, as the plan is after the refusal", async () => {
    const limited = (limit: string) => () =>
      Response.json({ error: { type: "rate_limited", message: "Daily limit reached (600 AI actions/day on the Pro plan).", limit } }, { status: 429 })
    replies = [limited("day")]
    expect((await run("route it")).find((e) => e.type === "error")).toMatchObject({ kind: "limit", offer: { upgrade: true, payAsYouGo: "enable" } })

    // Pay-as-you-go turned on in another tab since: its spent cap is what stopped this one.
    me = () => Response.json({ ...account(), onDemand: { available: true, enabled: true, capCents: 5_000, creditsThisPeriod: 10_000_000, spentCents: 5_000 } })
    replies = [limited("month")]
    expect((await run("route it")).find((e) => e.type === "error")).toMatchObject({ offer: { upgrade: true, payAsYouGo: "raise" } })

    // The minute burst is the same on every plan: nothing to buy.
    replies = [limited("minute")]
    expect((await run("route it")).find((e) => e.type === "error")).not.toHaveProperty("offer")
  })

  it("doesn't ask the user to sign in for the upstream's own 401", async () => {
    replies = [() => Response.json({ error: { message: "No auth credentials found", code: 401 } }, { status: 401 })]
    expect((await run("hi")).find((e) => e.type === "error")).toMatchObject({ kind: "error", message: "No auth credentials found" })
  })

  it("never calls a model for a plan without the copilot", async () => {
    me = () => Response.json(account({ tier: "free", name: "Free", managedAi: false, allowedModels: [] }))
    const events = await run("add an LED")
    expect(events.find((e) => e.type === "error")).toMatchObject({ kind: "plan", message: "Sakura is included from the Pro plan up." })
    expect(chatCalls()).toHaveLength(0)
  })

  it("asks a signed-out user to sign in without sending anything", async () => {
    connectManagedAi({ getAccessToken: async () => undefined })
    const events = await run("add an LED")
    expect(events.find((e) => e.type === "error")).toMatchObject({ kind: "signin" })
    expect(calls).toHaveLength(0)
    expect(useAccount.getState().status).toBe("signedOut")

    connectManagedAi({ getAccessToken: async () => "expired" })
    me = () => Response.json({ error: { type: "not_authenticated", message: "Invalid or expired access token." } }, { status: 401 })
    await useAccount.getState().load(true)
    expect(useAccount.getState().status).toBe("signedOut")
  })

  it("reports an error that arrives mid-stream", async () => {
    replies = [() => sse({ choices: [{ delta: { content: "Adding" } }] }, { error: { message: "Provider overloaded" } })]
    const events = await run("add an LED")
    expect(events.find((e) => e.type === "error")).toMatchObject({ message: "Provider overloaded" })
  })

  it("answers a call whose arguments aren't JSON with an error result", async () => {
    replies = [
      () =>
        sse(
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_9", function: { name: "add_component", arguments: '{"part_id": "le' } }] } }] },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ),
      () => textTurn("Retried."),
    ]
    const events = await run("add an LED")
    expect(events.find((e) => e.type === "tool_end")).toMatchObject({ isError: true })
    const messages = chatCalls()[1].body!.messages as { role: string; content: string }[]
    expect(messages[3]).toMatchObject({ role: "tool", content: expect.stringContaining("valid JSON") })
    expect(useProjectStore.getState().project?.components).toHaveLength(0)
  })
})

describe("reasoning replay", () => {
  it("merges only adjacent fragments of one block and keeps encrypted entries whole", () => {
    const merged = coalesceReasoningDetails([
      { type: "reasoning.text", index: 0, text: "a" },
      { type: "reasoning.text", index: 0, text: "b", signature: "s" },
      { type: "reasoning.encrypted", index: 1, data: "x" },
      { type: "reasoning.encrypted", index: 1, data: "y" },
      { type: "reasoning.text", index: 0, text: "c" },
    ])
    expect(merged).toEqual([
      { type: "reasoning.text", index: 0, text: "ab", signature: "s" },
      { type: "reasoning.encrypted", index: 1, data: "x" },
      { type: "reasoning.encrypted", index: 1, data: "y" },
      { type: "reasoning.text", index: 0, text: "c" },
    ])
  })
})

describe("limitOffer", () => {
  const onDemand = (available: boolean, enabled: boolean) => ({ ...account(), onDemand: { ...account().onDemand, available, enabled } })
  const ultra = (me: MeResponse): MeResponse => ({ ...me, plan: { ...me.plan, tier: "ultra", name: "Ultra" } })

  it("offers Ultra to Pro, and pay-as-you-go where the account has it", () => {
    expect(limitOffer(onDemand(true, false), "day")).toEqual({ upgrade: true, payAsYouGo: "enable" })
    expect(limitOffer(onDemand(true, true), "month")).toEqual({ upgrade: true, payAsYouGo: "raise" })
    expect(limitOffer(onDemand(false, false), "month")).toEqual({ upgrade: true, payAsYouGo: null })
    expect(limitOffer(ultra(onDemand(true, false)), "month")).toEqual({ upgrade: false, payAsYouGo: "enable" })
  })

  it("doesn't ask to raise a cap that has room again", () => {
    const raised = { ...account(), onDemand: { ...account().onDemand, enabled: true, capCents: 10_000, spentCents: 5_000 } }
    expect(limitOffer(raised, "day")).toEqual({ upgrade: true, payAsYouGo: null })
    expect(limitOffer(ultra(raised), "day")).toBeNull()
  })

  it("offers nothing for the burst, an unknown window, or a plan with nothing to buy", () => {
    expect(limitOffer(onDemand(true, false), "minute")).toBeNull()
    expect(limitOffer(onDemand(true, false), undefined)).toBeNull()
    expect(limitOffer(null, "day")).toBeNull()
    expect(limitOffer(ultra(onDemand(false, false)), "day")).toBeNull()
  })
})
