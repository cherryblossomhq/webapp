import { describe, it, expect, vi, beforeEach } from "vitest";
import JSZip from "jszip";
import type { AnyCircuitElement } from "circuit-json";

// Records the constructor args + call order for each converter so we can assert
// kicadExport's wiring (filenames, options passthrough, runUntilFinished) without
// running the real — slow — converter pipeline.
const calls: Array<{ kind: string; circuitJson: unknown; options?: unknown }> = [];
const ran: string[] = [];

function makeConverter(kind: string, output: string) {
  return class {
    circuitJson: unknown;
    options?: unknown;
    constructor(circuitJson: unknown, options?: unknown) {
      this.circuitJson = circuitJson;
      this.options = options;
      calls.push({ kind, circuitJson, options });
    }
    runUntilFinished() {
      ran.push(kind);
    }
    getOutputString() {
      return output;
    }
  };
}

vi.mock("circuit-json-to-kicad", () => ({
  CircuitJsonToKicadSchConverter: makeConverter("sch", "SCH_OUTPUT"),
  CircuitJsonToKicadPcbConverter: makeConverter("pcb", "PCB_OUTPUT"),
  CircuitJsonToKicadProConverter: makeConverter("pro", "PRO_OUTPUT"),
}));

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

async function entries(blob: Blob): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const out: Record<string, string> = {};
  await Promise.all(
    Object.values(zip.files)
      .filter((f) => !f.dir)
      .map(async (f) => {
        out[f.name] = await f.async("string");
      })
  );
  return out;
}

describe("buildKicadProjectZip (wiring)", () => {
  beforeEach(() => {
    calls.length = 0;
    ran.length = 0;
  });

  it("returns an application/zip Blob", async () => {
    const blob = await buildKicadProjectZip(CIRCUIT, "MyProj");
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("application/zip");
    expect(blob.size).toBeGreaterThan(0);
  });

  it("nests the three KiCad files under a <projectName>/ folder with shared base name", async () => {
    const blob = await buildKicadProjectZip(CIRCUIT, "MyProj");
    const files = await entries(blob);
    expect(Object.keys(files).sort()).toEqual([
      "MyProj/MyProj.kicad_pcb",
      "MyProj/MyProj.kicad_pro",
      "MyProj/MyProj.kicad_sch",
    ]);
  });

  it("writes each converter's output string to its matching file", async () => {
    const blob = await buildKicadProjectZip(CIRCUIT, "MyProj");
    const files = await entries(blob);
    expect(files["MyProj/MyProj.kicad_sch"]).toBe("SCH_OUTPUT");
    expect(files["MyProj/MyProj.kicad_pcb"]).toBe("PCB_OUTPUT");
    expect(files["MyProj/MyProj.kicad_pro"]).toBe("PRO_OUTPUT");
  });

  it("passes circuitJson to all three converters", async () => {
    await buildKicadProjectZip(CIRCUIT, "MyProj");
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.circuitJson).toBe(CIRCUIT);
    }
  });

  it("passes projectName to the PCB converter options", async () => {
    await buildKicadProjectZip(CIRCUIT, "MyProj");
    const pcb = calls.find((c) => c.kind === "pcb");
    expect(pcb?.options).toEqual({ projectName: "MyProj" });
  });

  it("passes projectName + sch/pcb filenames to the PRO converter options", async () => {
    await buildKicadProjectZip(CIRCUIT, "MyProj");
    const pro = calls.find((c) => c.kind === "pro");
    expect(pro?.options).toEqual({
      projectName: "MyProj",
      schematicFilename: "MyProj.kicad_sch",
      pcbFilename: "MyProj.kicad_pcb",
    });
  });

  it("runs runUntilFinished on every converter", async () => {
    await buildKicadProjectZip(CIRCUIT, "MyProj");
    expect(ran.sort()).toEqual(["pcb", "pro", "sch"]);
  });

  it("derives filenames from the given project name", async () => {
    const blob = await buildKicadProjectZip(CIRCUIT, "weird name 2");
    const files = await entries(blob);
    expect(Object.keys(files).sort()).toEqual([
      "weird name 2/weird name 2.kicad_pcb",
      "weird name 2/weird name 2.kicad_pro",
      "weird name 2/weird name 2.kicad_sch",
    ]);
  });
});
