// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { connectManagedAi, type AssistantActivity } from "../src/ai/managedAi"
import { AssistantChip } from "../src/panels/AssistantChip"
import { ago, assistantClient, assistantState, stateText, WORKING_MS } from "../src/panels/assistantActivity"

// The user's own assistant, connected through MCP, as Sakura's panel shows it: which one it is, from
// the name it gave the server, and whether it is at work on the project open here.

const NOW = Date.UTC(2026, 10, 4, 12)
const activity = (over: Partial<AssistantActivity> = {}): AssistantActivity => ({
  client: "claude-code",
  clientTitle: null,
  connectedAt: NOW - 3_600_000,
  calledAt: NOW - 5_000,
  tool: "route_pcb",
  projectId: "p1",
  ...over,
})

describe("which assistant", () => {
  it.each([
    ["claude-ai", null, "claude"],
    ["claude-code", null, "claudeCode"],
    ["mcp-client", "Claude Code", "claudeCode"],
    ["openai-mcp", null, "chatgpt"],
    ["codex-mcp-client", null, "codex"],
    ["cursor-vscode", null, "cursor"],
    ["Visual Studio Code", null, null],
    [null, null, null],
  ] as const)("%s (%s) is %s", (client, clientTitle, expected) => {
    expect(assistantClient({ client, clientTitle })).toBe(expected)
  })
})

describe("what it is doing", () => {
  it("is at work here while its latest call on the open project is recent, by that call's phase", () => {
    expect(assistantState(activity(), "p1", NOW)).toEqual({ kind: "here", phase: "Routing" })
    expect(assistantState(activity({ tool: "connect" }), "p1", NOW)).toEqual({ kind: "here", phase: "Wiring" })
  })

  it("is at work elsewhere on another project, or on the account's list", () => {
    expect(assistantState(activity(), "p2", NOW)).toEqual({ kind: "elsewhere", project: true })
    expect(assistantState(activity({ tool: "list_projects", projectId: null }), "p1", NOW)).toEqual({ kind: "elsewhere", project: false })
  })

  it("is idle a minute after its latest call, since that call or a later connection", () => {
    const quiet = activity({ calledAt: NOW - WORKING_MS })
    expect(assistantState(quiet, "p1", NOW)).toEqual({ kind: "idle", since: NOW - WORKING_MS, connected: false })
    const reconnected = activity({ calledAt: NOW - 2 * WORKING_MS, connectedAt: NOW - WORKING_MS - 1 })
    expect(assistantState(reconnected, "p1", NOW)).toEqual({ kind: "idle", since: NOW - WORKING_MS - 1, connected: true })
    expect(assistantState(activity({ calledAt: null, connectedAt: NOW - 120_000 }), "p1", NOW)).toMatchObject({ kind: "idle", connected: true })
    expect(assistantState(activity({ calledAt: null, connectedAt: null }), "p1", NOW)).toBeNull()
  })

  it("says it in a few words", () => {
    expect(stateText({ kind: "here", phase: "Routing" }, NOW)).toBe("Routing in this project")
    expect(stateText({ kind: "elsewhere", project: true }, NOW)).toBe("Working on another project")
    expect(stateText({ kind: "idle", since: NOW - 5 * 60_000, connected: false }, NOW)).toBe("Last used 5 min ago")
    expect(stateText({ kind: "idle", since: NOW - 3 * 3_600_000, connected: true }, NOW)).toBe("Connected 3 h ago")
    // The host's clock may be ahead of this one.
    expect(ago(NOW + 4_000, NOW)).toBe("just now")
  })
})

describe("the chip", () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  let root: Root
  let el: HTMLElement
  let emit: (a: AssistantActivity | null) => void = () => {}
  let stopped = 0

  beforeEach(() => {
    el = document.createElement("div")
    document.body.append(el)
    root = createRoot(el)
    stopped = 0
    connectManagedAi({
      getAccessToken: async () => "t",
      watchAssistant: (listener) => {
        emit = (a) => act(() => listener(a))
        listener(null)
        return () => void stopped++
      },
    })
  })
  afterEach(() => {
    act(() => root.unmount())
    el.remove()
    connectManagedAi(null)
  })

  const chip = () => el.querySelector<HTMLElement>("[data-assistant-chip]")

  it("shows nothing until an assistant has connected, then follows it live", () => {
    act(() => root.render(<AssistantChip projectId="p1" />))
    expect(chip()).toBeNull()
    emit(activity({ calledAt: Date.now(), connectedAt: Date.now() - 1000 }))
    expect(chip()?.dataset.assistantChip).toBe("here")
    expect(chip()?.textContent).toBe("Claude CodeRouting in this project")
    emit(activity({ client: "my-agent", clientTitle: "My Agent", calledAt: Date.now() - 10 * 60_000, connectedAt: Date.now() - 20 * 60_000 }))
    expect(chip()?.dataset.assistantChip).toBe("idle")
    expect(chip()?.textContent).toBe("My AgentLast used 10 min ago")
    act(() => root.unmount())
    expect(stopped).toBe(1)
    root = createRoot(el)
  })

  it("shows nothing in a host that doesn't say", () => {
    connectManagedAi({ getAccessToken: async () => "t" })
    act(() => root.render(<AssistantChip projectId="p1" />))
    expect(chip()).toBeNull()
  })
})
