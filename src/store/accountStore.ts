import type { MeResponse } from "@cherryblossom/api-contract"
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
