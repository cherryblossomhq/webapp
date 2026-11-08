import { describe, expect, it } from "vitest"
import { blockFrames } from "../src/model/blocks"
import { computeConnectivity, pinKey } from "../src/model/connectivity"
import { isPhysical } from "../src/model/instances"
import { findPart } from "../src/model/library"
import { AUTO_NET_NAME } from "../src/model/merges"
import type { Project } from "../src/model/types"
import { buildDesign, group, netlist, netlistDiff, Session } from "./sakura-session"

// Sakura named nearly every net, so Tidy drew labels everywhere, even between an LED
// and its resistor. The design guide now has it wire a block's own paths (connect, two pins at a
// time, no name) and name only the nets that travel. The recorded session, connected that way and
// tidied whole, must draw those paths as wire and still label the nets that leave their blocks.

/** The recorded design, its paths connected without names, grouped and tidied whole. */
function tidied() {
  const s = new Session()
  buildDesign(s, { paths: true })
  group(s)
  const before = s.project
  s.must("tidy_schematic", { whole_sheet: true })
  return { before, after: s.project }
}

/** "U1.EN" or "R1.1" as "componentId:pin". */
const pinOf = (p: Project, pin: string) => {
  const [ref, name] = pin.split(".")
  const c = p.components.find((x) => x.ref === ref)!
  return pinKey(c.id, findPart(c.partId)!.pins.find((x) => x.number === name || x.name === name)!.number)
}
/** Whether these pins are joined by wire alone: no label, no port between. */
const wired = (p: Project, pins: string[]) => {
  const bare = computeConnectivity({ ...p, labels: [], components: p.components.filter((c) => isPhysical(findPart(c.partId))) })
  return new Set(pins.map((pin) => bare.pinNet.get(pinOf(p, pin)))).size === 1
}
const labelsOn = (p: Project, pin: string) => {
  const conn = computeConnectivity(p)
  const net = conn.pinNet.get(pinOf(p, pin))
  return p.labels.filter((l) => conn.labelNet.get(l.id) === net)
}

describe("the recorded Sakura design, connected as the design guide says", () => {
  it("draws each block's own paths as wire, with no label on them", () => {
    const { after } = tidied()
    for (const pins of [
      ["J1.CC1", "R1.1"],
      ["J1.CC2", "R2.1"],
      ["U1.EN", "R3.2", "C5.1", "SW1.1"],
      ["U1.IO9", "R4.2", "SW2.1"],
      ["R7.2", "D1.A"],
    ]) {
      expect(wired(after, pins), pins.join(" ")).toBe(true)
      expect(labelsOn(after, pins[0]), pins[0]).toEqual([])
    }
  })

  it("still labels the nets that leave their blocks, in each block they reach", () => {
    const { after } = tidied()
    const frames = blockFrames(after)
    const blockOf = (ref: string) => frames.find((f) => after.blocks!.find((b) => b.id === f.id)!.components.includes(after.components.find((c) => c.ref === ref)!.id))!
    for (const [net, refs] of [
      ["USB_DP", ["J1", "U1"]],
      ["USB_DM", ["J1", "U1"]],
      ["SDA", ["U1", "U2"]],
      ["SCL", ["U1", "U2"]],
      ["LED_IO", ["U1", "R7"]],
    ] as const) {
      for (const ref of refs) {
        const box = blockOf(ref).box
        const inside = after.labels.filter((l) => l.name === net && l.x >= box.minX && l.x <= box.maxX && l.y >= box.minY && l.y <= box.maxY)
        expect(inside.length, `${net} in ${blockOf(ref).name}`).toBeGreaterThan(0)
      }
    }
  })

  it("keeps the netlist: the paths' pins together, every named net under its name", () => {
    const { before, after } = tidied()
    const was = netlist(before)
    const now = netlist(after)
    // Pins on a net someone named keep its name; the paths are on nets nobody named, before and after.
    const names = new Set(computeConnectivity(before).nets.filter((n) => n.named && !AUTO_NET_NAME.test(n.name)).map((n) => n.name))
    const named = new Map([...was].filter(([, n]) => n && names.has(n)))
    expect(netlistDiff(named, new Map([...now].filter(([k]) => named.has(k))))).toEqual([])
    const groups = (m: Map<string, string | null>) => {
      const byNet = new Map<string, string[]>()
      for (const [pin, net] of m) if (net) byNet.set(net, [...(byNet.get(net) ?? []), pin])
      return [...byNet.values()].map((g) => g.sort().join(" ")).sort()
    }
    expect(groups(now)).toEqual(groups(was))
  })
})
