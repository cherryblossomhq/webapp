import { computeConnectivity, pinKey } from "../src/model/connectivity"
import { isPhysical, schematicPins } from "../src/model/instances"
import { findPart } from "../src/model/library"
import type { Project } from "../src/model/types"

// The rules a canvas edit (turn, drag, paste, drop) has to keep, written out on their own so a test
// can hold an edit to them without asking the code that enforces them. For every pin that was on
// the sheet: it is still on the nets it was on (nothing cut loose, except by a wire cut on purpose
// to put a part in line), no two nets that each had a name or held 2+ pins were joined, and a named
// net kept its name. A pin on nothing or a loose wire meeting a net, or a net with one pin and no
// name taking a name, is drawing and is not in the list.

/** What the rules above say about the pins that were on the sheet, `before` against `after`. */
export function broken(before: Project, after: Project, inline = false): string[] {
  const alive = new Set(after.components.map((c) => c.id))
  const keys: string[] = []
  for (const c of before.components) {
    if (!alive.has(c.id) || !isPhysical(findPart(c.partId))) continue
    for (const p of schematicPins(c)) keys.push(pinKey(c.id, p.pin))
  }
  const b = computeConnectivity(before)
  const a = computeConnectivity(after)
  const netB = new Map(b.nets.map((n) => [n.id, n]))
  const netA = new Map(a.nets.map((n) => [n.id, n]))
  const idB = (k: string) => b.pinNet.get(k) ?? `solo:${k}`
  const idA = (k: string) => a.pinNet.get(k) ?? `solo:${k}`
  const out: string[] = []
  // A part wired in line cuts the wire it sits on: that net is split, and one side keeps its name.
  const spliced = inline

  // Joined: the nets of `after` made of several nets of `before`.
  const joined = new Map<string, Set<string>>()
  const cutBy = new Map<string, Set<string>>()
  for (const k of keys) {
    joined.set(idA(k), (joined.get(idA(k)) ?? new Set()).add(idB(k)))
    cutBy.set(idB(k), (cutBy.get(idB(k)) ?? new Set()).add(idA(k)))
    const was = netB.get(idB(k))
    if (!spliced && was?.named && netA.get(idA(k))?.name !== was.name) out.push(`${k}: ${was.name} became ${netA.get(idA(k))?.name ?? "nothing"}`)
  }
  for (const [now, from] of joined) {
    const standing = [...from].filter((g) => netB.get(g)?.named || (netB.get(g)?.pins.length ?? 0) >= 2).length
    if (standing >= 2) out.push(`${now} joined ${[...from].join(" + ")}`)
  }
  if (!spliced) for (const [was, now] of cutBy) if (now.size > 1) out.push(`${was} cut into ${[...now].join(" + ")}`)
  return out
}
