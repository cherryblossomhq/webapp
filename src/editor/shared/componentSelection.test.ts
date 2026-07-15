import { describe, expect, it } from "vitest";
import {
  componentNamesForKeys,
  selectionIncludesComponent,
  selectionIsSingleComponent,
} from "./componentSelection";

const TSX = `circuit.add(
  <board width="10mm" height="10mm">
    <resistor key="r_abc123" name="R1" resistance="1k" footprint="0402" />
    <resistor key="r_xyz789" name="R2" resistance="1k" footprint="0402" />
  </board>
)`;

describe("componentNamesForKeys", () => {
  it("maps component stable keys to designators", () => {
    expect(
      componentNamesForKeys(TSX, new Set(["r_abc123", "r_xyz789"]))
    ).toEqual(["R1", "R2"]);
  });

  it("ignores trace / connection keys", () => {
    expect(
      componentNamesForKeys(TSX, new Set(["conn_deadbe", "r_abc123"]))
    ).toEqual(["R1"]);
  });
});

describe("selectionIncludesComponent", () => {
  it("returns false for trace-only selection", () => {
    expect(
      selectionIncludesComponent(TSX, new Set(["conn_deadbe"]))
    ).toBe(false);
  });

  it("returns true when a component is selected", () => {
    expect(
      selectionIncludesComponent(TSX, new Set(["r_abc123"]))
    ).toBe(true);
  });
});

describe("selectionIsSingleComponent", () => {
  it("returns false for multi-component selection", () => {
    expect(
      selectionIsSingleComponent(TSX, new Set(["r_abc123", "r_xyz789"]))
    ).toBe(false);
  });

  it("returns true for exactly one component", () => {
    expect(
      selectionIsSingleComponent(TSX, new Set(["r_abc123"]))
    ).toBe(true);
  });

  it("returns true when one component plus a trace key is selected", () => {
    expect(
      selectionIsSingleComponent(TSX, new Set(["r_abc123", "conn_deadbe"]))
    ).toBe(true);
  });
});
