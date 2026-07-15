import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import type { AnyCircuitElement } from "circuit-json";

// No mocks here: this exercises the real circuit-json-to-kicad converters end to
// end to prove buildKicadProjectZip produces an openable project zip (the unit
// suite in kicadExport.test.ts mocks the converters to assert wiring only).
import { buildKicadProjectZip } from "./kicadExport";

const CIRCUIT: AnyCircuitElement[] = [
  {
    type: "source_component",
    source_component_id: "sc1",
    name: "R1",
    ftype: "simple_resistor",
    resistance: 1000,
  } as unknown as AnyCircuitElement,
];

describe("buildKicadProjectZip (real converters)", () => {
  it("produces a non-empty zip containing the three KiCad files", async () => {
    const blob = await buildKicadProjectZip(CIRCUIT, "RealProj");
    expect(blob.size).toBeGreaterThan(0);

    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const names = Object.values(zip.files)
      .filter((f) => !f.dir)
      .map((f) => f.name)
      .sort();
    expect(names).toEqual([
      "RealProj/RealProj.kicad_pcb",
      "RealProj/RealProj.kicad_pro",
      "RealProj/RealProj.kicad_sch",
    ]);

    // Each converter should emit non-empty text content.
    for (const name of names) {
      const content = await zip.file(name)!.async("string");
      expect(content.length).toBeGreaterThan(0);
    }
  });
});
