import { afterEach, describe, expect, it, vi } from "vitest"
import { PROJECT_FILE_VERSION } from "../src/model/projectFile"
import { keepEdits, takeKeptEdits } from "../src/store/keptEdits"

/** Edits kept in the tab for its next page (`keptEdits.ts`); `sync.test.ts` follows them through a reload. */

const batch = { clientId: "s_old", batch: 1, changes: [] }

function tab(full = false) {
  const items = new Map<string, string>()
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (full) throw new DOMException("full", "QuotaExceededError")
      items.set(key, value)
    },
    removeItem: (key: string) => void items.delete(key),
  })
  return items
}

describe("edits kept in the tab", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("hands a project's kept batches to the next page once", () => {
    tab()
    expect(keepEdits(new Map([["p1", [batch]]]))).toBe(true)
    expect(takeKeptEdits("p2")).toEqual([])
    expect(takeKeptEdits("p1")).toEqual([batch])
    expect(takeKeptEdits("p1")).toEqual([])
  })

  it("drops batches an editor of another file format kept, whose changes could mean something else here", () => {
    const items = tab()
    items.set("cherryblossom:unsent:p1", JSON.stringify({ formatVersion: PROJECT_FILE_VERSION - 1, batches: [batch] }))
    expect(takeKeptEdits("p1")).toEqual([])
    expect(items.size).toBe(0)
  })

  it("says when the tab has no room for them, so leaving still asks first", () => {
    tab(true)
    expect(keepEdits(new Map([["p1", [batch]]]))).toBe(false)
    expect(keepEdits(new Map())).toBe(true)
  })
})
