import { describe, it, expect } from "vitest";
import { canonEndpoint, connectionId } from "./connectionId";

describe("canonEndpoint", () => {
  it("collapses the dot, gt, and case variants to one form", () => {
    expect(canonEndpoint("U2.SDA")).toBe("u2.sda");
    expect(canonEndpoint(".U2 > .SDA")).toBe("u2.sda");
    expect(canonEndpoint("  .u2  >  .sda ")).toBe("u2.sda");
    expect(canonEndpoint(".u2.sda")).toBe("u2.sda");
  });

  it("passes net targets through (lowercased)", () => {
    expect(canonEndpoint("net.V3_3")).toBe("net.v3_3");
    expect(canonEndpoint("net.GND")).toBe("net.gnd");
  });
});

describe("connectionId", () => {
  it("is a KEY_RE-conforming conn_<6hex> id", () => {
    const id = connectionId("U1.SDA", "U2.SDA");
    expect(id).toMatch(/^conn_[0-9a-f]{6}$/);
    // The ProjectStore sanitizer's KEY_RE must accept it.
    expect(id).toMatch(/^[a-z][a-z0-9]{0,7}_[a-z0-9]{6}$/);
  });

  it("is order-independent", () => {
    expect(connectionId("U1.SDA", "U2.SDA")).toBe(connectionId("U2.SDA", "U1.SDA"));
  });

  it("is invariant across selector-form and case differences", () => {
    expect(connectionId(".U1 > .SDA", "U2.SDA")).toBe(
      connectionId("u1.sda", ".u2 > .sda")
    );
  });

  it("distinguishes different pairs", () => {
    expect(connectionId("U1.SDA", "U2.SDA")).not.toBe(
      connectionId("U1.SCL", "U2.SCL")
    );
    expect(connectionId("U1.VCC", "net.V3_3")).not.toBe(
      connectionId("U1.VCC", "net.GND")
    );
  });
});
