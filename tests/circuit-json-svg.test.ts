import { convertCircuitJsonToPcbSvg, convertCircuitJsonToSchematicSvg } from "circuit-to-svg"
import { describe, expect, it } from "vitest"
import { projectToCircuitJson } from "../src/export/circuitJson"
import { EXAMPLES } from "../src/model/examples"

// tscircuit's own renderer reads the export: the proof that its tools accept what we write.
describe("the export in circuit-to-svg", () => {
  it.each(["blinker", "regulator", "mcu"])("draws the %s example's board and schematic", (id) => {
    const example = EXAMPLES.find((e) => e.id === id)!.project
    const { elements } = projectToCircuitJson(example)
    // Round-tripped through JSON, as a downloaded file would be.
    const circuit = JSON.parse(JSON.stringify(elements))

    const pcb = convertCircuitJsonToPcbSvg(circuit)
    expect(pcb).toMatch(/^<svg/)
    expect(pcb).toContain("pcb-board")
    for (const c of example.components.filter((x) => !x.ref.startsWith("#")).slice(0, 4)) expect(pcb, `${c.ref} on the board`).toContain(`>${c.ref}<`)

    const sch = convertCircuitJsonToSchematicSvg(circuit)
    expect(sch).toMatch(/^<svg/)
    for (const c of example.components.filter((x) => !x.ref.startsWith("#")).slice(0, 4)) expect(sch, `${c.ref} in the schematic`).toContain(`>${c.ref}<`)
    for (const label of example.labels.slice(0, 3)) expect(sch, `net label ${label.name}`).toContain(`>${label.name}<`)
  }, 120_000)
})
