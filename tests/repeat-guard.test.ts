import { describe, expect, it } from "vitest"
import { createRepeatGuard, REPEAT_LIMIT } from "../src/ai/repeatGuard"

describe("the repeat guard", () => {
  it("lets an identical failing call fail twice and refuses the third, with a plain message", () => {
    const guard = createRepeatGuard()
    const input = { name: "TPS61023", category: "Power", pins: [{ number: "1", name: "A" }] }
    expect(guard.refusal("create_part", input)).toBeNull()
    guard.record("create_part", input, true)
    expect(guard.refusal("create_part", input)).toBeNull()
    guard.record("create_part", input, true)
    expect(REPEAT_LIMIT).toBe(2)
    expect(guard.refusal("create_part", input)).toBe(
      "create_part has already failed 2 times with exactly this input, so it was not run again. Change what you pass (a different lcsc, name, section, page, pins or footprint), use another tool, or tell the user what is blocking it.",
    )
  })

  it("treats the same input in another key order as the same call, and a changed input as a new one", () => {
    const guard = createRepeatGuard()
    guard.record("create_part", { name: "A", category: "ICs" }, true)
    guard.record("create_part", { category: "ICs", name: "A" }, true)
    expect(guard.refusal("create_part", { category: "ICs", name: "A" })).not.toBeNull()
    expect(guard.refusal("create_part", { category: "ICs", name: "B" })).toBeNull()
    expect(guard.refusal("find_part", { category: "ICs", name: "A" })).toBeNull()
  })

  it("forgets a call that then succeeds, and never counts a success", () => {
    const guard = createRepeatGuard()
    guard.record("find_part", { query: "X" }, true)
    guard.record("find_part", { query: "X" }, false)
    guard.record("find_part", { query: "X" }, true)
    expect(guard.refusal("find_part", { query: "X" })).toBeNull()
    for (let i = 0; i < 5; i++) guard.record("find_part", { query: "Y" }, false)
    expect(guard.refusal("find_part", { query: "Y" })).toBeNull()
  })
})
