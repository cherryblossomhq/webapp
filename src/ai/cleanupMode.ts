import type { MeResponse } from "@cherryblossom/api-contract"
import { copilotAccess, type AccountStatus } from "../store/accountStore"

/**
 * Which Clean up the toolbar offers. The editor holds no plan logic: it asks what `GET /api/v1/me`
 * says the plan can do (`copilotAccess`), the same question the Sakura panel asks.
 *
 * - `ai`: the plan has managed AI, so Sakura cleans up by function.
 * - `free`: everything else. `proHint` is true where Pro would change that, signed out or on the
 *   Free plan; false while the plan is still loading, when it couldn't be loaded, and for an
 *   account whose plan has no AI for a reason buying Pro doesn't fix.
 */
export type CleanupMode = { kind: "ai" } | { kind: "free"; proHint: boolean }

export function cleanupMode(status: AccountStatus, account: MeResponse | null): CleanupMode {
  if (account) {
    const access = copilotAccess(account)
    if (access === "ready") return { kind: "ai" }
    return { kind: "free", proHint: access === "upgrade" }
  }
  return { kind: "free", proHint: status === "signedOut" }
}
