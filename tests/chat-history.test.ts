import type { MeResponse } from "@cherryblossom/api-contract"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CHAT_FILE_FORMAT, chatTitle, parseChat, serializeChat, TRIMMED_RESULT, type ChatConversation } from "../src/ai/chatFile"
import { clearHistory } from "../src/ai/copilot"
import { connectManagedAi, type ChatMessage } from "../src/ai/managedAi"
import { OMITTED } from "../src/ai/vision/messages"
import { createProject } from "../src/model/ops"
import { useAccount } from "../src/store/accountStore"
import { activeEntries, chatSaves, useCopilot, type Entry } from "../src/store/copilotStore"
import { useProjectStore } from "../src/store/projectStore"
import { DEFAULT_SETTINGS } from "../src/store/settings"
import { useUi } from "../src/store/uiStore"

/**
 * Sakura's chats: several per project, kept (here in the page, the harness's way; the website's in the account), listed
 * newest first, and carried on later with what the model was told, as files the editor writes (`ai/chatFile.ts`).
 */

const user = (text: string, id = 1): Entry => ({ kind: "user", id, text })
const conversation = (messages: ChatMessage[]): ChatConversation => ({ id: "trace-1", messages })
const picture = "data:image/png;base64," + "A".repeat(4000)

describe("the chat file", () => {
  it("leaves the pictures and all but the last turn's reasoning out, and reads back what it wrote", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "add an LED" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "look", arguments: "{}" } }], reasoning_details: [{ type: "reasoning.text", text: "old" }] },
      { role: "tool", tool_call_id: "c1", content: "Looked." },
      { role: "user", content: [{ type: "text", text: "The picture." }, { type: "image_url", image_url: { url: picture } }, { type: "image_url", image_url: { url: picture } }] },
      { role: "assistant", content: "Done.", reasoning_details: [{ type: "reasoning.text", text: "last" }] },
    ]
    const entries: Entry[] = [user("add an LED"), { kind: "tool", id: 2, toolId: "c1", label: "Looked", status: "ok", changed: false }, { kind: "assistant", id: 3, text: "Done." }]
    const text = serializeChat(entries, conversation(messages))
    expect(text).not.toContain("base64")
    expect(JSON.parse(text)).toMatchObject({ format: CHAT_FILE_FORMAT, version: 1, conversationId: "trace-1" })

    const read = parseChat(text)!
    expect(read.entries).toEqual(entries)
    expect(read.conversation.id).toBe("trace-1")
    expect(read.conversation.messages[1]).not.toHaveProperty("reasoning_details")
    expect(read.conversation.messages[3]).toEqual({ role: "user", content: [{ type: "text", text: "The picture." }, { type: "text", text: OMITTED }] })
    expect(read.conversation.messages[4]).toMatchObject({ reasoning_details: [{ text: "last" }] })
    // The tab's own copy keeps its pictures.
    expect(JSON.stringify(messages)).toContain("base64")
  })

  it("fits a long chat: the oldest tool results go first, then the oldest requests, and every call keeps its result", () => {
    const request = (n: number): ChatMessage[] => [
      { role: "user", content: `request ${n}` },
      { role: "assistant", content: null, tool_calls: [{ id: `c${n}`, type: "function", function: { name: "get_design", arguments: "{}" } }] },
      { role: "tool", tool_call_id: `c${n}`, content: `design ${n} `.repeat(2000) },
      { role: "assistant", content: `Answer ${n}.` },
    ]
    const messages = [1, 2, 3, 4].flatMap(request)
    const entries = [1, 2, 3, 4].map((n) => user(`request ${n}`, n))
    const full = serializeChat(entries, conversation(messages), Infinity)

    // Room for two results of four: the two oldest are shortened, and nothing else changes.
    const two = parseChat(serializeChat(entries, conversation(messages), full.length - 30_000))!
    const results = two.conversation.messages.filter((m) => m.role === "tool").map((m) => m.content)
    expect(results.map((r) => r === TRIMMED_RESULT)).toEqual([true, true, false, false])
    expect(two.entries).toHaveLength(4)

    // Room for less than the requests themselves: the oldest leave what the model is told, whole, starting at a request.
    const small = parseChat(serializeChat(entries, conversation(messages), 1_200))!
    const kept = small.conversation.messages
    expect(kept[0]).toEqual({ role: "user", content: expect.stringMatching(/^request \d$/) })
    expect(kept.length).toBeLessThan(messages.length)
    const calls = kept.flatMap((m) => (m.role === "assistant" ? (m.tool_calls ?? []).map((c) => c.id) : []))
    const answered = new Set(kept.flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : [])))
    expect(calls.every((id) => answered.has(id))).toBe(true)
    expect(serializeChat(entries, conversation(messages), 1_200).length).toBeLessThanOrEqual(1_200)
  })

  it("reads nothing but a chat file of its version or older, and what was under way when it was written is over", () => {
    expect(parseChat("not json")).toBeNull()
    expect(parseChat(JSON.stringify({ format: "cherryblossom.project", version: 1 }))).toBeNull()
    expect(parseChat(JSON.stringify({ format: CHAT_FILE_FORMAT, version: 99, conversationId: "x", entries: [], messages: [] }))).toBeNull()
    const read = parseChat(
      JSON.stringify({
        format: CHAT_FILE_FORMAT,
        version: 1,
        conversationId: "x",
        entries: [
          { kind: "tool", id: 1, toolId: "c1", label: "Routing", status: "running", changed: false },
          { kind: "plan", id: 2, plan: { blocks: [], left: [] }, status: "applying" },
          { kind: "plan", id: 3, plan: { blocks: [], left: [] }, status: "pending" },
          { kind: "mystery", id: 4 },
        ],
        messages: [],
      }),
    )!
    expect(read.entries.map((e) => ("status" in e ? e.status : e.kind))).toEqual(["error", "cancelled", "pending"])
  })

  it("is titled by its first request, on one line", () => {
    expect(chatTitle([])).toBe("New chat")
    expect(chatTitle([{ kind: "assistant", id: 1, text: "Hi" }, user("  add a\n3.3 V  regulator ", 2)])).toBe("add a 3.3 V regulator")
    const long = chatTitle([user("x".repeat(200))])
    expect(long).toHaveLength(80)
    expect(long.endsWith("…")).toBe(true)
  })
})

const account: MeResponse = {
  user: { id: "user_1", email: "a@b.c", name: "A" },
  plan: { tier: "pro", name: "Pro", managedAi: true, allowedModels: ["vendor/large"] },
  limits: { maxTokensPerRequest: 64000, requestsPerMinute: 60, requestsPerDay: 600, monthlyTokens: 4_000_000 },
  usage: { requestsThisMinute: 0, minuteResetsAt: null, requestsThisDay: 0, dayResetsAt: null, monthlyTokens: 0, monthResetsAt: null },
  onDemand: { available: true, enabled: false, capCents: 0, creditsThisPeriod: 0, spentCents: 0 },
}

const reply = (text: string) =>
  new Response(
    [{ choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }].map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )

interface Sent {
  messages: { role: string; content: unknown }[]
  trace: string
}

let sent: Sent[] = []
let replies: string[] = []
let projectId = ""
let unwatch = () => {}

const store = () => useCopilot.getState()
const shown = () => (activeEntries(store(), projectId) ?? []).map((e) => (e.kind === "user" || e.kind === "assistant" ? `${e.kind}: ${e.text}` : e.kind))
const listed = () => (store().chats[projectId] ?? []).map((c) => c.title)

/** Send a message to the chat shown, and wait for Sakura's answer and the chat's save. */
async function ask(text: string, answer: string) {
  replies.push(answer)
  store().send(projectId, text)
  await vi.waitFor(() => expect(store().runningProject).toBeNull())
  await chatSaves()
}

/** A new tab: nothing of the chats in memory, only what storage has. */
function reloadTab() {
  for (const id of Object.keys(store().threads)) clearHistory(id)
  useCopilot.setState({ threads: {}, active: {} })
}

beforeEach(() => {
  sent = []
  replies = []
  connectManagedAi({ getAccessToken: async () => "token-1" })
  useAccount.setState({ status: "ready", account, error: null })
  useUi.setState({ settings: { ...DEFAULT_SETTINGS } })
  useCopilot.setState({ threads: {}, active: {}, chats: {}, opening: null, runningProject: null, runningChat: null, controller: null, cleanup: null })
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body)) as { messages: Sent["messages"] }
    sent.push({ messages: body.messages, trace: (init.headers as Record<string, string>)["x-trace-id"] })
    const next = replies.shift()
    if (next === undefined) throw new Error("unexpected request")
    return reply(next)
  })
  const project = createProject("chats")
  useProjectStore.getState().open(project)
  projectId = project.id
  unwatch = store().watchChats(projectId)
})

afterEach(() => {
  unwatch()
  vi.unstubAllGlobals()
  connectManagedAi(null)
})

describe("Sakura's chats", () => {
  it("keeps every chat of a project, newest first, and carries an old one on with what the model was told", async () => {
    await ask("add an LED", "Added D1.")
    expect(listed()).toEqual(["add an LED"])
    const ledTrace = sent[0].trace

    store().newChat(projectId)
    expect(shown()).toEqual([])
    await ask("say hi", "Hi.")
    // A new chat is a new conversation: the model hears nothing of the first.
    expect(sent[1].messages.map((m) => m.content)).not.toContain("add an LED")
    expect(sent[1].trace).not.toBe(ledTrace)
    expect(listed()).toEqual(["say hi", "add an LED"])

    reloadTab()
    const led = store().chats[projectId]!.find((c) => c.title === "add an LED")!
    expect(await store().openChat(projectId, led.id)).toBeNull()
    expect(shown()).toEqual(["user: add an LED", "assistant: Added D1."])

    await ask("now a resistor", "Added R1.")
    expect(sent[2].messages.map((m) => [m.role, m.content])).toEqual([
      ["system", expect.anything()],
      ["user", "add an LED"],
      ["assistant", "Added D1."],
      ["user", "now a resistor"],
    ])
    // The same conversation as before: one trace, and the provider's cache key.
    expect(sent[2].trace).toBe(ledTrace)
    expect(listed()).toEqual(["add an LED", "say hi"])
    expect(shown()).toEqual(["user: add an LED", "assistant: Added D1.", "user: now a resistor", "assistant: Added R1."])
  })

  it("lists a chat from its first message, and leaves a new chat nothing was said in unlisted", async () => {
    replies.push("Thinking it over.")
    store().send(projectId, "route the board")
    // Listed before Sakura answers.
    await vi.waitFor(() => expect(listed()).toEqual(["route the board"]))
    await vi.waitFor(() => expect(store().runningProject).toBeNull())
    await chatSaves()
    const chats = Object.keys(store().threads).length
    store().newChat(projectId)
    store().newChat(projectId)
    expect(listed()).toEqual(["route the board"])
    expect(Object.keys(store().threads)).toHaveLength(chats)
  })

  it("shows another chat while one runs, and keeps the answer in the chat it was asked in", async () => {
    await ask("first", "One.")
    const first = store().active[projectId]
    store().newChat(projectId)
    let answer: (r: Response) => void = () => {}
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit = {}) => {
      sent.push({ messages: JSON.parse(String(init.body)).messages, trace: "" })
      return new Promise<Response>((resolve) => (answer = resolve))
    })
    store().send(projectId, "second")
    const second = store().active[projectId]
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(await store().openChat(projectId, first)).toBeNull()
    // The running chat can't be deleted from under it.
    await store().deleteChat(projectId, second)
    expect(store().threads[second]).toBeDefined()
    answer(reply("Two."))
    await vi.waitFor(() => expect(store().runningProject).toBeNull())
    await chatSaves()
    expect(shown()).toEqual(["user: first", "assistant: One."])
    expect(store().threads[second].entries.map((e) => e.kind === "assistant" && e.text).filter(Boolean)).toEqual(["Two."])
  })

  it("deletes a chat for good, and says so when it is opened from an old list", async () => {
    await ask("add an LED", "Added D1.")
    const chatId = store().active[projectId]
    const list = store().chats[projectId]!
    await store().deleteChat(projectId, chatId)
    expect(listed()).toEqual([])
    expect(store().active[projectId]).toBeUndefined()
    expect(shown()).toEqual([])

    useCopilot.setState((s) => ({ chats: { ...s.chats, [projectId]: list } }))
    expect(await store().openChat(projectId, chatId)).toBe("That chat is gone.")
    expect(store().active[projectId]).toBeUndefined()
    expect(store().opening).toBeNull()
  })
})
