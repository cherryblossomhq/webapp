import { describe, expect, it } from "vitest";
import {
  FOOTPRINT_FAMILIES,
  isValidFootprint,
  validateCircuitFootprints,
} from "./footprintCatalog";

describe("isValidFootprint", () => {
  it("accepts every catalog entry verbatim", () => {
    for (const family of FOOTPRINT_FAMILIES) {
      for (const example of family.examples) {
        expect(isValidFootprint(example), example).toBe(true);
      }
    }
  });

  // `_p<pitch>`, `_w<width>`, `_id`/`_od`, `_female`, `_smd` are valid on any
  // family — all of these parse in footprinter, so the validator must not
  // report them as unknown.
  it("accepts parameter suffixes on catalog families", () => {
    for (const fp of [
      "pinrow6_female",
      "pinrow3_smd",
      "dip8_p2mm",
      "soic8_p1.27mm",
      "qfn16_p0.5mm",
      "0402_smd",
      "to92_p1.27mm",
      "platedhole_d2mm",
      "platedhole_id0.8mm_od1.5mm",
      "smtpad_w3mm_h2mm",
      "axial_p10mm",
      "electrolytic_p5mm",
      "radial_p2.5mm",
    ]) {
      expect(isValidFootprint(fp), fp).toBe(true);
    }
  });

  it("rejects invented families and unrecognised suffixes", () => {
    for (const fp of [
      "sip5",
      "do35",
      "to263",
      "dpak",
      "usbc",
      "soic8_bogus5mm", // footprinter silently drops the suffix — keep nagging
      "pinrow12_female", // pinrow12 itself isn't a catalog entry
    ]) {
      expect(isValidFootprint(fp), fp).toBe(false);
    }
  });

  // Footprinter matches the pin-count suffix case-sensitively: SOT23_5
  // silently renders 3 pads. Uppercase must stay flagged.
  it("rejects non-lowercase footprints", () => {
    expect(isValidFootprint("SOT23_5")).toBe(false);
    expect(isValidFootprint("Soic8")).toBe(false);
    expect(isValidFootprint("PINROW6_FEMALE")).toBe(false);
  });

  // `axial`/`smtpad`/`platedhole` are only meaningful with explicit
  // dimensions; the bare base is not legalised by suffix-stripping.
  it("rejects bare bases of parameterised catalog entries", () => {
    expect(isValidFootprint("axial")).toBe(false);
    expect(isValidFootprint("smtpad")).toBe(false);
    expect(isValidFootprint("platedhole")).toBe(false);
  });
});

describe("validateCircuitFootprints", () => {
  it("does not flag a suffixed variant of a catalog family", () => {
    const tsx = `export default () => (<board width="20mm" height="20mm">
      <pinheader name="J1" pinCount={6} footprint="pinrow6_female" />
    </board>)`;
    expect(validateCircuitFootprints(tsx)).toEqual([]);
  });

  // The prompt tells the model a <connector> needs an explicit footprint
  // (`standard` only queues a parts-service lookup); the validator must
  // surface the omission instead of exempting the tag.
  it("flags a connector without a footprint as missing", () => {
    const tsx = `export default () => (<board width="20mm" height="20mm">
      <connector name="J1" standard="usb_c" />
    </board>)`;
    const issues = validateCircuitFootprints(tsx);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      componentName: "J1",
      elementTag: "connector",
      kind: "missing",
    });
  });
});
