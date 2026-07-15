import { describe, it, expect } from "vitest";
import {
  generateStableKey,
  validateKey,
  injectKeysIntoTsx,
  collectKeys,
  collectKeysOrEmpty,
} from "./keys";

describe("generateStableKey", () => {
  it("produces values that match the canonical format", () => {
    for (let i = 0; i < 50; i++) {
      const k = generateStableKey("r");
      expect(k).toMatch(/^r_[a-z0-9]{6}$/);
      expect(validateKey(k)).toBe(true);
    }
  });

  it("uses the supplied prefix verbatim", () => {
    expect(generateStableKey("c")).toMatch(/^c_/);
    expect(generateStableKey("via")).toMatch(/^via_/);
    expect(generateStableKey("u")).toMatch(/^u_/);
  });

  it("normalizes garbage prefixes to the safe fallback 'x'", () => {
    expect(generateStableKey("")).toMatch(/^x_/);
    expect(generateStableKey("123")).toMatch(/^x_/);
    expect(generateStableKey("!!@@")).toMatch(/^x_/);
  });

  it("retries on collision against an existing-keys set", () => {
    // Pre-populate with most of the 36^6 space at a single prefix to stress
    // collision logic. We use a small synthetic set and verify uniqueness.
    const existing = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const k = generateStableKey("r", existing);
      expect(existing.has(k)).toBe(false);
      existing.add(k);
    }
  });
});

describe("validateKey", () => {
  it("accepts the canonical format", () => {
    expect(validateKey("r_a3f9p2")).toBe(true);
    expect(validateKey("via_abc123")).toBe(true);
    expect(validateKey("c1_b8e2k1")).toBe(true);
  });

  it("rejects malformed inputs", () => {
    expect(validateKey("R_a3f9p2")).toBe(false); // uppercase
    expect(validateKey("r-a3f9p2")).toBe(false); // dash separator
    expect(validateKey("r_a3f9")).toBe(false); // suffix too short
    expect(validateKey("_a3f9p2")).toBe(false); // empty prefix
    expect(validateKey("123_abcdef")).toBe(false); // numeric prefix
    expect(validateKey("")).toBe(false);
    expect(validateKey(null)).toBe(false);
    expect(validateKey(42)).toBe(false);
  });
});

describe("injectKeysIntoTsx", () => {
  it("adds key props to every component missing one", () => {
    const tsx = `circuit.add(
  <board width="50mm" height="50mm">
    <resistor name="R1" resistance="10k" />
    <capacitor name="C1" capacitance="100nF" />
  </board>
)
`;
    const out = injectKeysIntoTsx(tsx);
    expect(out).toMatch(/<resistor key="r_[a-z0-9]{6}" name="R1"/);
    expect(out).toMatch(/<capacitor key="c_[a-z0-9]{6}" name="C1"/);
  });

  it("preserves keys that are already valid", () => {
    const tsx = `circuit.add(
  <board width="50mm" height="50mm">
    <resistor key="r_alpha1" name="R1" resistance="10k" />
  </board>
)
`;
    const out = injectKeysIntoTsx(tsx);
    expect(out).toContain('key="r_alpha1"');
    // Should NOT have added a second key="..."
    const matches = out.match(/key=/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("is idempotent — running twice produces identical output", () => {
    const tsx = `circuit.add(
  <board>
    <resistor name="R1" resistance="10k" />
  </board>
)
`;
    const once = injectKeysIntoTsx(tsx);
    const twice = injectKeysIntoTsx(once);
    expect(twice).toBe(once);
  });

  it("returns the input unchanged when nothing parses", () => {
    const broken = "circuit.add( <not really tsx ;;;;";
    expect(injectKeysIntoTsx(broken)).toBe(broken);
  });

  it("ignores the <board> element itself", () => {
    const tsx = `circuit.add(
  <board width="50mm" height="50mm">
  </board>
)
`;
    const out = injectKeysIntoTsx(tsx);
    expect(out).not.toMatch(/<board key=/);
  });

  it("keys built-in parts beyond the core set (connector, crystal, mosfet)", () => {
    // AI-generated tsx often omits key= on these. If injectKeysIntoTsx skips
    // them they never get a stable key, so their live-drag override can't be
    // matched and they lag ~2s on every move — the bug this set expansion fixes.
    const tsx = `circuit.add(
  <board>
    <connector name="J1" standard="usb_c" />
    <crystal name="Y1" frequencyHz={16e6} />
    <mosfet name="Q1" channelType="n" />
  </board>
)
`;
    const out = injectKeysIntoTsx(tsx);
    expect(out).toMatch(/<connector key="j_[a-z0-9]{6}"/);
    expect(out).toMatch(/<crystal key="y_[a-z0-9]{6}"/);
    expect(out).toMatch(/<mosfet key="q_[a-z0-9]{6}"/);
  });

  it("keys traces, vias, and nets too", () => {
    const tsx = `circuit.add(
  <board>
    <net name="GND" isGroundNet />
    <trace path={[".R1 > .pin1", ".C1 > .pin1"]} />
  </board>
)
`;
    const out = injectKeysIntoTsx(tsx);
    expect(out).toMatch(/<net key="n_/);
    expect(out).toMatch(/<trace key="t_/);
  });

  it("replaces a malformed key prop rather than producing duplicates", () => {
    const tsx = `circuit.add(
  <board>
    <resistor key="123" name="R1" />
  </board>
)
`;
    const out = injectKeysIntoTsx(tsx);
    const keyAttrs = out.match(/key=/g) ?? [];
    expect(keyAttrs.length).toBe(1);
    expect(out).toMatch(/key="r_[a-z0-9]{6}"/);
  });

  it("CRITICAL: dedupes valid-but-duplicate keys (regenerates the second occurrence)", () => {
    const tsx = `circuit.add(
  <board>
    <resistor key="r_dupkey" name="R1" />
    <resistor key="r_dupkey" name="R2" />
  </board>
)
`;
    const out = injectKeysIntoTsx(tsx);
    // Pull every key="..." value and assert they're all unique.
    const keys = [...out.matchAll(/key="([^"]+)"/g)].map((m) => m[1]);
    expect(keys.length).toBe(2);
    expect(new Set(keys).size).toBe(2);
    // The first occurrence keeps the original key (so any sidecar entry
    // referencing r_dupkey still resolves to a real element).
    expect(keys[0]).toBe("r_dupkey");
    expect(keys[1]).not.toBe("r_dupkey");
  });

  it("CRITICAL: dedupe across many duplicates produces N unique keys", () => {
    const tsx = `circuit.add(
  <board>
    <resistor key="r_xxxxxx" name="R1" />
    <resistor key="r_xxxxxx" name="R2" />
    <resistor key="r_xxxxxx" name="R3" />
    <resistor key="r_xxxxxx" name="R4" />
  </board>
)
`;
    const out = injectKeysIntoTsx(tsx);
    const keys = [...out.matchAll(/key="([^"]+)"/g)].map((m) => m[1]);
    expect(keys.length).toBe(4);
    expect(new Set(keys).size).toBe(4);
  });
});

describe("collectKeys", () => {
  it("extracts all valid keys from tsx", () => {
    const tsx = `circuit.add(
  <board>
    <resistor key="r_aaa111" name="R1" />
    <capacitor key="c_bbb222" name="C1" />
    <led name="D1" />
  </board>
)
`;
    const keys = collectKeys(tsx);
    expect(keys).not.toBeNull();
    expect(keys!.has("r_aaa111")).toBe(true);
    expect(keys!.has("c_bbb222")).toBe(true);
    expect(keys!.size).toBe(2);
  });

  it("CRITICAL: returns null (not empty set) when tsx fails to parse", () => {
    // This distinguishes 'parsed but empty' from 'parse failed'. Without it,
    // pruneOrphanEdits would silently wipe every sidecar entry while the
    // user is mid-keystroke.
    expect(collectKeys("not tsx ;;;")).toBeNull();
  });

  it("returns an empty set for parseable tsx with no keyable elements", () => {
    const keys = collectKeys("circuit.add(<board />)");
    expect(keys).not.toBeNull();
    expect(keys!.size).toBe(0);
  });
});

describe("collectKeysOrEmpty", () => {
  it("returns the live key set when parsing succeeds", () => {
    const tsx = `circuit.add(<board><resistor key="r_aaa111" name="R1"/></board>)`;
    expect(collectKeysOrEmpty(tsx).size).toBe(1);
  });

  it("returns an empty set (not null) on parse failure", () => {
    const k = collectKeysOrEmpty("not tsx ;;;");
    expect(k.size).toBe(0);
  });
});
