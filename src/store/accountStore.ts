import type { MeResponse, RateLimitWindow } from "@cherryblossom/api-contract"
import { create } from "zustand"
import { fetchAccount, ManagedAiError } from "../ai/managedAi"

// What the copilot knows of the user's plan: `GET /api/v1/me`, fetched when the copilot is
// first shown and again after a refusal. Informational only; the proxy re-checks every call.

export type AccountStatus = "idle" | "loading" | "ready" | "signedOut" | "error"

interface AccountState {
  status: AccountStatus
  account: MeResponse | null
  error: string | null
  /** The account, fetched once and shared; `force` fetches again. Null when signed out or unreachable. */
  load: (force?: boolean) => Promise<MeResponse | null>
}

let inflight: Promise<MeResponse | null> | null = null

export const useAccount = create<AccountState>((set, get) => ({
  status: "idle",
  account: null,
  error: null,
  load: (force = false) => {
    const { status, account } = get()
    if (!force && status === "ready") return Promise.resolve(account)
    if (inflight) return inflight
    set({ status: "loading", error: null })
    inflight = fetchAccount()
      .then((me) => {
        set({ status: "ready", account: me, error: null })
        return me
      })
      .catch((err: unknown) => {
        if (err instanceof ManagedAiError && err.kind === "signin") set({ status: "signedOut", account: null, error: null })
        else set({ status: "error", error: err instanceof Error ? err.message : String(err) })
        return null
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  },
}))

/** Whether the plan can use the copilot at all, and if not, which way forward to offer. */
export type CopilotAccess = "ready" | "upgrade" | "unavailable"

export function copilotAccess(account: MeResponse): CopilotAccess {
  if (account.plan.managedAi && account.plan.allowedModels.length) return "ready"
  // Only a plan without a subscription is solved by buying one; an organization's is not.
  return account.plan.tier === "free" ? "upgrade" : "unavailable"
}

/** The model to call: the user's pick while the plan still allows it, else the plan's strongest (listed last). */
export function copilotModel(account: MeResponse, preferred: string | null): string | null {
  const models = account.plan.allowedModels
  if (preferred && models.includes(preferred)) return preferred
  return models[models.length - 1] ?? null
}

/** The ways forward offered to a user refused on a plan limit. */
export interface LimitOffer {
  /** Ultra, for a Pro user: a larger allowance. */
  upgrade: boolean
  /** Buy credits, on the host's account page, to keep working past the allowance. */
  buyCredits: boolean
}

/**
 * What a refusal on `limit` can offer this account, or null when nothing it can buy helps. The
 * minute burst is the same on every plan and credits never buy past it; the day and month
 * allowances are what Ultra raises and credits go past. `credits` on `/api/v1/me` says whether
 * this account can buy them, and whether auto-refill is already adding some, in which case the
 * refusal says to try again in a moment and offering to buy more would be noise. A balance left
 * means credits were bought since the refusal: trying again is the way past it.
 */
export function limitOffer(account: MeResponse | null, limit: RateLimitWindow | undefined): LimitOffer | null {
  if (!account || !limit || limit === "minute") return null
  const { available, balance, refilling } = account.credits
  if (refilling || balance > 0) return null
  const upgrade = account.plan.tier === "pro"
  return upgrade || available ? { upgrade, buyCredits: available } : null
}
