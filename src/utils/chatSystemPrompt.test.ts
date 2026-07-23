import { describe, expect, it } from "vitest";
import { buildDynamicContext, buildSystemPrompt } from "./chatSystemPrompt";

describe("chat system prompt contracts", () => {
  it("describes the canonical module and circuit-mutating tool contract", () => {
    const prompt = buildSystemPrompt();

    expect(prompt).toContain("export default () => (<board>");
    expect(prompt).toContain("only circuit-mutating tools change the circuit");
    expect(prompt).toContain("do NOT emit `schX` / `schY` / `schRotation`");
    expect(prompt).toContain("finish_circuit_edit");
    expect(prompt).toContain("untrusted reference data");
  });

  it("keeps PCB layout guidance consistent between static and dynamic context", () => {
    const prompt = buildSystemPrompt();
    const context = buildDynamicContext(
      "export default () => (<board />)",
      0,
      "50mm",
      "50mm",
      undefined,
      "pcb",
    );

    expect(prompt).toContain('**Layout** ("move R5 to the corner", "rotate U1 90°"');
    expect(prompt).toContain("→ `update_component` / `set_board`");
    expect(context).toContain("Move and rotate requests use update_component");
    expect(context).toContain("board resize and copper-layer-count requests use set_board");
    expect(context).toContain("component-add and wiring requests use semantic circuit tools");
    expect(context).toContain("Component copper-side assignment and routing requests must be answered in prose");
  });

  it.each([
    ["schematic", "never set schematic positions"],
    ["cad", "read-only"],
    ["bom", "answer questions about parts"],
    ["code", "raw circuit TSX directly"],
  ] as const)("includes the %s view-specific instruction", (view, expected) => {
    const context = buildDynamicContext(
      "export default () => (<board />)",
      0,
      "50mm",
      "50mm",
      undefined,
      view,
    );

    expect(context).toContain(expected);
  });

  it("includes each optional dynamic context block when supplied", () => {
    const context = buildDynamicContext(
      "export default () => (<board />)",
      1,
      "60mm",
      "40mm",
      "- r_abc123: pcb(1.0, 2.0, top)",
      "pcb",
      { name: "R1", kind: "resistor" },
      [
        {
          componentName: "R1",
          elementTag: "resistor",
          kind: "unknown",
          actual: "mystery",
          message: "R1 is invalid",
        },
      ],
      [{ name: "U1", summary: "3.3 V regulator" }],
      "Keep the board compact.",
    );

    expect(context).toContain("Components: 1 | Board: 60mm × 40mm");
    expect(context).toContain("## Manual Edits Summary");
    expect(context).toContain("## Earlier This Session");
    expect(context).toContain("Selected: R1 (resistor)");
    expect(context).toContain("## Datasheet Summaries");
    expect(context).toContain("- U1: 3.3 V regulator");
    expect(context).toContain("## Footprint Issues");
    expect(context).toContain("R1 is invalid");
  });
});

describe("buildDynamicContext", () => {
  it("injects the circuit manifest and source-aware datasheet evidence", () => {
    const tsx = `export default () => (
      <board width="20mm" height="15mm">
        <resistor name="R1" resistance="10k" connections={{ pin1: "net.VCC" }} />
      </board>
    )`;
    const context = buildDynamicContext(
      tsx,
      1,
      "20mm",
      "15mm",
      undefined,
      "schematic",
      null,
      [],
      [
        {
          name: "U1",
          summary: "V_in 2.7 V-5.5 V",
          evidence: ["vin_max=5.5 V (p. 3, high)"],
          sourceUrl: "https://example.com/u1.pdf",
        },
      ],
      null,
      [
        {
          id: "missing-pin",
          type: "connectivity_error",
          message: "U1.VCC is missing",
          severity: "error",
        },
      ],
    );

    expect(context).toContain("## Circuit Manifest");
    expect(context).toContain("- net.VCC [power]: R1.pin1");
    expect(context).toContain("[error] connectivity_error: U1.VCC is missing");
    expect(context).toContain("Evidence: vin_max=5.5 V (p. 3, high)");
    expect(context).toContain("Source: https://example.com/u1.pdf");
    expect(context).toContain("## Current Circuit TSX");
  });
});
