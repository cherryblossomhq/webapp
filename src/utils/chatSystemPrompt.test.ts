import { describe, expect, it } from "vitest";
import { buildDynamicContext } from "./chatSystemPrompt";

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
      ]
    );

    expect(context).toContain("## Circuit Manifest");
    expect(context).toContain("- net.VCC [power]: R1.pin1");
    expect(context).toContain("[error] connectivity_error: U1.VCC is missing");
    expect(context).toContain("Evidence: vin_max=5.5 V (p. 3, high)");
    expect(context).toContain("Source: https://example.com/u1.pdf");
    expect(context).toContain("## Current Circuit TSX");
  });
});
