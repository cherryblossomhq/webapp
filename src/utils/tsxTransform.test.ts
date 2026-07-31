import { describe, it, expect } from "vitest";
import {
  extractComponents,
  extractBoardConfig,
  extractComponentByName,
  updateComponentProp,
  updateComponentNumericProp,
  updateComponentPinLabels,
  removeComponentProp,
  setComponentLayerProp,
  renameComponent,
  addComponentElement,
  removeComponentElement,
  extractConnections,
  normalizeSelectorString,
  setComponentConnection,
  removeComponentConnection,
  mintNetName,
  promoteToNet,
  updateBoardDimensions,
  updateBoardLayers,
  validateTsx,
  extractComponentDefinitions,
  findUndefinedComponents,
  DEFAULT_TSX,
} from "./tsxTransform";

const SAMPLE_TSX = `export default () => (
  <board width="50mm" height="50mm" autorouter="sequential-trace">
    <resistor name="R1" resistance="10k" footprint="0402" />
    <capacitor name="C1" capacitance="100nF" footprint="0603" />
    <led name="LED1" color="red" />
  </board>
)
`;

describe("tsxTransform — extraction", () => {
  it("extracts components from a board", () => {
    const components = extractComponents(SAMPLE_TSX);
    expect(components).toHaveLength(3);
    const names = components.map((c) => c.name).sort();
    expect(names).toEqual(["C1", "LED1", "R1"]);
  });

  it("extracts component props as strings", () => {
    const [comp] = extractComponents(SAMPLE_TSX);
    const r1 = extractComponents(SAMPLE_TSX).find((c) => c.name === "R1")!;
    expect(r1.elementTag).toBe("resistor");
    expect(r1.props.resistance).toBe("10k");
    expect(r1.props.footprint).toBe("0402");
    expect(comp).toBeDefined();
  });

  it("extracts a placed <connector> with its key (live-drag regression)", () => {
    // A <connector> (USB-C, etc.) is a footprinted part the user can drag. If
    // it isn't recognized as a component, buildPcbModel never wires its stable
    // `key`, the optimistic drag override is ignored, and the part only moves
    // after the next eval — the "J1 lags, U1 doesn't" bug.
    const tsx = `export default () => (
      <board width="50mm" height="50mm">
        <connector key="j1_u3k9pq" name="J1" standard="usb_c"
          pcbX={9.6} pcbY={-8.7} />
      </board>
    )`;
    const j1 = extractComponents(tsx).find((c) => c.name === "J1");
    expect(j1).toBeDefined();
    expect(j1?.elementTag).toBe("connector");
    expect(j1?.props.key).toBe("j1_u3k9pq");
    // pcbX/pcbY must be visible so the model marks it placed (solid, pinned).
    expect(j1?.props.pcbX).toBe("9.6");
    expect(j1?.props.pcbY).toBe("-8.7");
  });

  it("recognizes the other placeable built-in lowercase parts", () => {
    const tsx = `export default () => (
      <board width="50mm" height="50mm">
        <crystal name="Y1" frequencyHz={16e6} />
        <pushbutton name="SW1" />
        <fuse name="F1" />
        <testpoint name="TP1" />
      </board>
    )`;
    const names = extractComponents(tsx)
      .map((c) => c.name)
      .sort();
    expect(names).toEqual(["F1", "SW1", "TP1", "Y1"]);
  });

  it("extracts a single component by name", () => {
    const c1 = extractComponentByName(SAMPLE_TSX, "C1");
    expect(c1).toBeDefined();
    expect(c1?.elementTag).toBe("capacitor");
    expect(c1?.props.capacitance).toBe("100nF");
  });

  it("returns undefined when component name not found", () => {
    expect(extractComponentByName(SAMPLE_TSX, "NOPE")).toBeNull();
  });

  it("extracts board config", () => {
    const board = extractBoardConfig(SAMPLE_TSX);
    expect(board).toEqual({ width: "50mm", height: "50mm", layers: 2 });
  });

  it("extracts connections (raw strings, sel.X.Y, nets, arrays)", () => {
    const tsx = `export default () => (
      <board width="50mm" height="50mm">
        <chip name="U1" pinLabels={{ pin1: "VCC", pin2: "SDA" }}
          connections={{ VCC: "net.V3_3", SDA: sel.U2.SDA }} />
        <resistor name="R1" connections={{ pin1: ".C1 > .pin1" }} />
        <capacitor name="C1" connections={{ pin2: ["net.GND", "C2.pin2"] }} />
      </board>
    )`;
    const conns = extractConnections(tsx);
    // U1: 2, R1: 1, C1: 2 (array fanout) = 5
    expect(conns).toHaveLength(5);

    const u1Vcc = conns.find((c) => c.owner === "U1" && c.pinLabel === "VCC")!;
    expect(u1Vcc.target).toBe("net.V3_3");

    const u1Sda = conns.find((c) => c.owner === "U1" && c.pinLabel === "SDA")!;
    expect(u1Sda.target).toBe("U2.SDA"); // sel.U2.SDA normalized

    const r1 = conns.find((c) => c.owner === "R1")!;
    expect(r1.target).toBe("C1.pin1"); // ".C1 > .pin1" normalized to compact

    const c1Targets = conns
      .filter((c) => c.owner === "C1")
      .map((c) => c.target)
      .sort();
    expect(c1Targets).toEqual(["C2.pin2", "net.GND"]);

    // connId is content-derived and present on every entry.
    for (const c of conns) expect(c.connId).toMatch(/^conn_[0-9a-f]{6}$/);
  });

  it("connId is shared by both endpoints of a pin→pin connection", () => {
    // Same logical link authored from either side yields the same connId.
    const a = extractConnections(
      `export default () => (<board><resistor name="R1" connections={{ pin1: "C1.pin1" }} /></board>)`
    )[0];
    const b = extractConnections(
      `export default () => (<board><capacitor name="C1" connections={{ pin1: "R1.pin1" }} /></board>)`
    )[0];
    expect(a.connId).toBe(b.connId);
  });

  it("normalizeSelectorString folds the gt form and strips leading dots", () => {
    expect(normalizeSelectorString(".U2 > .SDA")).toBe("U2.SDA");
    expect(normalizeSelectorString("U2.SDA")).toBe("U2.SDA");
    expect(normalizeSelectorString("net.V3_3")).toBe("net.V3_3");
    expect(normalizeSelectorString(".R1.pin1")).toBe("R1.pin1");
  });

  it("extractConnections falls back to regex when the tsx fails to parse", () => {
    // Trailing garbage makes the Babel parse throw, exercising the regex
    // fallback path. It must still recover connections from self-closing tags,
    // including the sel.X.Y member form. (Contract: degrade, don't drop
    // everything, on a mid-keystroke parse error.)
    const broken = `export default () => (
      <board>
        <chip name="U1" pinLabels={{ pin1: "VCC", pin2: "SDA" }}
          connections={{ VCC: "net.V3_3", SDA: sel.U2.SDA }} />
      </board>
    ) <<< not valid jsx {{`;
    const conns = extractConnections(broken);
    const vcc = conns.find((c) => c.owner === "U1" && c.pinLabel === "VCC");
    const sda = conns.find((c) => c.owner === "U1" && c.pinLabel === "SDA");
    expect(vcc?.target).toBe("net.V3_3");
    expect(sda?.target).toBe("U2.SDA"); // sel.U2.SDA normalized
    for (const c of conns) expect(c.connId).toMatch(/^conn_[0-9a-f]{6}$/);
  });

  it("extractBoardConfig falls back to regex for the board layer count", () => {
    // Trailing garbage forces the Babel parse to throw, exercising the regex
    // fallback in extractBoardConfigFallback (which has its own layers regex).
    const four = `export default () => (
      <board width="50mm" height="50mm" layers={4}>
        <resistor name="R1" resistance="10k" />
      </board>
    ) <<< not valid jsx {{`;
    const cfg = extractBoardConfig(four);
    expect(cfg.layers).toBe(4);
    expect(cfg.width).toBe("50mm");

    // No layers prop ⇒ defaults to 2, still through the fallback.
    const none = `export default () => (
      <board width="50mm" height="50mm">
        <resistor name="R1" resistance="10k" />
      </board>
    ) <<< not valid jsx {{`;
    expect(extractBoardConfig(none).layers).toBe(2);
  });

  it("returns an empty array for an empty board", () => {
    expect(extractComponents(DEFAULT_TSX)).toHaveLength(0);
  });
});

describe("tsxTransform — round-trip mutations", () => {
  it("updates a string prop and parses cleanly afterwards", () => {
    const updated = updateComponentProp(SAMPLE_TSX, "R1", "resistance", "4.7k");
    const r1 = extractComponentByName(updated, "R1");
    expect(r1?.props.resistance).toBe("4.7k");
    // Round-trip: re-extracting should still find all original components
    expect(extractComponents(updated)).toHaveLength(3);
  });

  it("adds a new prop if it doesn't exist", () => {
    const updated = updateComponentProp(SAMPLE_TSX, "LED1", "footprint", "0603");
    const led = extractComponentByName(updated, "LED1");
    expect(led?.props.footprint).toBe("0603");
  });

  it("survives values containing double quotes and backslashes", () => {
    // JSX attribute strings have no escape sequences — these values must be
    // emitted as expression containers or the document stops parsing.
    const quoted = updateComponentProp(SAMPLE_TSX, "R1", "resistance", '0.1" spacing');
    expect(extractComponentByName(quoted, "R1")?.props.resistance).toBe('0.1" spacing');
    // The document must still be editable afterwards (a parse failure would
    // make every subsequent AST edit silently no-op).
    const again = updateComponentProp(quoted, "R1", "resistance", "10k");
    expect(extractComponentByName(again, "R1")?.props.resistance).toBe("10k");

    const slashed = updateComponentProp(SAMPLE_TSX, "R1", "resistance", "a\\b");
    expect(extractComponentByName(slashed, "R1")?.props.resistance).toBe("a\\b");

    const renamed = renameComponent(SAMPLE_TSX, "R1", 'R"1');
    expect(extractComponentByName(renamed, 'R"1')).toBeDefined();
    expect(extractComponents(renamed)).toHaveLength(3);
  });

  it("removes a prop", () => {
    const updated = removeComponentProp(SAMPLE_TSX, "R1", "footprint");
    const r1 = extractComponentByName(updated, "R1");
    expect(r1?.props.footprint).toBeUndefined();
    expect(r1?.props.resistance).toBe("10k"); // others untouched
  });

  it("writes and removes the PCB layer prop", () => {
    const bottom = setComponentLayerProp(SAMPLE_TSX, "R1", "bottom");
    expect(extractComponentByName(bottom, "R1")?.props.layer).toBe("bottom");
    expect(bottom).toContain('layer="bottom"');

    const top = setComponentLayerProp(bottom, "R1", "top");
    expect(extractComponentByName(top, "R1")?.props.layer).toBeUndefined();
    expect(top).not.toContain("layer=");
  });

  it("renames a component everywhere it appears", () => {
    const updated = renameComponent(SAMPLE_TSX, "R1", "R42");
    expect(extractComponentByName(updated, "R1")).toBeNull();
    expect(extractComponentByName(updated, "R42")).toBeDefined();
  });

  it("adds a new component element", () => {
    const updated = addComponentElement(
      SAMPLE_TSX,
      `<resistor name="R2" resistance="1k" />`
    );
    expect(extractComponents(updated)).toHaveLength(4);
    const r2 = extractComponentByName(updated, "R2");
    expect(r2?.props.resistance).toBe("1k");
  });

  it("removes a component element by name", () => {
    const updated = removeComponentElement(SAMPLE_TSX, "C1");
    const components = extractComponents(updated);
    expect(components).toHaveLength(2);
    expect(extractComponentByName(updated, "C1")).toBeNull();
  });

});

describe("tsxTransform — connections write machinery", () => {
  const BASE = `export default () => (
    <board width="50mm" height="50mm">
      <chip name="U1" pinLabels={{ pin1: "VCC", pin2: "SDA" }} />
      <resistor name="R1" resistance="10k" />
      <capacitor name="C1" capacitance="100nF" />
    </board>
  )`;

  it("setComponentConnection creates the prop, then upserts entries", () => {
    let tsx = setComponentConnection(BASE, "R1", "pin1", "C1.pin1");
    let conns = extractConnections(tsx);
    expect(conns.filter((c) => c.owner === "R1")).toHaveLength(1);
    expect(conns.find((c) => c.owner === "R1")!.target).toBe("C1.pin1");

    // Second key on same owner → both present.
    tsx = setComponentConnection(tsx, "R1", "pin2", "net.GND");
    expect(extractConnections(tsx).filter((c) => c.owner === "R1")).toHaveLength(2);

    // Re-set existing key → replaced, not duplicated.
    tsx = setComponentConnection(tsx, "R1", "pin1", "U1.SDA");
    conns = extractConnections(tsx).filter((c) => c.owner === "R1");
    expect(conns).toHaveLength(2);
    expect(conns.find((c) => c.pinLabel === "pin1")!.target).toBe("U1.SDA");
    expect(validateTsx(tsx).ok).toBe(true);
  });

  it("removeComponentConnection drops an entry and the empty prop", () => {
    let tsx = setComponentConnection(BASE, "R1", "pin1", "C1.pin1");
    tsx = removeComponentConnection(tsx, "R1", "pin1");
    expect(extractConnections(tsx).filter((c) => c.owner === "R1")).toHaveLength(0);
    // Empty connections prop removed entirely.
    expect(tsx).not.toContain("connections=");
  });

  it("mintNetName derives from a usable pin label, uniquifies, and falls back", () => {
    expect(mintNetName(BASE, "SDA")).toBe("SDA");
    // Generic numeric pin labels are not usable → generic net name.
    expect(mintNetName(BASE, "pin1")).toBe("N1");
    // Collision → suffix.
    const withSda = setComponentConnection(BASE, "U1", "SDA", "net.SDA");
    expect(mintNetName(withSda, "SDA")).toBe("SDA_1");
  });

  it("promoteToNet replaces a pin→pin link with three pin→net entries", () => {
    // Start: R1.pin1 ↔ C1.pin1 (single pin→pin entry on R1).
    let tsx = setComponentConnection(BASE, "R1", "pin1", "C1.pin1");
    // A third pin (U1.SDA) joins → promote onto net "SIG".
    tsx = promoteToNet(tsx, "R1.pin1", "C1.pin1", "U1.SDA", "SIG");
    const conns = extractConnections(tsx);
    const netEntries = conns.filter((c) => c.target === "net.SIG");
    expect(netEntries).toHaveLength(3);
    // The original pin→pin entry is gone.
    expect(conns.some((c) => c.target === "C1.pin1")).toBe(false);
    expect(validateTsx(tsx).ok).toBe(true);
  });

  it("renameComponent rewrites connections targets", () => {
    let tsx = setComponentConnection(BASE, "R1", "pin1", "C1.pin1");
    tsx = renameComponent(tsx, "C1", "CAP9");
    // Connection target updated.
    expect(extractConnections(tsx).find((c) => c.owner === "R1")!.target).toBe(
      "CAP9.pin1"
    );
  });

  it("removing a component prunes connections that target it", () => {
    let tsx = setComponentConnection(BASE, "R1", "pin1", "C1.pin1");
    tsx = removeComponentElement(tsx, "C1");
    // R1's dangling connection to the deleted C1 is gone.
    expect(extractConnections(tsx).some((c) => c.target === "C1.pin1")).toBe(false);
    expect(extractComponentByName(tsx, "C1")).toBeNull();
  });
});

describe("tsxTransform — board, sequencing", () => {
  it("updates board dimensions", () => {
    const updated = updateBoardDimensions(SAMPLE_TSX, "100mm", "75mm");
    expect(extractBoardConfig(updated)).toEqual({
      width: "100mm",
      height: "75mm",
      layers: 2,
    });
    // Components should still be intact
    expect(extractComponents(updated)).toHaveLength(3);
  });

  it("survives multiple sequential mutations", () => {
    let tsx = SAMPLE_TSX;
    tsx = updateComponentProp(tsx, "R1", "resistance", "1k");
    tsx = renameComponent(tsx, "C1", "CAP1");
    tsx = updateBoardDimensions(tsx, "60mm", "60mm");

    expect(extractComponentByName(tsx, "R1")?.props.resistance).toBe("1k");
    expect(extractComponentByName(tsx, "CAP1")).toBeDefined();
    expect(extractBoardConfig(tsx)).toEqual({
      width: "60mm",
      height: "60mm",
      layers: 2,
    });
  });

  it("reads/writes the board copper layer count", () => {
    // No prop ⇒ 2-layer board.
    expect(extractBoardConfig(SAMPLE_TSX).layers).toBe(2);

    // Bump to 4 — the prop is written and round-trips.
    const four = updateBoardLayers(SAMPLE_TSX, 4);
    expect(four).toContain("layers={4}");
    expect(extractBoardConfig(four).layers).toBe(4);
    // Other board props + components survive the edit.
    expect(extractBoardConfig(four).width).toBe("50mm");
    expect(extractComponents(four)).toHaveLength(3);

    // Back to the 2-layer default strips the explicit prop.
    const two = updateBoardLayers(four, 2);
    expect(two).not.toContain("layers=");
    expect(extractBoardConfig(two).layers).toBe(2);
  });

  it("clamps out-of-range board layer counts", () => {
    expect(extractBoardConfig(updateBoardLayers(SAMPLE_TSX, 99)).layers).toBe(8);
    // 1 layer is nonsensical — floored to the 2-layer minimum (prop stripped).
    expect(extractBoardConfig(updateBoardLayers(SAMPLE_TSX, 1)).layers).toBe(2);
  });
});

describe("tsxTransform — edge cases", () => {
  it("handles JSX with expression-container values", () => {
    const tsx = `export default () => (
      <board width="50mm" height="50mm">
        <chip name="U1" pinCount={8} />
      </board>
    )`;
    const u1 = extractComponentByName(tsx, "U1");
    expect(u1).toBeDefined();
    expect(u1?.props.pinCount).toBe("8");
  });

  it("handles boolean JSX attributes (no value)", () => {
    const tsx = `export default () => (
      <board width="50mm" height="50mm">
        <net name="GND" isGroundNet />
      </board>
    )`;
    const gnd = extractComponentByName(tsx, "GND");
    expect(gnd?.props.isGroundNet).toBe("true");
  });

  it("does not mutate the input string", () => {
    const before = SAMPLE_TSX;
    updateComponentProp(SAMPLE_TSX, "R1", "resistance", "4.7k");
    expect(SAMPLE_TSX).toBe(before);
  });

  it("returns the same TSX when removing a non-existent component", () => {
    const result = removeComponentElement(SAMPLE_TSX, "DOES_NOT_EXIST");
    // Should still parse — we just check components are unchanged
    expect(extractComponents(result)).toHaveLength(3);
  });
});

describe("tsxTransform — pin editing helpers", () => {
  const CHIP_TSX = `export default () => (
    <board>
      <chip name="U1" pinCount={4} pinLabels={{"1": "VCC", "2": "GND"}} />
    </board>
  )`;

  it("updateComponentNumericProp writes pinCount as a JSX numeric expression", () => {
    const updated = updateComponentNumericProp(CHIP_TSX, "U1", "pinCount", 8);
    expect(updated).toContain("pinCount={8}");
    expect(updated).not.toContain('pinCount="8"');
    const u1 = extractComponentByName(updated, "U1");
    expect(u1?.props.pinCount).toBe("8");
  });

  it("updateComponentNumericProp adds the prop when missing", () => {
    const tsx = `export default () => (<board><chip name="U2" /></board>)`;
    const updated = updateComponentNumericProp(tsx, "U2", "pinCount", 16);
    expect(updated).toContain("pinCount={16}");
  });

  it("updateComponentNumericProp ignores non-finite values", () => {
    const updated = updateComponentNumericProp(CHIP_TSX, "U1", "pinCount", NaN);
    expect(updated).toBe(CHIP_TSX);
  });

  it("updateComponentPinLabels rewrites the pinLabels object", () => {
    const updated = updateComponentPinLabels(CHIP_TSX, "U1", [
      "RST",
      "SCK",
      "MISO",
      "MOSI",
    ]);
    const u1 = extractComponentByName(updated, "U1");
    expect(u1?.props.pinLabels).toContain('"1": "RST"');
    expect(u1?.props.pinLabels).toContain('"2": "SCK"');
    expect(u1?.props.pinLabels).toContain('"3": "MISO"');
    expect(u1?.props.pinLabels).toContain('"4": "MOSI"');
    // Old entries should be gone.
    expect(u1?.props.pinLabels).not.toContain("VCC");
  });

  it("updateComponentPinLabels skips empty/whitespace labels", () => {
    const updated = updateComponentPinLabels(CHIP_TSX, "U1", [
      "VCC",
      "",
      "  ",
      "GND",
    ]);
    const u1 = extractComponentByName(updated, "U1");
    expect(u1?.props.pinLabels).toContain('"1": "VCC"');
    expect(u1?.props.pinLabels).toContain('"4": "GND"');
    expect(u1?.props.pinLabels).not.toMatch(/"2":\s*"/);
    expect(u1?.props.pinLabels).not.toMatch(/"3":\s*"/);
  });

  it("updateComponentPinLabels adds the prop when missing", () => {
    const tsx = `export default () => (<board><chip name="U3" pinCount={2} /></board>)`;
    const updated = updateComponentPinLabels(tsx, "U3", ["A", "B"]);
    const u3 = extractComponentByName(updated, "U3");
    expect(u3?.props.pinLabels).toContain('"1": "A"');
    expect(u3?.props.pinLabels).toContain('"2": "B"');
  });
});

describe("tsxTransform — validateTsx (Code tab parse gate)", () => {
  it("accepts valid circuit TSX", () => {
    const result = validateTsx(SAMPLE_TSX);
    expect(result.ok).toBe(true);
  });

  it("accepts the default TSX", () => {
    expect(validateTsx(DEFAULT_TSX).ok).toBe(true);
  });

  it("default TSX uses the component-export module entrypoint", () => {
    // The editor renders tsxCode verbatim and the 'Export → tscircuit TSX'
    // button dumps it straight to a .tsx file, so the canonical form must be a
    // standalone, importable component module. The evaluator loads the exported
    // component via mainComponentPath.
    expect(DEFAULT_TSX).toContain("export default");
    expect(DEFAULT_TSX).not.toContain("circuit.add");
  });

  it("rejects syntactically broken TSX with an error", () => {
    const broken = `export default () => (
      <board width="50mm" height="50mm">
        <resistor name="R1" resistance="10k"
      </board>
    )`;
    const result = validateTsx(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeTruthy();
    }
  });

  it("reports a line number for the syntax error when available", () => {
    const broken = `export default () => (\n  <board>\n    <resistor name=="R1" />\n  </board>\n)`;
    const result = validateTsx(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.line).toBe("number");
    }
  });
});

// The circuit is one self-contained module with no import statements, so a
// component's `const` block is the only thing that makes its tag resolve.
// These two back the component-definition recovery pass.
describe("extractComponentDefinitions", () => {
  const WITH_DEF = `const TP4056 = (props: any) => (
  <chip {...props} footprint="soic8" pinLabels={{ pin1: "TEMP" }} />
);

export default () => (
  <board width="20mm" height="20mm">
    <TP4056 name="U1" />
  </board>
);`;

  it("harvests a capitalized top-level const with its source verbatim", () => {
    const defs = extractComponentDefinitions(WITH_DEF);
    expect(Object.keys(defs)).toEqual(["TP4056"]);
    expect(defs.TP4056).toContain('footprint="soic8"');
    expect(defs.TP4056).toContain('pin1: "TEMP"');
  });

  it("harvests function declarations", () => {
    const defs = extractComponentDefinitions(
      `function Bar() { return <chip />; }\nexport default () => <board />;`
    );
    expect(Object.keys(defs)).toEqual(["Bar"]);
  });

  it("unwraps `export const` so the recovered copy carries no stray export", () => {
    const defs = extractComponentDefinitions(
      `export const Foo = () => <chip />;\nexport default () => <board />;`
    );
    expect(defs.Foo.startsWith("const")).toBe(true);
  });

  it("never treats the circuit's own export default as a part definition", () => {
    const defs = extractComponentDefinitions(
      `export default function MyCircuit() { return <board />; }`
    );
    expect(defs).toEqual({});
  });

  it("ignores lowercase bindings — those are never JSX component tags", () => {
    const defs = extractComponentDefinitions(
      `const vin = "5V";\nexport default () => <board />;`
    );
    expect(defs).toEqual({});
  });

  it("returns {} on unparseable input rather than throwing", () => {
    expect(extractComponentDefinitions("const = ((")).toEqual({});
  });
});

describe("findUndefinedComponents", () => {
  it("finds nothing when every referenced tag is defined", () => {
    const tsx = `const TP4056 = (props: any) => <chip {...props} />;
export default () => (
  <board><TP4056 name="U1" /></board>
);`;
    expect(findUndefinedComponents(tsx)).toEqual([]);
  });

  it("flags a referenced tag whose definition was dropped", () => {
    const tsx = `export default () => (
  <board><TP4056 name="U1" /></board>
);`;
    expect(findUndefinedComponents(tsx)).toEqual(["TP4056"]);
  });

  it("ignores built-in lowercase tscircuit elements", () => {
    const tsx = `export default () => (
  <board><resistor name="R1" /><trace from=".R1 > .pin1" to="net.GND" /></board>
);`;
    expect(findUndefinedComponents(tsx)).toEqual([]);
  });

  it("does not confuse a name-prefixed binding for the real definition", () => {
    // `const TP4056_BULK` must not satisfy `<TP4056 />` — the substring check
    // this replaced did exactly that and silently skipped the real splice.
    const tsx = `const TP4056_BULK = "100uF";
export default () => (
  <board><TP4056 name="U1" /></board>
);`;
    expect(findUndefinedComponents(tsx)).toEqual(["TP4056"]);
  });

  it("resolves a definition nested in the component's own scope", () => {
    const tsx = `export default () => {
  const Inner = () => <chip name="U9" />;
  return <board><Inner name="U1" /></board>;
};`;
    expect(findUndefinedComponents(tsx)).toEqual([]);
  });

  it("reports each missing tag once", () => {
    const tsx = `export default () => (
  <board><TP4056 name="U1" /><TP4056 name="U2" /><ESP32 name="U3" /></board>
);`;
    expect(findUndefinedComponents(tsx).sort()).toEqual(["ESP32", "TP4056"]);
  });

  it("returns [] on unparseable input — that is a syntax error, not a missing tag", () => {
    expect(findUndefinedComponents("const = ((")).toEqual([]);
  });
});
