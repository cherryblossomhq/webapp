import { describe, it, expect } from "vitest";
import { isChipLike } from "./index";

describe("isChipLike", () => {
  it("returns true for known chip-like tags", () => {
    expect(isChipLike("chip")).toBe(true);
    expect(isChipLike("ic")).toBe(true);
    expect(isChipLike("opamp")).toBe(true);
    expect(isChipLike("regulator")).toBe(true);
    expect(isChipLike("mcu")).toBe(true);
    expect(isChipLike("pinheader")).toBe(true);
    expect(isChipLike("connector")).toBe(true);
  });

  it("treats any capitalized tag as chip-like (imported React component)", () => {
    expect(isChipLike("ESP32S3")).toBe(true);
    expect(isChipLike("AD623ARZ")).toBe(true);
  });

  it("returns false for lowercase passives / discretes", () => {
    expect(isChipLike("resistor")).toBe(false);
    expect(isChipLike("capacitor")).toBe(false);
    expect(isChipLike("led")).toBe(false);
    expect(isChipLike("diode")).toBe(false);
    expect(isChipLike("transistor")).toBe(false);
    expect(isChipLike("net")).toBe(false);
  });
});
