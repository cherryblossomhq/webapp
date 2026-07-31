// connectionId — content-derived stable identity for a single connection.
//
// Connectivity now lives in `connections={{ pinLabel: target }}` props (the
// source of truth), not in keyed `<trace>` elements. A connection therefore
// has no JSX element to carry a `key="..."`, yet the schematic editor still
// needs a stable handle to anchor the user's hand-drawn wire/stub waypoints in
// the manualEdits sidecar.
//
// The identity of a connection IS its endpoint pair, so we derive a key from
// the (normalized, order-independent) pair rather than minting a random one.
// The result is a `conn_<6hex>` string that:
//   - satisfies ProjectStore's KEY_RE (/^[a-z][a-z0-9]{0,7}_[a-z0-9]{6}$/), so
//     it survives sidecar save/load sanitization,
//   - uses the `conn` prefix (no component tag maps to it) so it can never
//     collide with an element's stable key (e.g. a capacitor's `c_…`), and
//   - is reproduced identically by both the authoring code (which writes the
//     waypoints) and schematicModel (which reads them back), regardless of
//     which side of the pair each computed first.
//
// This module lives in editor/shared so schematicModel, circuitStore, and
// ProjectStore can all import it without a cycle.

import type { StableKey } from "./keys";

// Normalize ONE endpoint selector for hashing. Lowercases (so "U2.SDA",
// ".U2 > .SDA" and "u2.sda" collapse to one identity), strips a leading dot,
// and folds the `.X > .y` selector form into compact `x.y`. Net targets pass
// through as "net.<lower>".
export function canonEndpoint(sel: string): string {
  const s = sel.trim().toLowerCase();
  // `.X > .y` (or `X > .y`, `.X > y`) → `x.y`
  const gt = s.match(/^\.?([a-z_][\w]*)\s*>\s*\.?([\w]+)$/);
  if (gt) return `${gt[1]}.${gt[2]}`;
  return s.replace(/^\./, "");
}

// FNV-1a 32-bit → 6 lowercase hex chars. Dependency-free and deterministic.
// Collision risk (16^6 ≈ 16.7M) is acceptable at single-board scale, and a
// collision only swaps waypoints between two distinct connections (cosmetic,
// never data-corrupting). Mirrors the hash style in CircuitEvaluator.hashInput.
function hash6(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(6, "0").slice(-6);
}

// Order-independent stable id for a connection between two endpoints. The pair
// is sorted so connectionId(a, b) === connectionId(b, a).
export function connectionId(a: string, b: string): StableKey {
  const [x, y] = [canonEndpoint(a), canonEndpoint(b)].sort();
  return `conn_${hash6(`${x}|${y}`)}`;
}
