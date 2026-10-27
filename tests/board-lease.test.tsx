// @vitest-environment jsdom
import type { MeResponse } from "@cherryblossom/api-contract"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearHistory, runCopilot, type CopilotEvent } from "../src/ai/copilot"
import { connectManagedAi } from "../src/ai/managedAi"
import { applyCleanup, openCleanup, useCleanup } from "../src/editor/schematic/cleanupAction"
import { onTidy } from "../src/editor/schematic/tidyAction"
import { startTidy } from "../src/editor/schematic/tidyAction"
import { EXAMPLES } from "../src/model/examples"
import { createProject } from "../src/model/ops"
import { Collaborators } from "../src/panels/Collaborators"
import { PcbToolbar, SchematicToolbar } from "../src/panels/CanvasToolbar"
import { useAccount } from "../src/store/accountStore"
import { LEASE_MS, RENEW_MS, startBoardLease, useBoardLease, withBoard, wholeBoardAction, type LeaseHolder, type LockSource } from "../src/store/boardLease"
import { useCopilot } from "../src/store/copilotStore"
import { startPresence, usePresence, type PresencePeer, type PresenceSource } from "../src/store/presence"
import { projectApi, useProjectStore } from "../src/store/projectStore"
import { DEFAULT_SETTINGS } from "../src/store/settings"
import { useUi } from "../src/store/uiStore"

// Sakura with several people on a project: a collaborator sees "Sakura for Ada" beside her face while her run is
// active, and a whole-board action (Sakura's route/re-place/clear/tidy tools, the toolbar's Re-pack, Autoroute and
// Tidy, Clean up) takes a lease first, so two tabs never rewrite the board at once.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ---------- A stand-in for the hosted app's lease ----------

function fakeServer() {
  let holder: (LeaseHolder & { mine?: boolean }) | null = null
  const watchers = new Set<(h: LeaseHolder | null) => void>()
  const calls: string[] = []
  const emit = () => watchers.forEach((w) => w(holder))
  const source: LockSource = {
    async acquire(_p, session, me, action, viaSakura) {
      calls.push(`acquire:${action}`)
      if (holder && holder.expiresAt > Date.now() && holder.sessionId !== session) return { ok: false, reason: "held", holder: { ...holder, mine: holder.userId === "user_me" } }
      holder = { userId: "user_me", sessionId: session, name: me.name, action, viaSakura, since: Date.now(), expiresAt: Date.now() + LEASE_MS }
      emit()
      return { ok: true }
    },
    async renew(_p, session) {
      calls.push("renew")
      if (!holder || holder.sessionId !== session) return false
      holder = { ...holder, expiresAt: Date.now() + LEASE_MS }
      return true
    },
    async release(_p, session) {
      calls.push("release")
      if (holder?.sessionId === session) {
        holder = null
        emit()
      }
    },
    watch(_p, listener) {
      watchers.add(listener)
      listener(holder)
      return () => void watchers.delete(listener)
    },
  }
  return {
    source,
    calls,
    get holder() {
      return holder
    },
    /** Another tab takes the lease. */
    take(who: Partial<LeaseHolder> = {}) {
      holder = { userId: "user_ada", sessionId: "tab_ada", name: "Ada Lovelace", action: "route_pcb", viaSakura: true, since: Date.now(), expiresAt: Date.now() + LEASE_MS, ...who }
      emit()
    },
    free() {
      holder = null
      emit()
    },
  }
}

let server: ReturnType<typeof fakeServer>
let stop: () => void
let root: Root
let host: HTMLElement

beforeEach(() => {
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
  server = fakeServer()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  stop?.()
  useCopilot.setState({ runningProject: null, activity: null })
  useProjectStore.setState({ role: "owner" })
  vi.useRealTimers()
  vi.unstubAllGlobals()
  connectManagedAi(null)
})

const open = (project = createProject("lease")) => {
  useProjectStore.getState().open(project)
  clearHistory(project.id)
  stop = startBoardLease(project.id, "tab_me", server.source, () => ({ name: "Me" }), "user_me")
  return project
}

// ---------- Sakura's tools ----------

const account = (): MeResponse => ({
  user: { id: "user_me", email: "a@b.c", name: "A" },
  plan: { tier: "pro", name: "Pro", managedAi: true, allowedModels: ["vendor/small"], tools: undefined } as unknown as MeResponse["plan"],
  limits: { maxTokensPerRequest: 64000, requestsPerMinute: 60, requestsPerDay: 600, monthlyTokens: 4_000_000 },
  usage: { requestsThisMinute: 0, minuteResetsAt: null, requestsThisDay: 0, dayResetsAt: null, monthlyTokens: 0, monthResetsAt: null },
  onDemand: { available: true, enabled: false, capCents: 0, creditsThisPeriod: 0, spentCents: 0 },
})
const sse = (...chunks: object[]) =>
  new Response([...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"].join(""), { status: 200, headers: { "content-type": "text/event-stream" } })
const callTurn = (name: string, args: object) => () =>
  sse(
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: JSON.stringify(args) } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  )
const textTurn = () => sse({ choices: [{ delta: { content: "Done." } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] })

let requests: { messages: { role: string; content: unknown }[] }[] = []
function sakura(...replies: (() => Response)[]) {
  requests = []
  connectManagedAi({ getAccessToken: async () => "token-1", getDistinctId: () => "distinct-1" })
  useAccount.setState({ status: "idle", account: null, error: null })
  useUi.setState({ settings: { ...DEFAULT_SETTINGS } })
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    if (String(url).endsWith("/api/v1/me")) return Response.json(account())
    requests.push(JSON.parse(String(init.body)))
    const next = replies.shift()
    if (!next) throw new Error("unexpected request")
    return next()
  })
}
const toolResults = () => requests.flatMap((r) => r.messages.filter((m) => m.role === "tool").map((m) => String(m.content)))
async function run(prompt = "route it") {
  const events: CopilotEvent[] = []
  await runCopilot(prompt, { onEvent: (e) => events.push(e) })
  return events
}

describe("which tools take the lease", () => {
  it("is the ones that rewrite much of the board or sheet", () => {
    expect(wholeBoardAction("layout_pcb", {})).toBe("layout_pcb")
    expect(wholeBoardAction("layout_pcb", { relayout_all: true })).toBe("relayout_all")
    expect(wholeBoardAction("route_pcb", {})).toBe("route_pcb")
    expect(wholeBoardAction("clear_routing", {})).toBe("clear_routing")
    expect(wholeBoardAction("tidy_schematic", { whole_sheet: true })).toBe("tidy_schematic")
    // Scoped to what the call names: no lease.
    expect(wholeBoardAction("clear_routing", { nets: ["GND"] })).toBeNull()
    expect(wholeBoardAction("clear_routing", { refs: ["U1"] })).toBeNull()
    expect(wholeBoardAction("tidy_schematic", { blocks: ["POWER"] })).toBeNull()
    for (const name of ["add_component", "connect", "place_parts", "set_board", "set_pour", "set_net_width", "group_parts", "run_checks"]) expect(wholeBoardAction(name, {}), name).toBeNull()
  })
})

describe("Sakura's whole-board tools and the lease", () => {
  it("does not run while another person's Sakura holds it, says who and what, and runs once it is released", async () => {
    const project = open(EXAMPLES[0].project)
    server.take({ action: "route_pcb", viaSakura: true })
    sakura(callTurn("layout_pcb", { relayout_all: true }), textTurn)
    const events = await run()
    const refused = "Ada's Sakura is routing the board right now. Wait for it to finish, or work on something else."
    expect(toolResults()[0]).toContain(refused)
    expect(events.find((e) => e.type === "tool_end")).toMatchObject({ isError: true, changed: false })
    // Nothing changed, and Ada's lease is still hers.
    expect(useProjectStore.getState().project).toBe(project)
    expect(server.holder?.userId).toBe("user_ada")

    server.free()
    sakura(callTurn("layout_pcb", { relayout_all: true }), textTurn)
    const events2 = await run("again")
    expect(toolResults().at(-1)).not.toContain("right now")
    expect(events2.find((e) => e.type === "tool_end")).toMatchObject({ isError: false, changed: true })
    expect(useProjectStore.getState().project).not.toBe(project)
    // Taken for the tool, and let go of when it finished.
    expect(server.calls).toContain("acquire:relayout_all")
    expect(server.holder).toBeNull()
  })

  it("says 'your other tab' when the holder is the user's own other tab", async () => {
    open(EXAMPLES[0].project)
    server.take({ userId: "user_me", sessionId: "tab_other", name: "Me", action: "tidy_schematic", viaSakura: false })
    sakura(callTurn("tidy_schematic", { whole_sheet: true }), textTurn)
    await run()
    expect(toolResults()[0]).toContain("Your other tab is tidying the schematic right now. Wait for it to finish, or work on something else.")
  })

  it("does not ask for the lease for a tool that edits one thing", async () => {
    open(createProject("one"))
    server.take()
    sakura(callTurn("add_component", { part_id: "led", x: 1, y: 0 }), textTurn)
    await run()
    expect(server.calls).toEqual([])
    expect(toolResults()[0]).not.toContain("right now")
  })

  it("works as before where the host has no leases", async () => {
    const project = EXAMPLES[0].project
    useProjectStore.getState().open(project)
    clearHistory(project.id)
    sakura(callTurn("layout_pcb", { relayout_all: true }), textTurn)
    await run()
    expect(toolResults()[0]).not.toContain("right now")
    expect(useProjectStore.getState().project).not.toBe(project)
  })
})

describe("holding, renewing and releasing", () => {
  it("renews every 20 s while the action runs and lets go when it ends, on an error too", async () => {
    vi.useFakeTimers()
    open()
    let finish: () => void = () => {}
    const running = withBoard("repack", () => new Promise<string>((resolve) => (finish = () => resolve("done"))))
    await vi.advanceTimersByTimeAsync(0)
    expect(server.holder).toMatchObject({ sessionId: "tab_me", action: "repack" })
    await vi.advanceTimersByTimeAsync(RENEW_MS * 2 + 100)
    expect(server.calls.filter((c) => c === "renew")).toHaveLength(2)
    finish()
    expect(await running).toEqual({ ok: true, value: "done" })
    expect(server.holder).toBeNull()
    await vi.advanceTimersByTimeAsync(RENEW_MS * 2)
    expect(server.calls.filter((c) => c === "renew")).toHaveLength(2)

    await expect(
      withBoard("autoroute", () => {
        throw new Error("router fell over")
      }),
    ).rejects.toThrow("router fell over")
    expect(server.holder).toBeNull()
  })

  it("shares the lease between actions of one tab, and frees it when the last lets go", async () => {
    open()
    let finishInner: () => void = () => {}
    let innerRunning: () => void = () => {}
    const started = new Promise<void>((resolve) => (innerRunning = resolve))
    const outer = withBoard("cleanup", async () => {
      await withBoard("tidy", () => new Promise<void>((resolve) => ((finishInner = resolve), innerRunning())))
      // The inner one let go; the outer one still holds it.
      expect(server.holder).toMatchObject({ action: "cleanup" })
    })
    await started
    finishInner()
    await outer
    expect(server.holder).toBeNull()
    expect(server.calls.filter((c) => c === "release")).toHaveLength(1)
    expect(server.calls.filter((c) => c.startsWith("acquire"))).toEqual(["acquire:cleanup"])
  })

  it("lets a tab that holds nothing through when the lease can't be reached", async () => {
    open()
    server.source.acquire = async () => {
      throw new Error("offline")
    }
    expect(await withBoard("repack", () => 1)).toEqual({ ok: true, value: 1 })
  })
})

// ---------- What people see ----------

const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label) as HTMLButtonElement | undefined

describe("the toolbars", () => {
  it("show who holds the board, and turn the whole-board buttons off meanwhile", () => {
    open()
    act(() => root.render(<PcbToolbar />))
    expect(host.querySelector("[data-board-held]")).toBeNull()
    expect(button("Autoroute")!.disabled).toBe(false)

    act(() => server.take({ action: "route_pcb", viaSakura: false }))
    expect(host.querySelector("[data-board-held]")!.textContent).toBe("Ada is routing the board right now.")
    expect(button("Autoroute")!.disabled).toBe(true)
    expect(button("Re-pack parts")!.disabled).toBe(true)

    act(() => server.take({ action: "relayout_all", viaSakura: true }))
    expect(host.querySelector("[data-board-held]")!.textContent).toBe("Ada's Sakura is re-placing every part on the board right now.")

    act(() => server.free())
    expect(host.querySelector("[data-board-held]")).toBeNull()
    expect(button("Autoroute")!.disabled).toBe(false)
  })

  it("show the schematic's Tidy as held, and a Tidy from the T key says why it did not run", () => {
    open()
    act(() => root.render(<SchematicToolbar />))
    act(() => server.take({ userId: "user_me", sessionId: "tab_other", name: "Me", action: "tidy", viaSakura: false }))
    expect(host.querySelector("[data-board-held]")!.textContent).toBe("Your other tab is tidying the schematic right now.")
    expect(button("Tidy the schematic")!.disabled).toBe(true)
    // The key does not go through the button: the lease still refuses it.
    act(() => useBoardLease.setState({ holder: null }))
    const heard: string[] = []
    const off = onTidy((r) => heard.push(r.message))
    startTidy()
    return vi.waitFor(() => expect(heard).toHaveLength(1)).then(() => {
      off()
      expect(heard[0]).toBe("Your other tab is tidying the schematic right now. Wait for it to finish, or work on something else.")
      expect(projectApi().project).toBeTruthy()
    })
  })

  it("stop Clean up when someone else holds the board, and Clean up holds it while it runs", async () => {
    open(EXAMPLES[0].project)
    const heard: string[] = []
    const off = onTidy((r) => heard.push(r.message))
    openCleanup()
    expect(useCleanup.getState().phase.kind).toBe("preview")
    server.take({ action: "tidy_schematic", viaSakura: true })
    applyCleanup()
    await vi.waitFor(() => expect(heard).toHaveLength(1))
    expect(heard[0]).toContain("Ada's Sakura is tidying the schematic right now.")
    expect(useCleanup.getState().phase.kind).toBe("idle")

    server.free()
    openCleanup()
    applyCleanup()
    await vi.waitFor(() => expect(server.calls).toContain("acquire:cleanup"))
    await vi.waitFor(() => expect(useCleanup.getState().phase.kind).toBe("idle"))
    await vi.waitFor(() => expect(server.holder).toBeNull())
    off()
  })

  it("let the lease go when the holder's expiry passes without a word from the server", () => {
    vi.useFakeTimers()
    open()
    act(() => root.render(<PcbToolbar />))
    act(() => server.take())
    expect(host.querySelector("[data-board-held]")).not.toBeNull()
    act(() => void vi.advanceTimersByTime(LEASE_MS + 100))
    expect(host.querySelector("[data-board-held]")).toBeNull()
  })
})

describe("Sakura is working for them", () => {
  const rows = (copilot: object | null, updatedAt = Date.now()): PresencePeer[] => [
    { sessionId: "tab_ada", userId: "user_ada", name: "Ada Lovelace", state: JSON.stringify({ view: "pcb", ...copilot }), updatedAt },
  ]

  it("appears beside a collaborator's face while their run is active, with what it is doing, and clears when it ends", () => {
    vi.useFakeTimers()
    const project = createProject("together")
    useProjectStore.getState().open(project)
    let push: (r: PresencePeer[]) => void = () => {}
    const sent: string[] = []
    const source: PresenceSource = {
      update: async (_p, _s, _m, state) => (sent.push(state), true),
      leave: () => {},
      watch: (_p, listener) => {
        push = listener
        return () => {}
      },
    }
    stop = startPresence(project.id, "tab_me", source, () => ({ name: "Me" }), "user_me")
    act(() => root.render(<Collaborators />))
    const chip = () => host.querySelector("[data-sakura-chip]")?.textContent ?? null

    act(() => push(rows({})))
    expect(host.textContent).not.toContain("Sakura")
    expect(chip()).toBeNull()

    act(() => push(rows({ copilot: true, copilotLabel: "Routing" }, Date.now() + 1)))
    expect(chip()).toBe("Sakura for Ada Lovelace: Routing")
    expect(usePresence.getState().peers[0].state).toMatchObject({ copilot: true, copilotLabel: "Routing" })

    act(() => push(rows({ copilot: true, copilotLabel: "Thinking" }, Date.now() + 2)))
    expect(chip()).toBe("Sakura for Ada Lovelace: Thinking")

    // The run ended, was stopped or failed: the row says no more.
    act(() => push(rows({}, Date.now() + 3)))
    expect(chip()).toBeNull()
  })

  it("is what this tab sends while its own run is active, and not after", async () => {
    vi.useFakeTimers()
    const project = createProject("together")
    useProjectStore.getState().open(project)
    const sent: Record<string, unknown>[] = []
    const source: PresenceSource = {
      update: async (_p, _s, _m, state) => (sent.push(JSON.parse(state)), true),
      leave: () => {},
      watch: (_p, listener) => {
        // Company, so the tab says what it does at once.
        listener(rows({}))
        return () => {}
      },
    }
    stop = startPresence(project.id, "tab_me", source, () => ({ name: "Me" }), "user_me")
    await vi.advanceTimersByTimeAsync(2000)
    expect(sent.at(-1)).not.toHaveProperty("copilot")

    act(() => useCopilot.setState({ runningProject: project.id, activity: "Routing" }))
    await vi.advanceTimersByTimeAsync(2000)
    expect(sent.at(-1)).toMatchObject({ copilot: true, copilotLabel: "Routing" })

    act(() => useCopilot.setState({ activity: "Thinking" }))
    await vi.advanceTimersByTimeAsync(2000)
    expect(sent.at(-1)).toMatchObject({ copilot: true, copilotLabel: "Thinking" })

    act(() => useCopilot.setState({ runningProject: null, activity: null }))
    await vi.advanceTimersByTimeAsync(2000)
    expect(sent.at(-1)).not.toHaveProperty("copilot")
    expect(sent.at(-1)).not.toHaveProperty("copilotLabel")
  })

  it("keeps a label from a tab short, and never without Sakura running", () => {
    const project = createProject("together")
    useProjectStore.getState().open(project)
    let push: (r: PresencePeer[]) => void = () => {}
    stop = startPresence(project.id, "tab_me", { update: async () => true, leave: () => {}, watch: (_p, l) => ((push = l), () => {}) }, () => ({ name: "Me" }), "user_me")
    act(() => push(rows({ copilot: true, copilotLabel: "x".repeat(500) })))
    expect(usePresence.getState().peers[0].state.copilotLabel).toHaveLength(30)
    act(() => push(rows({ copilotLabel: "Routing" }, Date.now() + 1)))
    expect(usePresence.getState().peers[0].state.copilotLabel).toBeUndefined()
  })
})
