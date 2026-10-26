import { describe, expect, it } from "vitest"
import { firstDrawn, netlist, Session } from "./sakura-session"

// Problem 7 of the owner's Sakura session. Needs sakura-session.ts and sakura-session-parts.json
// beside it.
//
// 7. get_design counted power and ground ports as components (ai/tools.ts), so the same 19 parts
//    read as 24, 45 or 47 components as ports were drawn on the sheet. A port draws a net; it is
//    not a part of the board, so get_design counts the parts and lists the ports apart.
//    "Connected D1.K on GND" is fine: one pin with net_name labels it onto GND (D1.2 is on GND).
//
// (The other half of that file, the PCB look counting nets not routed yet as placement problems,
// belongs to the vision tool and is not on main.)

interface Read {
  components: { ref: string }[]
  power_symbols: { ref: string; net?: string }[]
}

const read = (s: Session) => {
  const out = s.must("get_design")
  return { summary: out.summary, design: JSON.parse(out.result) as Read }
}

/** Pins already on the 3V3 net, so a 3V3 port on one of them joins nothing new. */
const RAIL_PINS = ["R3.1", "R4.1", "R5.1", "R6.1", "C2.1", "C3.1", "C4.1"]

/** The 19-part sheet with ports drawn on it, as Tidy did: GND on every capacitor and 3V3 on the pull-ups. */
function withPorts(n: { gnd: number; rail: number }): Session {
  const s = firstDrawn()
  for (let i = 0; i < n.gnd; i++) {
    s.must("add_component", { part_id: "ground", x: -10 + i * 3, y: -16 })
    s.must("connect", { pins: [`#GND${i + 1}`, `C${(i % 5) + 1}.2`] })
  }
  for (let i = 0; i < n.rail; i++) {
    s.must("add_component", { part_id: "power", props: { net: "3V3" }, x: -10 + i * 3, y: -20 })
    s.must("connect", { pins: [`#PWR${i + 1}`, RAIL_PINS[i % RAIL_PINS.length]] })
  }
  return s
}

describe("get_design's count", () => {
  it("counts the 19 parts of a sheet with no ports", () => {
    const { summary, design } = read(firstDrawn())
    expect(summary).toMatch(/^Read the design \(19 components, /)
    expect(design.components).toHaveLength(19)
    expect(design.power_symbols).toEqual([])
  })

  it.each([
    [5, 0],
    [12, 14],
    [26, 2],
  ])("counts the 19 parts, not the %i ground and %i power ports drawn on the sheet", (gnd, rail) => {
    const s = withPorts({ gnd, rail })
    expect(s.project.components).toHaveLength(19 + gnd + rail)
    const { summary, design } = read(s)
    expect(summary).toMatch(/^Read the design \(19 components, /)
    expect(design.components).toHaveLength(19)
    expect(design.components.map((c) => c.ref).some((r) => r.startsWith("#"))).toBe(false)
    expect(design.power_symbols).toHaveLength(gnd + rail)
  })

  it("lists each port with the net it draws", () => {
    const { design } = read(withPorts({ gnd: 1, rail: 1 }))
    expect(design.power_symbols).toMatchObject([{ ref: "#GND1", net: "GND" }, { ref: "#PWR1", net: "3V3" }])
  })

  it("D1.K alone on GND is connected (passes)", () => {
    expect(netlist(firstDrawn().project).get("D1.2")).toBe("GND")
  })
})
