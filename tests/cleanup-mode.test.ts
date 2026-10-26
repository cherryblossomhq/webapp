import type { MeResponse } from "@cherryblossom/api-contract"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanupMode } from "../src/ai/cleanupMode"
import { connectManagedAi } from "../src/ai/managedAi"
import { useAccount } from "../src/store/accountStore"

// Which Clean up the toolbar offers comes only from what GET /api/v1/me says, read the way the Sakura
// panel reads it: a plan with managed AI gets "Clean up with AI", every other plan, signed-out and
// unreachable state the free one. /me is stubbed here, so nothing leaves the test.

const me = (plan: Partial<MeResponse["plan"]>): MeResponse => ({
  user: { id: "user_1", email: "a@b.c", name: "A" },
  plan: { tier: "pro", name: "Pro", managedAi: true, allowedModels: ["vendor/large"], ...plan },
  limits: { maxTokensPerRequest: 64000, requestsPerMinute: 60, requestsPerDay: 600, monthlyTokens: 4_000_000 },
  usage: { requestsThisMinute: 0, minuteResetsAt: null, requestsThisDay: 0, dayResetsAt: null, monthlyTokens: 0, monthResetsAt: null },
  onDemand: { available: true, enabled: false, capCents: 0, creditsThisPeriod: 0, spentCents: 0 },
})

let reply: () => Response
let asked: string[] = []

/** The mode the toolbar would show once the account has been asked for, as the toolbar asks. */
async function modeNow() {
  await useAccount.getState().load(true)
  const { status, account } = useAccount.getState()
  return cleanupMode(status, account)
}

beforeEach(() => {
  asked = []
  useAccount.setState({ status: "idle", account: null, error: null })
  connectManagedAi({ getAccessToken: async () => "token-1" })
  vi.stubGlobal("fetch", async (url: string) => {
    asked.push(String(url))
    return reply()
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  connectManagedAi(null)
})

describe("which Clean up the toolbar offers", () => {
  it("offers the AI version on Pro", async () => {
    reply = () => Response.json(me({ tier: "pro", managedAi: true, allowedModels: ["vendor/large"] }))
    expect(await modeNow()).toEqual({ kind: "ai" })
    expect(asked).toEqual(["/api/v1/me"])
  })

  it("offers it on every plan above Pro too", async () => {
    reply = () => Response.json(me({ tier: "ultra", managedAi: true, allowedModels: ["vendor/small", "vendor/large"] }))
    expect(await modeNow()).toEqual({ kind: "ai" })
  })

  it("offers the free version, and the Pro hint, on the Free plan", async () => {
    reply = () => Response.json(me({ tier: "free", name: "Free", managedAi: false, allowedModels: [] }))
    expect(await modeNow()).toEqual({ kind: "free", proHint: true })
  })

  it("offers the free version, and the Pro hint, when signed out", async () => {
    reply = () => Response.json({ error: { type: "not_authenticated", message: "Sign in." } }, { status: 401 })
    expect(await modeNow()).toEqual({ kind: "free", proHint: true })
    expect(useAccount.getState().status).toBe("signedOut")
  })

  it("offers the free version, and the Pro hint, with no host session at all", async () => {
    connectManagedAi(null)
    expect(await modeNow()).toEqual({ kind: "free", proHint: true })
    expect(asked).toEqual([])
  })

  it("offers the free version without a hint while the plan is unknown or can't be had", async () => {
    // Not loaded yet.
    expect(cleanupMode("idle", null)).toEqual({ kind: "free", proHint: false })
    expect(cleanupMode("loading", null)).toEqual({ kind: "free", proHint: false })
    // The request failed.
    reply = () => Response.json({ error: { type: "upstream_error", message: "down" } }, { status: 502 })
    expect(await modeNow()).toEqual({ kind: "free", proHint: false })
  })

  it("offers the free version without a hint where buying Pro isn't the fix (a plan with the AI switched off)", async () => {
    reply = () => Response.json(me({ tier: "enterprise", name: "Enterprise", managedAi: false, allowedModels: [] }))
    expect(await modeNow()).toEqual({ kind: "free", proHint: false })
  })

  it("follows the plan when it changes: bought Pro, then signed out", async () => {
    reply = () => Response.json(me({ tier: "free", name: "Free", managedAi: false, allowedModels: [] }))
    expect((await modeNow()).kind).toBe("free")
    reply = () => Response.json(me({}))
    expect((await modeNow()).kind).toBe("ai")
    reply = () => Response.json({ error: { type: "not_authenticated", message: "Sign in." } }, { status: 401 })
    expect((await modeNow()).kind).toBe("free")
  })
})
