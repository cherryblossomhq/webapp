import { describe, expect, it } from "vitest"
import { EXAMPLES } from "../src/model/examples"
import { FROZEN_EXAMPLES } from "./frozen-examples"
import { broken } from "./net-rules"
import { dragSelection, rotateSelection } from "../src/model/schematicEdit"

// R on every part of every example, and every part dragged a grid step each way: a part is not
// stuck. A quarter turn that is blocked goes to the next position that is not (with a note), so
// fewer than 5% of parts refuse an R press, and no net is broken (net-rules.ts). The rates are held
// on the examples as drawn before Tidy (frozen-examples.ts); the shipped ones, however they are
// drawn, to every rule but the rate.

describe.each(EXAMPLES.map((e) => [e.id, e.project] as const))("shipped %s", (_id, project) => {
  it("turns and drags every part with every pin on its net, or refuses it in one clean sentence", () => {
    for (const c of project.components) {
      const res = rotateSelection(project, { components: [c.id], labels: [] })
      if (res.ok) expect(broken(project, res.project), c.ref).toEqual([])
      for (const text of res.ok ? (res.note ? [res.note] : []) : [res.message]) noticeIsClean(text, c.ref)
      for (const d of [{ x: 1, y: 0 }, { x: 0, y: -1 }, { x: 0.1, y: 0 }]) {
        const dragged = dragSelection(project, { components: [c.id], labels: [], wires: [] }, d)
        if (dragged.ok) expect(broken(project, dragged.project, !!dragged.inline), `${c.ref} by ${JSON.stringify(d)}`).toEqual([])
        else noticeIsClean(dragged.message, `${c.ref} by ${JSON.stringify(d)}`)
      }
    }
  })
})

describe.each(FROZEN_EXAMPLES.map((e) => [e.id, e.project] as const))("%s", (_id, project) => {
  it("turns every part, with every pin on its net, and refuses fewer than 5%", () => {
    let refused = 0
    for (const c of project.components) {
      const res = rotateSelection(project, { components: [c.id], labels: [] })
      if (!res.ok) {
        refused++
        expect(res.message).toMatch(/^Didn't turn /)
        continue
      }
      expect(broken(project, res.project), c.ref).toEqual([])
    }
    expect(refused / project.components.length).toBeLessThan(0.05)
  })

  it("drags every part a step each way: nothing changes a net, and under 10% are refused", () => {
    let total = 0
    let refused = 0
    for (const c of project.components) {
      for (const d of [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }]) {
        total++
        const res = dragSelection(project, { components: [c.id], labels: [], wires: [] }, d)
        if (!res.ok) refused++
        else expect(broken(project, res.project, !!res.inline), c.ref).toEqual([])
      }
    }
    expect(refused / total).toBeLessThan(0.1)
  })

  it("says why in one clean sentence whenever a part goes further than a quarter turn or a drag is refused", () => {
    for (const c of project.components) {
      const res = rotateSelection(project, { components: [c.id], labels: [] })
      for (const text of res.ok ? (res.note ? [res.note] : []) : [res.message]) noticeIsClean(text, c.ref)
      for (const d of [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 3, y: 2 }, { x: -6, y: 4 }]) {
        const dragged = dragSelection(project, { components: [c.id], labels: [], wires: [] }, d)
        if (!dragged.ok) noticeIsClean(dragged.message, `${c.ref} by ${JSON.stringify(d)}`)
      }
    }
  })
})

/** What a notice on the canvas must not look like: a stray full stop, a doubled word, a dash, a cut-off list. */
export function noticeIsClean(text: string, label = "") {
  expect(text, label).not.toMatch(/\.\./)
  expect(text, label).not.toMatch(/[\u2013\u2014]/)
  expect(text, label).not.toMatch(/\b(\w+) \1\b/i)
  if (!text.startsWith("Didn't")) expect(text, label).not.toMatch(/\bwould\b.*\bwould\b/)
  expect(text, label).not.toMatch(/\s{2,}|\s[.,;]/)
  // Pins that share a name are told apart, so no pin is named twice in one notice ("U4.VCC and U4.VCC").
  const pins: string[] = text.match(/\b[A-Z#]+\d*\.[A-Za-z0-9+\-/']+(?: \(pin \d+\))?/g) ?? []
  expect(pins.filter((p, i) => pins.indexOf(p) !== i), `${label}: a pin named twice in "${text}"`).toEqual([])
  // A cut says what the pins are cut off: never the same pins on both sides.
  const cut = text.match(/cut (.+?) off (.+?)(?:;|\. |\.$| and [A-Za-z#]+\d*\.)/)
  if (cut) expect(cut[1], label).not.toBe(cut[2])
  expect(text.endsWith("."), label).toBe(true)
  // One sentence: a full stop only at the end, or after "Nothing was changed" in a refusal.
  const stops = text.replace(/\b[A-Z]\d+\.\w+/g, "x").replace(/\d\.\d/g, "x").match(/\. /g) ?? []
  expect(stops.length, label).toBeLessThanOrEqual(text.startsWith("Didn't") ? 2 : 0)
}
