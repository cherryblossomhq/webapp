// Stable identity for circuit elements. Designators (R1, C2) drift on rename
// or rewrite; positions in a sidecar must reference something that survives
// both. Every component / trace / via in the tsx gets a `key="<prefix>_<6char>"`
// prop. The sidecar (manualEdits) keys off this string.

import * as recast from "recast";
import * as babelTsParser from "recast/parsers/babel-ts";
import _traverse from "@babel/traverse";
import * as t from "@babel/types";

const traverse: typeof _traverse =
  typeof _traverse === "function"
    ? _traverse
    : (_traverse as unknown as { default: typeof _traverse }).default;

export type StableKey = string;

const KEY_FORMAT = /^[a-z][a-z0-9]{0,7}_[a-z0-9]{6}$/;
const SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

// SINGLE SOURCE OF TRUTH for keyable tscircuit element tags and their stable-key
// prefix. Everything that needs "which tags get a key / are components" derives
// from this map so the lists can't drift apart — the drift that let a
// <connector> be known to extractComponents but not the key injector (or vice
// versa), silently lose its stable key, and lag ~2s on drag because its live
// override couldn't be matched. A built-in lowercase part MISSING here gets no
// key. Uppercase imported parts (ESP32_…) are caught by the isKeyable /
// isComponentElement fallback, so only built-in lowercase tags need listing.
// tsxTransform.ts imports this map to derive COMPONENT_ELEMENTS (this map minus
// the routing tags) and its key-prefix lookup.
export const DESIGNATOR_PREFIX_BY_TAG: Record<string, string> = {
  // Placeable, footprinted components — draggable on the PCB canvas.
  resistor: "r",
  capacitor: "c",
  inductor: "l",
  led: "d",
  diode: "d",
  transistor: "q",
  mosfet: "q",
  chip: "u",
  bug: "u", // legacy alias for <chip>
  opamp: "u",
  connector: "j",
  pinheader: "j",
  jumper: "jp",
  solderjumper: "sj",
  switch: "sw",
  pushbutton: "sw",
  potentiometer: "rv",
  crystal: "y",
  resonator: "y",
  fuse: "f",
  battery: "bt",
  testpoint: "tp",
  // Routing / logical tags — keyable (the sidecar references them) but not
  // footprinted parts. `trace` and `via` are excluded from COMPONENT_ELEMENTS;
  // `net` stays a component element to preserve extractComponents' behavior.
  net: "n",
  trace: "t",
  via: "via",
};

// Keyable tags that tsxTransform's COMPONENT_ELEMENTS must NOT include — the PCB
// routing primitives. (`net` is keyable too but is intentionally kept as a
// component element, matching long-standing extractComponents behavior.)
export const NON_COMPONENT_KEYABLE_TAGS: ReadonlySet<string> = new Set([
  "trace",
  "via",
]);

function tagToPrefix(tag: string): string {
  return DESIGNATOR_PREFIX_BY_TAG[tag] ?? "x";
}

// Generate a 6-char alphanumeric suffix using crypto.getRandomValues when
// available (browser, Node 19+). Falls back to Math.random for vitest in jsdom
// older than that — only used in tests, never in production paths.
function randomSuffix(): string {
  let out = "";
  const cryptoObj =
    typeof globalThis !== "undefined" &&
    (globalThis as unknown as { crypto?: Crypto }).crypto;
  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    const buf = new Uint8Array(6);
    cryptoObj.getRandomValues(buf);
    for (let i = 0; i < 6; i++) {
      out += SUFFIX_ALPHABET[buf[i] % SUFFIX_ALPHABET.length];
    }
    return out;
  }
  for (let i = 0; i < 6; i++) {
    out += SUFFIX_ALPHABET[Math.floor(Math.random() * SUFFIX_ALPHABET.length)];
  }
  return out;
}

export function generateStableKey(
  prefixOrTag: string,
  existing?: ReadonlySet<StableKey>
): StableKey {
  const rawPrefix = (prefixOrTag || "x").toLowerCase().replace(/[^a-z0-9]/g, "");
  const prefix =
    rawPrefix && /^[a-z]/.test(rawPrefix) ? rawPrefix.slice(0, 8) : "x";

  // Retry up to 16 times to avoid the astronomically-unlikely collision case;
  // 36^6 ≈ 2.2B values, so even with 1k existing keys collision odds are tiny.
  for (let i = 0; i < 16; i++) {
    const candidate = `${prefix}_${randomSuffix()}`;
    if (!existing || !existing.has(candidate)) return candidate;
  }
  // Ultra-defensive fallback — append a counter-derived suffix.
  let i = 0;
  while (true) {
    const candidate = `${prefix}_${randomSuffix()}${i.toString(36)}`;
    if (!existing || !existing.has(candidate)) return candidate;
    i++;
  }
}

export function validateKey(s: unknown): s is StableKey {
  return typeof s === "string" && KEY_FORMAT.test(s);
}

function parse(tsx: string) {
  return recast.parse(tsx, { parser: babelTsParser });
}

function getStringAttr(
  node: t.JSXOpeningElement,
  attrName: string
): string | undefined {
  for (const attr of node.attributes) {
    if (!t.isJSXAttribute(attr)) continue;
    if (!t.isJSXIdentifier(attr.name) || attr.name.name !== attrName) continue;
    if (t.isStringLiteral(attr.value)) return attr.value.value;
    if (
      t.isJSXExpressionContainer(attr.value) &&
      t.isStringLiteral(attr.value.expression)
    )
      return attr.value.expression.value;
  }
  return undefined;
}

// Derived from the canonical map so it can never drift from the prefix table
// or from tsxTransform's COMPONENT_ELEMENTS.
const KEYABLE_TAGS = new Set(Object.keys(DESIGNATOR_PREFIX_BY_TAG));

function isKeyable(tag: string): boolean {
  if (KEYABLE_TAGS.has(tag)) return true;
  // Imported components (custom React component, capitalized)
  if (tag[0] >= "A" && tag[0] <= "Z") return true;
  return false;
}

// Returns the set of valid stable keys present in the tsx, OR null when the
// tsx couldn't be parsed at all. Distinguishing "parsed, zero keys" from
// "parse failed" matters: pruneOrphanEdits would otherwise wipe every sidecar
// entry the moment the user types a temporarily-invalid character. Callers
// that only need a Set should use collectKeysOrEmpty().
export function collectKeys(tsx: string): Set<StableKey> | null {
  try {
    const ast = parse(tsx);
    const keys = new Set<StableKey>();
    traverse(ast, {
      JSXOpeningElement(path) {
        if (!t.isJSXIdentifier(path.node.name)) return;
        const tag = path.node.name.name;
        if (tag === "board") return;
        if (!isKeyable(tag)) return;
        const key = getStringAttr(path.node, "key");
        if (validateKey(key)) keys.add(key);
      },
    });
    return keys;
  } catch {
    return null;
  }
}

// Convenience for read-only callers that don't need to distinguish empty
// from unknown (key-collision avoidance during snippet insertion).
export function collectKeysOrEmpty(tsx: string): Set<StableKey> {
  return collectKeys(tsx) ?? new Set();
}

// Add a key="..." prop to every keyable JSX opener that doesn't have one,
// AND repair any duplicate-but-valid keys (the second occurrence onward
// gets a freshly-generated key, so two physical elements never share one
// sidecar identity).
//
// Existing UNIQUE valid keys are preserved (idempotent on already-keyed,
// already-deduped tsx). Non-mutating: returns new tsx.
export function injectKeysIntoTsx(tsx: string): string {
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(tsx);
  } catch {
    // Couldn't parse; return untouched. The caller (migration) should keep
    // the user's original tsx rather than throw away their work.
    return tsx;
  }

  // First pass: figure out which keys are SAFE to keep. A valid key seen for
  // the first time is safe. Any subsequent occurrence of the same key marks
  // it as a duplicate; the first occurrence still keeps the key (so existing
  // sidecar references for that element stay valid), but the duplicates will
  // be regenerated in the second pass.
  const seenKeys = new Set<StableKey>();
  const duplicateKeys = new Set<StableKey>();
  traverse(ast, {
    JSXOpeningElement(path) {
      if (!t.isJSXIdentifier(path.node.name)) return;
      const tag = path.node.name.name;
      if (tag === "board" || !isKeyable(tag)) return;
      const k = getStringAttr(path.node, "key");
      if (!validateKey(k)) return;
      if (seenKeys.has(k)) {
        duplicateKeys.add(k);
      } else {
        seenKeys.add(k);
      }
    },
  });

  // Second pass: replace missing OR malformed OR duplicate-occurrence keys
  // with a freshly-generated one. We track which valid keys we've already
  // "consumed" (the first occurrence of each duplicate) so subsequent
  // duplicates trip the dedupe branch.
  const consumed = new Set<StableKey>();
  let modified = false;
  traverse(ast, {
    JSXOpeningElement(path) {
      if (!t.isJSXIdentifier(path.node.name)) return;
      const tag = path.node.name.name;
      if (tag === "board" || !isKeyable(tag)) return;

      const k = getStringAttr(path.node, "key");
      const isValid = validateKey(k);
      const isDuplicate = isValid && duplicateKeys.has(k) && consumed.has(k);

      if (isValid && !isDuplicate) {
        consumed.add(k);
        return;
      }

      // Already has a key= attribute but it's invalid OR a duplicate occurrence.
      const existingAttrIdx = path.node.attributes.findIndex(
        (a) =>
          t.isJSXAttribute(a) &&
          t.isJSXIdentifier(a.name) &&
          a.name.name === "key"
      );

      const newKey = generateStableKey(tagToPrefix(tag), seenKeys);
      seenKeys.add(newKey);

      const newAttr = t.jsxAttribute(
        t.jsxIdentifier("key"),
        t.stringLiteral(newKey)
      );

      if (existingAttrIdx >= 0) {
        path.node.attributes.splice(existingAttrIdx, 1, newAttr);
      } else {
        path.node.attributes.unshift(newAttr);
      }
      modified = true;
    },
  });

  if (!modified) return tsx;
  try {
    return recast.print(ast).code;
  } catch {
    return tsx;
  }
}

// Build a `key="..."` prop string from a tag and (optional) existing-key set.
// Used by tsxTransform helpers when constructing a snippet to insert.
export function buildKeyAttr(
  tag: string,
  existing?: ReadonlySet<StableKey>
): { key: StableKey; attr: string } {
  const key = generateStableKey(tagToPrefix(tag), existing);
  return { key, attr: `key="${key}"` };
}
