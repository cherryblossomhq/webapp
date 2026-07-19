import { describe, expect, it } from "vitest";
import { buildDynamicContext, buildSystemPrompt } from "./chatSystemPrompt";

describe("chat system prompt contracts", () => {
  it("describes the canonical module format and tool-only edit contract", () => {
    const prompt = buildSystemPrompt();

    expect(prompt).toContain("export default () => (<board>");
    expect(prompt).toContain("only the `edit_tsx` and `write_tsx` tools change");
    expect(prompt).toContain("do NOT emit `schX` / `schY` / `schRotation`");
  });

  it("keeps PCB move/rotate guidance consistent between static and dynamic context", () => {
    const prompt = buildSystemPrompt();
    const context = buildDynamicContext(
      "export default () => (<board />)",
      0,
      "50mm",
      "50mm",
      undefined,
      "pcb"
    );

    expect(prompt).toContain(
      '**Layout** ("move R5 to the corner", "rotate U1 90°"'
    );
    expect(prompt).toContain("→ `edit_tsx`");
    expect(context).toContain(
      "Move, rotate, resize-board, component-add, and wiring requests use edit_tsx"
    );
    expect(context).toContain(
      "Copper-layer and routing requests must be answered in prose"
    );
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
      view
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
      "Keep the board compact."
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
