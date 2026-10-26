import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { PartSearchResponse, SupplierPart } from "@cherryblossom/api-contract"
import type { SupplierPartsSource } from "../../../src/ai/supplierParts"

// The hosted parts API's answers for the production parts and the traps, as its live smoke test
// recorded them, so these tests run with no network and no supplier.

interface Recorded {
  searches: Record<string, PartSearchResponse>
  parts: Record<string, SupplierPart | null>
}

export const RECORDED: Recorded = JSON.parse(readFileSync(join(__dirname, "recorded.json"), "utf8"))

/** A supplier source that answers from the recording and fails on anything it doesn't have. */
export function recordedSource(opts: { delayMs?: number } = {}): SupplierPartsSource & { calls: string[] } {
  const calls: string[] = []
  const wait = () => (opts.delayMs ? new Promise((r) => setTimeout(r, opts.delayMs)) : Promise.resolve())
  return {
    calls,
    async search(query) {
      calls.push(`search:${query}`)
      await wait()
      const hit = RECORDED.searches[query.trim().toUpperCase()]
      if (!hit) throw new Error(`No recorded search for "${query}".`)
      return structuredClone(hit)
    },
    async part(lcsc) {
      calls.push(`part:${lcsc}`)
      await wait()
      const id = lcsc.trim().toUpperCase()
      if (!(id in RECORDED.parts)) throw new Error(`No recorded part ${id}.`)
      return structuredClone(RECORDED.parts[id])
    },
  }
}

export const recordedPart = (lcsc: string): SupplierPart => {
  const part = RECORDED.parts[lcsc]
  if (!part) throw new Error(`No recorded part ${lcsc}`)
  return structuredClone(part)
}
