import type { MeResponse } from "@cherryblossom/api-contract"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearHistory, runCopilot, type CopilotEvent } from "../src/ai/copilot"
import { connectManagedAi } from "../src/ai/managedAi"
import { setLookRenderer, type LookRenderer } from "../src/ai/vision/encode"
import { KEEP_IMAGES, MAX_IMAGE_BYTES, MAX_LOOKS_PER_REQUEST } from "../src/ai/vision/limits"
import { OMITTED } from "../src/ai/vision/messages"
// The proxy's own rules: what the editor sends is checked against the real thing.
import { imagePolicyError } from "./fixtures/imagePolicy"
import { fakePicture } from "./fixtures/pictures"
import { createProject } from "../src/model/ops"
import { useAccount } from "../src/store/accountStore"
import { useProjectStore } from "../src/store/projectStore"
import { DEFAULT_SETTINGS } from "../src/store/settings"
import { useUi } from "../src/store/uiStore"

// The whole loop with a scripted model (no model is called): build a circuit, look, fix what the
// numbers name, look again, and be stopped by the cap on the pictures. What the proxy would be
// sent is checked on the way out.

const account: MeResponse = {
  user: { id: "user_1", email: "a@b.c", name: "A" },
  plan: { tier: "pro", name: "Pro", managedAi: true, allowedModels: ["vendor/large"] },
  limits: { maxTokensPerRequest: 64000, requestsPerMinute: 60, requestsPerDay: 600, monthlyTokens: 4_000_000 },
  usage: { requestsThisMinute: 0, minuteResetsAt: null, requestsThisDay: 0, dayResetsAt: null, monthlyTokens: 0, monthResetsAt: null },
  onDemand: { available: true, enabled: false, capCents: 0, creditsThisPeriod: 0, spentCents: 0 },
}

const sse = (...chunks: object[]) =>
  new Response([...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"].join(""), { status: 200, headers: { "content-type": "text/event-stream" } })

/** One model turn that calls these tools, in order. */
const calls = (...tools: [name: string, input: object][]) => () =>
  sse(
    ...tools.map(([name, input], index) => ({ choices: [{ delta: { tool_calls: [{ index, id: `call_${name}_${index}`, function: { name, arguments: JSON.stringify(input) } }] } }] })),
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  )

const says = (text: string) => () => sse({ choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] })

type Part = { type: string; text?: string; image_url?: { url: string } }
type Wire = { role: string; content: string | Part[] | null; tool_call_id?: string }

/** The same shape the proxy lets through (see `fixtures/imagePolicy.ts`). */
const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/
const imagesIn = (messages: Wire[]) => messages.flatMap((m) => (m.role === "user" && Array.isArray(m.content) ? m.content.filter((p) => p.type === "image_url") : []))
const lastToolResult = (messages: Wire[]) => String(messages.filter((m) => m.role === "tool").at(-1)!.content)

let replies: (() => Response)[] = []
let sent: { messages: Wire[] }[] = []
let drawn: string[] = []

const renderer: LookRenderer = {
  async svg(svg, size) {
    drawn.push(svg)
    return { mediaType: "image/png", base64: Buffer.from(`picture ${drawn.length}`).toString("base64"), ...size, bytes: 9 }
  },
  async board3d() {
    throw new Error("not used")
  },
}

async function run(prompt: string, signal?: AbortSignal) {
  const events: CopilotEvent[] = []
  await runCopilot(prompt, { signal, onEvent: (e) => events.push(e) })
  return events
}

const lookEnds = (events: CopilotEvent[]) => events.flatMap((e) => (e.type === "tool_end" && e.name === "look" ? [e] : []))

beforeEach(() => {
  replies = []
  sent = []
  drawn = []
  connectManagedAi({ getAccessToken: async () => "token-1", getDistinctId: () => "distinct-1" })
  useAccount.setState({ status: "idle", account: null, error: null })
  useUi.setState({ settings: { ...DEFAULT_SETTINGS } })
  setLookRenderer(renderer)
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    if (String(url).endsWith("/api/v1/me")) return Response.json(account)
    sent.push(JSON.parse(String(init.body)) as { messages: Wire[] })
    const next = replies.shift()
    if (!next) throw new Error("the model was asked more than the script expected")
    return next()
  })
  const project = createProject("look loop")
  useProjectStore.getState().open(project)
  clearHistory(project.id)
})

afterEach(() => {
  vi.unstubAllGlobals()
  setLookRenderer(undefined)
  connectManagedAi(null)
})

const placed = () => useProjectStore.getState().project!.components.map((c) => `${c.ref}@${c.sch.x}`)

describe("a request that looks at its own work", () => {
  it("builds, looks, fixes what the numbers name, looks again, and reports", async () => {
    replies = [
      // Two parts dropped on top of each other.
      calls(["add_component", { part_id: "resistor", x: 0, y: 0 }], ["add_component", { part_id: "led", x: 0.1, y: 0 }]),
      calls(["look", { target: "schematic" }]),
      calls(["update_component", { ref: "D1", x: 6, y: 0 }], ["look", { target: "schematic" }]),
      says("D1 sat on top of R1, so I moved it right. Nothing overlaps now."),
    ]
    const events = await run("build an LED with a resistor and check it")

    const looks = lookEnds(events)
    expect(looks).toHaveLength(2)
    expect(looks.map((e) => e.isError)).toEqual([false, false])
    expect(looks[0].summary).toMatch(/Looked at the schematic.*problem\(s\)/)
    // The overlap is what went away: the unconnected pins are still there, so not all problems are.
    const problems = looks.map((e) => Number(/(\d+) problem/.exec(e.summary)?.[1]))
    expect(problems[1]).toBeGreaterThan(0)
    expect(problems[1]).toBeLessThan(problems[0])
    expect(events.at(-2)).toMatchObject({ type: "text" })
    expect(events.at(-1)).toMatchObject({ type: "done" })

    // The fix was made with the normal tools, and only off-screen pictures were drawn.
    expect(placed()).toEqual(["R1@0", "D1@6"])
    expect(drawn).toHaveLength(2)
    expect(drawn[0]).not.toBe(drawn[1])

    // Request 3 follows the first look. Its tool result is text with the numbers in it, and the
    // picture comes right after as a user message: an image_url data URL.
    expect(sent).toHaveLength(4)
    const afterFirst = sent[2].messages
    const toolResult = afterFirst.at(-2)!
    expect(toolResult.role).toBe("tool")
    expect(typeof toolResult.content).toBe("string")
    expect(String(toolResult.content)).toMatch(/symbol overlap\(s\): .*(D1\/R1|R1\/D1)/)
    expect(String(toolResult.content)).toContain("is in the next message")
    const picture = afterFirst.at(-1)!
    expect(picture.role).toBe("user")
    const parts = picture.content as Part[]
    expect(parts.map((p) => p.type)).toEqual(["text", "image_url"])
    expect(parts[0].text).toContain("not a message from the user")
    expect(parts[1].image_url!.url).toBe(`data:image/png;base64,${Buffer.from("picture 1").toString("base64")}`)

    // After the fix the overlap is no longer in the numbers.
    expect(lastToolResult(sent[3].messages)).not.toContain("symbol overlap")

    // Everything sent is a shape the proxy accepts, and no picture is over its cap.
    for (const body of sent) {
      for (const part of imagesIn(body.messages)) {
        expect(part.image_url!.url).toMatch(IMAGE_DATA_URL)
        expect(part.image_url!.url.length).toBeLessThanOrEqual((MAX_IMAGE_BYTES * 4) / 3 + 64)
      }
      expect(body.messages.filter((m) => m.role === "tool").every((m) => typeof m.content === "string")).toBe(true)
    }
  })

  it("refuses a look past the cap with a plain message, draws nothing, and the model still reports", async () => {
    replies = [
      calls(["add_component", { part_id: "resistor", x: 0, y: 0 }]),
      calls(["look", { target: "schematic" }], ["look", { target: "schematic" }], ["look", { target: "schematic" }]),
      calls(["look", { target: "schematic" }]),
      says("I looked three times and then stopped; here is what I saw."),
    ]
    const events = await run("check it over and over")

    const looks = lookEnds(events)
    expect(looks.map((e) => e.isError)).toEqual([false, false, false, true])
    expect(looks[3].summary).toBe("Look limit reached for this request")
    expect(drawn).toHaveLength(MAX_LOOKS_PER_REQUEST)

    const last = sent.at(-1)!.messages
    expect(lastToolResult(last)).toContain(`all ${MAX_LOOKS_PER_REQUEST} pictures`)
    expect(lastToolResult(last)).toContain("tell the user plainly")
    // The refused look added no picture: the three of the turn before are all there is.
    expect(imagesIn(last)).toHaveLength(MAX_LOOKS_PER_REQUEST)
    expect(events.at(-1)).toMatchObject({ type: "done" })

    // The next message the user sends gets a full allowance again.
    replies = [calls(["look", { target: "schematic" }]), says("Looked again.")]
    const again = await run("once more")
    expect(lookEnds(again).map((e) => e.isError)).toEqual([false])
    expect(drawn).toHaveLength(MAX_LOOKS_PER_REQUEST + 1)
  })

  it("keeps answering a look past the cap with the cap's own message: the repeat guard never takes over", async () => {
    replies = [
      calls(["add_component", { part_id: "resistor", x: 0, y: 0 }]),
      calls(["look", { target: "schematic" }], ["look", { target: "schematic" }], ["look", { target: "schematic" }]),
      calls(["look", { target: "schematic" }]),
      calls(["look", { target: "schematic" }]),
      calls(["look", { target: "schematic" }]),
      says("Done looking."),
    ]
    const events = await run("keep looking")

    // Three refusals in a row for the same input, each the cap's message, none the guard's.
    const refused = lookEnds(events).slice(3)
    expect(refused).toHaveLength(3)
    expect(refused.every((e) => e.isError && e.summary === "Look limit reached for this request")).toBe(true)
    const results = sent.at(-1)!.messages.filter((m) => m.role === "tool").slice(-3).map((m) => String(m.content))
    for (const text of results) {
      expect(text).toContain(`all ${MAX_LOOKS_PER_REQUEST} pictures`)
      expect(text).not.toContain("already failed")
    }
    expect(drawn).toHaveLength(MAX_LOOKS_PER_REQUEST)
  })

  it("lets the guard stop an identical look that keeps failing, without spending a picture on the refused one", async () => {
    // An empty PCB has nothing to show in 3D, so this look fails each time and uses up a look.
    const failing: [string, object] = ["look", { target: "3d" }]
    replies = [
      calls(failing),
      calls(failing),
      calls(failing),
      calls(["look", { target: "schematic" }]),
      says("The 3D board was empty; here is the schematic."),
    ]
    const events = await run("show me the 3d board")

    const looks = lookEnds(events)
    expect(looks.map((e) => e.isError)).toEqual([true, true, true, false])
    const guarded = sent[3].messages.filter((m) => m.role === "tool").at(-1)!
    expect(String(guarded.content)).toContain("already failed 2 times")
    // Two failures used two looks; the guard's refusal used none, so a different look still had one.
    expect(drawn).toHaveLength(1)
  })

  it("keeps only the newest pictures in what is sent, and says an old one was left out", async () => {
    replies = [
      calls(["add_component", { part_id: "resistor", x: 0, y: 0 }]),
      calls(["look", { target: "schematic" }]),
      calls(["look", { target: "schematic" }]),
      calls(["look", { target: "schematic" }]),
      says("Done."),
    ]
    await run("look three times")
    const last = sent.at(-1)!.messages
    expect(imagesIn(last)).toHaveLength(KEEP_IMAGES)
    expect(JSON.stringify(last)).toContain(OMITTED)
    // Every look still has its own tool result, so no call is left without an answer.
    expect(last.filter((m) => m.role === "tool")).toHaveLength(4)
  })

  it("still answers when the editor has nowhere to draw: the model gets the numbers", async () => {
    setLookRenderer(null)
    replies = [calls(["add_component", { part_id: "resistor", x: 0, y: 0 }]), calls(["look", { target: "schematic" }]), says("Checked the numbers only.")]
    const events = await run("look")
    expect(events.at(-1)).toMatchObject({ type: "done" })
    const last = sent.at(-1)!.messages
    expect(imagesIn(last)).toHaveLength(0)
    expect(lastToolResult(last)).toContain("nowhere to draw one")
  })
})

describe("pictures over many requests", () => {
  /** A renderer that makes pictures at the byte cap, one distinct picture per look, and keeps them. */
  const bigPictures = (bytes = MAX_IMAGE_BYTES - 10_000) => {
    const made: string[] = []
    setLookRenderer({
      async svg(_svg, size) {
        const picture = fakePicture(String.fromCharCode(97 + made.length), bytes)
        made.push(dataUrl(picture))
        return { ...picture, ...size }
      },
      async board3d() {
        throw new Error("not used")
      },
    })
    return made
  }
  const dataUrl = (i: { mediaType: string; base64: string }) => `data:${i.mediaType};base64,${i.base64}`
  const threeLooks = calls(["look", { target: "schematic" }], ["look", { target: "schematic" }], ["look", { target: "schematic" }])
  const wirePictures = (messages: Wire[]) => imagesIn(messages).map((p) => p.image_url!.url)
  const proxyAccepts = (body: { messages: Wire[] }) => imagePolicyError({ model: "vendor/large", ...body })

  it("never sends a request the proxy would refuse, with three 440 KB looks in each of three requests", async () => {
    const made = bigPictures()
    replies = [
      calls(["add_component", { part_id: "resistor", x: 0, y: 0 }]),
      threeLooks,
      says("Looked."),
      threeLooks,
      says("Looked again."),
      threeLooks,
      says("And again."),
    ]
    await run("first")
    await run("second")
    await run("third")

    expect(made).toHaveLength(9)
    expect(sent).toHaveLength(7)
    // Every request sent is one the proxy accepts, and none holds more than one batch of pictures.
    for (const body of sent) {
      expect(proxyAccepts(body)).toBeNull()
      expect(imagesIn(body.messages).length).toBeLessThanOrEqual(MAX_LOOKS_PER_REQUEST)
    }
    // The request after each batch holds all three of its pictures, in order, and nothing older.
    expect(wirePictures(sent[2].messages)).toEqual(made.slice(0, 3))
    expect(wirePictures(sent[4].messages)).toEqual(made.slice(3, 6))
    expect(wirePictures(sent[6].messages)).toEqual(made.slice(6, 9))
    // What the older ones were is still said, where each stood.
    expect(JSON.stringify(sent[6].messages)).toContain(OMITTED)
  })

  it("keeps the newest two pictures across batches of one look, and the whole of a batch of three", async () => {
    const made = bigPictures()
    const one = calls(["look", { target: "schematic" }])
    replies = [calls(["add_component", { part_id: "resistor", x: 0, y: 0 }]), one, one, one, says("Done."), threeLooks, says("Done.")]
    await run("one at a time")
    expect(wirePictures(sent.at(-1)!.messages)).toEqual(made.slice(1, 3))
    await run("three at once")
    // Three arrived together: all three stay, which is one more than the usual two, and no older one.
    expect(wirePictures(sent.at(-1)!.messages)).toEqual(made.slice(3, 6))
    for (const body of sent) expect(proxyAccepts(body)).toBeNull()
  })

  it("leaves a picture out instead of sending one the proxy would refuse, and the conversation goes on", async () => {
    // A renderer that breaks its own cap: 700 KB is over the proxy's limit for one picture.
    const made = bigPictures(700_000)
    replies = [calls(["add_component", { part_id: "resistor", x: 0, y: 0 }]), threeLooks, says("Numbers only, then."), says("Still here.")]
    await run("too big")
    await run("and the next message")
    expect(made).toHaveLength(3)
    for (const body of sent) {
      expect(proxyAccepts(body)).toBeNull()
      expect(imagesIn(body.messages)).toHaveLength(0)
    }
    expect(JSON.stringify(sent[2].messages)).toContain(OMITTED)
    expect(sent).toHaveLength(4)
  })

  it("after a stop mid-batch, a look that made its picture has it in the next message, and one that did not says nothing of one", async () => {
    const controller = new AbortController()
    const made: string[] = []
    setLookRenderer({
      async svg(_svg, size) {
        if (made.length === 1) {
          // The user presses stop while the second picture is being drawn.
          controller.abort()
          throw new Error("drawing was stopped")
        }
        const picture = fakePicture("a", 20_000)
        made.push(dataUrl(picture))
        return { ...picture, ...size }
      },
      async board3d() {
        throw new Error("not used")
      },
    })
    replies = [calls(["add_component", { part_id: "resistor", x: 0, y: 0 }]), threeLooks]
    const events = await run("look three times", controller.signal)
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "aborted" })

    replies = [says("Carrying on.")]
    await run("go on")
    const messages = sent.at(-1)!.messages
    const results = messages.filter((m) => m.role === "tool").slice(-3)
    expect(results).toHaveLength(3)
    // The first look made its picture and the model has it, straight after the tool results.
    expect(String(results[0].content)).toContain("is in the next message")
    expect(wirePictures(messages)).toEqual(made)
    const afterResults = messages[messages.lastIndexOf(results[2]) + 1]
    expect(afterResults.role).toBe("user")
    expect(JSON.stringify(afterResults.content)).toContain("image_url")
    // The others made none and promise none.
    for (const result of results.slice(1)) {
      expect(String(result.content)).not.toContain("next message")
      expect(String(result.content)).not.toContain("picture (")
    }
    for (const body of sent) expect(proxyAccepts(body)).toBeNull()
  })
})
