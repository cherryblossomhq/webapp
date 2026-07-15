import * as recast from "recast";
import * as babelTsParser from "recast/parsers/babel-ts";
import _traverse from "@babel/traverse";
import * as t from "@babel/types";
import {
  collectKeysOrEmpty,
  generateStableKey,
  validateKey,
  DESIGNATOR_PREFIX_BY_TAG,
  NON_COMPONENT_KEYABLE_TAGS,
} from "../editor/shared/keys";
import { connectionId } from "../editor/shared/connectionId";
import type { StableKey } from "../editor/shared/keys";

// Handle both ESM default and CJS module shape
const traverse: typeof _traverse =
  typeof _traverse === "function"
    ? _traverse
    : (_traverse as unknown as { default: typeof _traverse }).default;

// Designator-tag -> stable-key prefix. Imported from the canonical table in
// editor/shared/keys.ts (the single source of truth) rather than duplicated
// here — a local copy is how <connector> ended up keyable in one place and not
// another.

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface ExtractedComponent {
  name: string;
  elementTag: string;
  props: Record<string, string>;
}

export interface ExtractedBoard {
  width: string;
  height: string;
  // Copper layer count from the board's `layers={N}` prop. Absent prop ⇒ 2.
  layers: number;
}

// Clamp a board layer count into the range tscircuit / circuit-json supports
// (2 outer + up to 6 inner copper layers). Kept local so tsxTransform stays
// independent of the editor's layer registry.
function clampBoardLayers(n: number): number {
  if (!Number.isFinite(n)) return 2;
  return Math.min(8, Math.max(2, Math.round(n)));
}

// One entry of a component's `connections={{ pinLabel: target }}` prop — the
// source of truth for connectivity. `target` is normalized to the compact
// selector form ("U2.SDA" / "net.V3_3"); `connId` is the content-derived
// sidecar key shared with schematicModel + authoring (see connectionId.ts).
export interface ExtractedConnection {
  owner: string;     // component `name` carrying the connections prop, e.g. "R1"
  pinLabel: string;  // the record key as authored, e.g. "pin1" | "SDA" | "anode"
  target: string;    // normalized compact selector: "U2.SDA" | "net.V3_3"
  connId: StableKey; // conn_<6hex> content id (same for both endpoints)
}

// ─── Parser helper ──────────────────────────────────────────────────────────────

function parse(tsx: string) {
  return recast.parse(tsx, { parser: babelTsParser });
}

function print(ast: ReturnType<typeof parse>): string {
  return recast.print(ast).code;
}

// ─── Parse gate ───────────────────────────────────────────────────────────────
// extractComponents() intentionally swallows parse errors and falls back to a
// regex scan, so it can't tell a caller whether the TSX is actually parseable.
// The code editor's "Apply" needs that signal: it must refuse to commit broken
// TSX to circuitStore (otherwise the canvas + history see garbage). validateTsx
// runs the real babel-ts parse and surfaces the syntax error + location.

export type TsxValidation =
  | { ok: true }
  | { ok: false; error: string; line?: number; column?: number };

export function validateTsx(tsx: string): TsxValidation {
  try {
    parse(tsx);
    return { ok: true };
  } catch (err) {
    const e = err as { message?: string; loc?: { line?: number; column?: number } };
    return {
      ok: false,
      error: e.message ?? String(err),
      line: e.loc?.line,
      column: e.loc?.column,
    };
  }
}

// ─── AST helpers ────────────────────────────────────────────────────────────────

function getJSXElementName(node: t.JSXOpeningElement): string {
  if (t.isJSXIdentifier(node.name)) return node.name.name;
  return "";
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

    // Boolean attribute (e.g., isGroundNet with no value)
    if (attr.value === null) return "true";

    // Expression we can't resolve — return the source text
    if (t.isJSXExpressionContainer(attr.value)) {
      try {
        const code = recast.print(attr.value.expression).code;
        return code;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}


function getAllProps(node: t.JSXOpeningElement): Record<string, string> {
  const props: Record<string, string> = {};
  for (const attr of node.attributes) {
    if (!t.isJSXAttribute(attr) || !t.isJSXIdentifier(attr.name)) continue;
    const name = attr.name.name;
    const val = getStringAttr(node, name);
    if (val !== undefined) props[name] = val;
  }
  return props;
}

function findBoardElement(
  ast: ReturnType<typeof parse>
): t.JSXElement | null {
  let board: t.JSXElement | null = null;
  traverse(ast, {
    JSXElement(path) {
      if (
        t.isJSXIdentifier(path.node.openingElement.name) &&
        path.node.openingElement.name.name === "board"
      ) {
        board = path.node;
        path.stop();
      }
    },
  });
  return board;
}

// Built-in tscircuit element tags that represent a placeable, footprinted part
// (something that becomes a draggable pcb_component with a designator). Derived
// from the canonical key map minus the routing tags so it can't drift from the
// key injector: a part missing here is skipped by extractComponents, never gets
// its stable `key` wired into the model, and its live drag override is ignored —
// the part only moves after the next eval (~the "J1 lags but U1 doesn't" bug).
// Uppercase-first tags (imported parts like ESP32_WROOM_32E_N4) are matched
// separately in isComponentElement, so only built-in lowercase tags are listed.
const COMPONENT_ELEMENTS = new Set(
  Object.keys(DESIGNATOR_PREFIX_BY_TAG).filter(
    (tag) => !NON_COMPONENT_KEYABLE_TAGS.has(tag)
  )
);

function isComponentElement(tagName: string): boolean {
  if (COMPONENT_ELEMENTS.has(tagName)) return true;
  // Uppercase first letter = custom React component (imported parts)
  if (tagName[0] >= "A" && tagName[0] <= "Z") return true;
  return false;
}

// ─── Read operations ────────────────────────────────────────────────────────────

export function extractComponents(tsx: string): ExtractedComponent[] {
  try {
    const ast = parse(tsx);
    const components: ExtractedComponent[] = [];

    traverse(ast, {
      JSXOpeningElement(path) {
        const tagName = getJSXElementName(path.node);
        if (!tagName || tagName === "board" || tagName === "trace") return;
        if (!isComponentElement(tagName)) return;

        const name = getStringAttr(path.node, "name");
        if (!name) return;

        components.push({
          name,
          elementTag: tagName,
          props: getAllProps(path.node),
        });
      },
    });

    return components;
  } catch {
    return extractComponentsFallback(tsx);
  }
}

// Memoized extractComponents for per-frame callers. buildPcbModel re-runs on
// every manualEdits change — i.e. every pointermove of a component drag — and
// a full Babel parse per frame dwarfs everything else on that path, while the
// tsx string is unchanged for virtually all of those calls. Single-entry cache
// keyed on the string; callers must treat the result as immutable.
let _extractCacheTsx: string | null = null;
let _extractCacheResult: ExtractedComponent[] | null = null;

export function extractComponentsCached(tsx: string): ExtractedComponent[] {
  if (_extractCacheTsx === tsx && _extractCacheResult) return _extractCacheResult;
  _extractCacheResult = extractComponents(tsx);
  _extractCacheTsx = tsx;
  return _extractCacheResult;
}

// ─── Connections (the connectivity source of truth) ──────────────────────────
//
// `connections={{ pinLabel: target }}` on a component declares connectivity:
// pin→pin (target is another pin's selector) or pin→net (target is "net.X").
// Each record entry is one independent connection. The reader is liberal: it
// accepts raw-string targets ("U2.SDA", ".U2 > .SDA", "net.V3_3") AND the
// type-safe `sel.U2.SDA` / `sel.net.V3_3` member-expression form, normalizing
// every variant to the compact "Owner.pin" / "net.NAME" string the rest of the
// system keys off.

// Accept ".X > .y", "X.y", and "net.NAME"; return the compact form. Case is
// preserved here (pin labels / net names are case-sensitive for display);
// case-folding for identity happens only inside connectionId.
export function normalizeSelectorString(raw: string): string {
  const s = raw.trim();
  const gt = s.match(/^\.?([A-Za-z_][\w]*)\s*>\s*\.?([\w]+)$/);
  if (gt) return `${gt[1]}.${gt[2]}`;
  return s.replace(/^\./, "");
}

// Flatten a `sel.U2.SDA` / `sel.net.V3_3` member expression to its identifier
// chain (["sel","U2","SDA"]). Returns null for computed/non-identifier members.
function memberChain(node: t.Node): string[] | null {
  if (t.isIdentifier(node)) return [node.name];
  if (t.isMemberExpression(node) && !node.computed) {
    const head = memberChain(node.object);
    if (!head) return null;
    if (t.isIdentifier(node.property)) return [...head, node.property.name];
  }
  return null;
}

// Normalize a connections-value AST node to a compact selector string, or
// undefined when the form is unsupported.
function normalizeConnectionTargetNode(node: t.Node): string | undefined {
  if (t.isStringLiteral(node)) return normalizeSelectorString(node.value);
  if (t.isMemberExpression(node)) {
    const chain = memberChain(node);
    if (!chain || chain.length < 2) return undefined;
    // Drop a leading `sel` if present: sel.U2.SDA -> U2.SDA, sel.net.X -> net.X
    const parts = chain[0] === "sel" ? chain.slice(1) : chain;
    if (parts.length < 2) return undefined;
    // net.X stays "net.X"; otherwise take the last two as Owner.pin.
    if (parts[0] === "net") return `net.${parts.slice(1).join(".")}`;
    return `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
  }
  return undefined;
}

function pushConnection(
  out: ExtractedConnection[],
  owner: string,
  pinLabel: string,
  target: string
): void {
  const normTarget = normalizeSelectorString(target);
  const ownerSel = `${owner}.${pinLabel}`;
  out.push({
    owner,
    pinLabel,
    target: normTarget,
    connId: connectionId(ownerSel, normTarget),
  });
}

export function extractConnections(tsx: string): ExtractedConnection[] {
  try {
    const ast = parse(tsx);
    const out: ExtractedConnection[] = [];

    traverse(ast, {
      JSXOpeningElement(path) {
        const tagName = getJSXElementName(path.node);
        if (!tagName || tagName === "board" || tagName === "trace") return;
        if (!isComponentElement(tagName)) return;
        const owner = getStringAttr(path.node, "name");
        if (!owner) return;

        for (const attr of path.node.attributes) {
          if (
            !t.isJSXAttribute(attr) ||
            !t.isJSXIdentifier(attr.name) ||
            attr.name.name !== "connections"
          )
            continue;
          if (
            !t.isJSXExpressionContainer(attr.value) ||
            !t.isObjectExpression(attr.value.expression)
          )
            continue;
          for (const prop of attr.value.expression.properties) {
            if (!t.isObjectProperty(prop)) continue;
            let pinLabel: string | undefined;
            if (t.isIdentifier(prop.key)) pinLabel = prop.key.name;
            else if (t.isStringLiteral(prop.key)) pinLabel = prop.key.value;
            if (!pinLabel) continue;

            // Value may be a single target or an array of targets (fan-out).
            if (t.isArrayExpression(prop.value)) {
              for (const el of prop.value.elements) {
                if (!el || !t.isExpression(el)) continue;
                const target = normalizeConnectionTargetNode(el);
                if (target) pushConnection(out, owner, pinLabel, target);
              }
            } else {
              const target = normalizeConnectionTargetNode(prop.value);
              if (target) pushConnection(out, owner, pinLabel, target);
            }
          }
        }
      },
    });

    return out;
  } catch {
    return extractConnectionsFallback(tsx);
  }
}

export function extractBoardConfig(tsx: string): ExtractedBoard {
  try {
    const ast = parse(tsx);
    const board = findBoardElement(ast);
    if (!board) return { width: "50mm", height: "50mm", layers: 2 };
    const rawLayers = getStringAttr(board.openingElement, "layers");
    return {
      width: getStringAttr(board.openingElement, "width") ?? "50mm",
      height: getStringAttr(board.openingElement, "height") ?? "50mm",
      layers: clampBoardLayers(rawLayers ? Number(rawLayers) : 2),
    };
  } catch {
    return extractBoardConfigFallback(tsx);
  }
}

export function extractComponentByName(
  tsx: string,
  name: string
): ExtractedComponent | null {
  const all = extractComponents(tsx);
  return all.find((c) => c.name === name) ?? null;
}

// ─── Write operations ───────────────────────────────────────────────────────────

// JSX attribute strings have no escape sequences, but recast prints a
// StringLiteral containing `"` as `\"` (unparseable) and `\` as `\\` (value
// changes on round-trip). Wrap such values in an expression container, where
// JS escaping is valid; getStringAttr reads both shapes.
function jsxAttrString(value: string): t.StringLiteral | t.JSXExpressionContainer {
  return value.includes('"') || value.includes("\\")
    ? t.jsxExpressionContainer(t.stringLiteral(value))
    : t.stringLiteral(value);
}

export function updateComponentProp(
  tsx: string,
  componentName: string,
  propName: string,
  value: string
): string {
  try {
    const ast = parse(tsx);
    let modified = false;

    traverse(ast, {
      JSXOpeningElement(path) {
        if (modified) return;
        const name = getStringAttr(path.node, "name");
        if (name !== componentName) return;

        for (const attr of path.node.attributes) {
          if (
            t.isJSXAttribute(attr) &&
            t.isJSXIdentifier(attr.name) &&
            attr.name.name === propName
          ) {
            attr.value = jsxAttrString(value);
            modified = true;
            return;
          }
        }

        // Attribute doesn't exist — add it
        const newAttr = t.jsxAttribute(
          t.jsxIdentifier(propName),
          jsxAttrString(value)
        );
        path.node.attributes.push(newAttr);
        modified = true;
      },
    });

    return modified ? print(ast) : tsx;
  } catch {
    return tsx;
  }
}

// Write `pinCount={N}` (a JSX expression container wrapping a numeric
// literal). Unlike `updateComponentProp`, this emits the right AST shape for
// numeric chip props — the regex-driven path would otherwise round-trip
// pinCount={8} as pinCount="8" (a string), which schematicModel.inferPinCount
// then has to coerce back. Adds the attribute if missing.
export function updateComponentNumericProp(
  tsx: string,
  componentName: string,
  propName: string,
  value: number
): string {
  if (!Number.isFinite(value)) return tsx;
  try {
    const ast = parse(tsx);
    let modified = false;
    const expr = t.jsxExpressionContainer(t.numericLiteral(value));

    traverse(ast, {
      JSXOpeningElement(path) {
        if (modified) return;
        const name = getStringAttr(path.node, "name");
        if (name !== componentName) return;

        for (const attr of path.node.attributes) {
          if (
            t.isJSXAttribute(attr) &&
            t.isJSXIdentifier(attr.name) &&
            attr.name.name === propName
          ) {
            attr.value = expr;
            modified = true;
            return;
          }
        }
        path.node.attributes.push(
          t.jsxAttribute(t.jsxIdentifier(propName), expr)
        );
        modified = true;
      },
    });

    return modified ? print(ast) : tsx;
  } catch {
    return tsx;
  }
}

// Write `pinLabels={{"1": "VCC", "2": "GND", ...}}` from a label array. The
// label at index i is written under key `"i+1"`. Empty/whitespace labels are
// skipped so the schematic falls back to numeric labels for un-named pins.
// Adds the attribute if missing.
export function updateComponentPinLabels(
  tsx: string,
  componentName: string,
  labels: ReadonlyArray<string>
): string {
  try {
    const ast = parse(tsx);
    let modified = false;

    const properties: t.ObjectProperty[] = [];
    for (let i = 0; i < labels.length; i++) {
      const trimmed = (labels[i] ?? "").trim();
      if (!trimmed) continue;
      properties.push(
        t.objectProperty(
          t.stringLiteral(String(i + 1)),
          t.stringLiteral(trimmed)
        )
      );
    }
    const expr = t.jsxExpressionContainer(t.objectExpression(properties));

    traverse(ast, {
      JSXOpeningElement(path) {
        if (modified) return;
        const name = getStringAttr(path.node, "name");
        if (name !== componentName) return;

        for (const attr of path.node.attributes) {
          if (
            t.isJSXAttribute(attr) &&
            t.isJSXIdentifier(attr.name) &&
            attr.name.name === "pinLabels"
          ) {
            attr.value = expr;
            modified = true;
            return;
          }
        }
        path.node.attributes.push(
          t.jsxAttribute(t.jsxIdentifier("pinLabels"), expr)
        );
        modified = true;
      },
    });

    return modified ? print(ast) : tsx;
  } catch {
    return tsx;
  }
}

export function removeComponentProp(
  tsx: string,
  componentName: string,
  propName: string
): string {
  try {
    const ast = parse(tsx);
    let modified = false;

    traverse(ast, {
      JSXOpeningElement(path) {
        if (modified) return;
        const name = getStringAttr(path.node, "name");
        if (name !== componentName) return;

        const idx = path.node.attributes.findIndex(
          (a) =>
            t.isJSXAttribute(a) &&
            t.isJSXIdentifier(a.name) &&
            a.name.name === propName
        );
        if (idx >= 0) {
          path.node.attributes.splice(idx, 1);
          modified = true;
        }
      },
    });

    return modified ? print(ast) : tsx;
  } catch {
    return tsx;
  }
}

/** Write `layer` on a component; top is the default so the prop is stripped. */
export function setComponentLayerProp(
  tsx: string,
  componentName: string,
  layer: string
): string {
  if (layer === "top") {
    return removeComponentProp(tsx, componentName, "layer");
  }
  return updateComponentProp(tsx, componentName, "layer", layer);
}

export function renameComponent(
  tsx: string,
  oldName: string,
  newName: string
): string {
  try {
    const ast = parse(tsx);
    let modified = false;

    traverse(ast, {
      JSXOpeningElement(path) {
        const tagName = getJSXElementName(path.node);

        const name = getStringAttr(path.node, "name");
        if (name === oldName) {
          for (const attr of path.node.attributes) {
            if (
              t.isJSXAttribute(attr) &&
              t.isJSXIdentifier(attr.name) &&
              attr.name.name === "name"
            ) {
              attr.value = jsxAttrString(newName);
              modified = true;
              break;
            }
          }
        }

        // Rewrite references to the renamed component. Matches the name as a
        // whole identifier, so it handles `R1.pin1`, `.R1 >`, and net names
        // are untouched. Applies to:
        //   - <trace> path[] elements AND the from/to props (PCB routes), and
        //   - `connections` string targets on ANY component (the connectivity
        //     source of truth) — without this, wires break on rename.
        const escapedOld = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const renameRe = new RegExp(`\\b${escapedOld}\\b`, "g");
        const rewriteStringLiteral = (lit: t.StringLiteral) => {
          const updated = lit.value.replace(renameRe, newName);
          if (updated !== lit.value) {
            lit.value = updated;
            modified = true;
          }
        };

        if (tagName === "trace") {
          for (const attr of path.node.attributes) {
            if (!t.isJSXAttribute(attr) || !t.isJSXIdentifier(attr.name)) continue;
            if (
              attr.name.name === "path" &&
              t.isJSXExpressionContainer(attr.value) &&
              t.isArrayExpression(attr.value.expression)
            ) {
              for (const elem of attr.value.expression.elements)
                if (t.isStringLiteral(elem)) rewriteStringLiteral(elem);
            } else if (attr.name.name === "from" || attr.name.name === "to") {
              if (t.isStringLiteral(attr.value)) rewriteStringLiteral(attr.value);
              else if (
                t.isJSXExpressionContainer(attr.value) &&
                t.isStringLiteral(attr.value.expression)
              )
                rewriteStringLiteral(attr.value.expression);
            }
          }
        }

        // Rewrite `connections` string targets referencing the old name.
        for (const attr of path.node.attributes) {
          if (
            !t.isJSXAttribute(attr) ||
            !t.isJSXIdentifier(attr.name) ||
            attr.name.name !== "connections" ||
            !t.isJSXExpressionContainer(attr.value) ||
            !t.isObjectExpression(attr.value.expression)
          )
            continue;
          for (const prop of attr.value.expression.properties) {
            if (!t.isObjectProperty(prop)) continue;
            if (t.isStringLiteral(prop.value)) rewriteStringLiteral(prop.value);
            else if (t.isArrayExpression(prop.value)) {
              for (const el of prop.value.elements)
                if (t.isStringLiteral(el)) rewriteStringLiteral(el);
            }
          }
        }
      },
    });

    return modified ? print(ast) : tsx;
  } catch {
    return tsx;
  }
}

export function addComponentElement(tsx: string, jsxSnippet: string): string {
  try {
    const snippetAst = parse(`<board>${jsxSnippet}</board>`);
    let snippetElement: t.JSXElement | null = null;
    traverse(snippetAst, {
      JSXElement(path) {
        if (
          t.isJSXIdentifier(path.node.openingElement.name) &&
          path.node.openingElement.name.name === "board"
        ) {
          for (const child of path.node.children) {
            if (t.isJSXElement(child)) {
              snippetElement = child;
              break;
            }
          }
          path.stop();
        }
      },
    });

    if (!snippetElement) return tsx;

    // Ensure the inserted element carries a stable key, and that it doesn't
    // collide with an existing one. We avoid mutating the caller's snippet
    // string — keys are added at the AST level.
    const existingKeys = collectKeysOrEmpty(tsx);
    ensureKeyOnElement(snippetElement, existingKeys);

    const ast = parse(tsx);
    const board = findBoardElement(ast);
    if (!board) return tsx;

    // Add newline + indent before the element
    board.children.push(
      t.jsxText("\n    "),
      snippetElement,
    );

    // Ensure there's a newline before the closing tag
    const last = board.children[board.children.length - 1];
    if (!t.isJSXText(last) || !last.value.endsWith("\n  ")) {
      board.children.push(t.jsxText("\n  "));
    }

    return print(ast);
  } catch {
    // Fallback: insert before </board> using string manipulation. We don't
    // try to inject a key here — fallback only runs when AST parsing failed,
    // which means the user's tsx is already broken; the next reparse will
    // pick the snippet up and add a key during the migration pass.
    const boardCloseIdx = tsx.lastIndexOf("</board>");
    if (boardCloseIdx === -1) return tsx;
    return (
      tsx.slice(0, boardCloseIdx) +
      `    ${jsxSnippet.trim()}\n  ` +
      tsx.slice(boardCloseIdx)
    );
  }
}

// If `el` is missing a valid key="..." prop OR carries one that already
// exists in `existingKeys`, replace it with a freshly-generated unique key.
// Mutates the AST node in-place (caller already owns it). A valid + UNIQUE
// existing key is preserved (idempotent for clean snippets).
//
// The collision check matters because a copy-paste from the AI can produce
// snippets like `<resistor key="r_alpha1" name="R2" />` even when r_alpha1
// already exists in the destination tsx; without the check, the new element
// would silently share sidecar identity with the original.
function ensureKeyOnElement(
  el: t.JSXElement,
  existingKeys: Set<string>
): void {
  const opener = el.openingElement;
  if (!t.isJSXIdentifier(opener.name)) return;
  const tag = opener.name.name;
  if (tag === "board") return;

  let currentKey: string | undefined;
  let keyAttrIdx = -1;
  opener.attributes.forEach((attr, idx) => {
    if (
      !t.isJSXAttribute(attr) ||
      !t.isJSXIdentifier(attr.name) ||
      attr.name.name !== "key"
    )
      return;
    keyAttrIdx = idx;
    if (t.isStringLiteral(attr.value)) currentKey = attr.value.value;
    else if (
      t.isJSXExpressionContainer(attr.value) &&
      t.isStringLiteral(attr.value.expression)
    )
      currentKey = attr.value.expression.value;
  });

  // Keep the existing key only if it's both valid AND not a collision.
  if (validateKey(currentKey) && !existingKeys.has(currentKey)) {
    existingKeys.add(currentKey);
    return;
  }

  const prefix = DESIGNATOR_PREFIX_BY_TAG[tag] ?? "x";
  const newKey = generateStableKey(prefix, existingKeys);
  existingKeys.add(newKey);

  const newAttr = t.jsxAttribute(
    t.jsxIdentifier("key"),
    t.stringLiteral(newKey)
  );
  if (keyAttrIdx >= 0) {
    opener.attributes.splice(keyAttrIdx, 1, newAttr);
  } else {
    opener.attributes.unshift(newAttr);
  }
}

export function removeComponentElement(
  tsx: string,
  componentName: string
): string {
  try {
    const ast = parse(tsx);
    let modified = false;

    traverse(ast, {
      JSXElement(path) {
        const tagName = getJSXElementName(path.node.openingElement);
        if (tagName === "board") return;

        const name = getStringAttr(path.node.openingElement, "name");
        // Remove the component element itself.
        if (name === componentName) {
          path.remove();
          modified = true;
          return;
        }
        // Prune connections entries on OTHER components that target the
        // removed component, so we don't leave dangling selectors.
        if (name && isComponentElement(tagName)) {
          if (pruneConnectionsTargeting(path.node.openingElement, componentName))
            modified = true;
        }
      },
    });

    return modified ? print(ast) : tsx;
  } catch {
    return tsx;
  }
}

// ─── Connections write machinery ──────────────────────────────────────────────
//
// These upsert/remove entries in a component's `connections={{ ... }}` prop —
// the connectivity source of truth. Values are always emitted as raw string
// selectors (decision: emit raw, parse both raw + sel.X.Y).

function objectPropKeyName(prop: t.ObjectProperty): string | undefined {
  if (t.isIdentifier(prop.key)) return prop.key.name;
  if (t.isStringLiteral(prop.key)) return prop.key.value;
  return undefined;
}

// True if a selector string's owner is `name` (e.g. "R1.pin1" / ".R1 > .pin1"
// reference R1). Net targets ("net.X") never match a component name.
function selectorRefsComponent(sel: string, name: string): boolean {
  return splitSelector(normalizeSelectorString(sel)).owner === name;
}

// In-place: remove any `connections` entry on `opening` whose target selector
// references component `name`. Returns true if anything was removed. Drops the
// whole connections attr if it becomes empty.
function pruneConnectionsTargeting(
  opening: t.JSXOpeningElement,
  name: string
): boolean {
  const idx = opening.attributes.findIndex(
    (a) =>
      t.isJSXAttribute(a) &&
      t.isJSXIdentifier(a.name) &&
      a.name.name === "connections"
  );
  if (idx < 0) return false;
  const attr = opening.attributes[idx] as t.JSXAttribute;
  if (
    !t.isJSXExpressionContainer(attr.value) ||
    !t.isObjectExpression(attr.value.expression)
  )
    return false;
  const obj = attr.value.expression;
  const before = obj.properties.length;
  obj.properties = obj.properties.filter((p) => {
    if (!t.isObjectProperty(p)) return true;
    const target = normalizeConnectionTargetNode(p.value);
    return !(target && selectorRefsComponent(target, name));
  });
  if (obj.properties.length === before) return false;
  if (obj.properties.length === 0) opening.attributes.splice(idx, 1);
  return true;
}

// Split a compact "Owner.pin" selector into its parts (last dot wins). Returns
// empty strings for malformed input.
function splitSelector(sel: string): { owner: string; pin: string } {
  const i = sel.lastIndexOf(".");
  if (i <= 0) return { owner: "", pin: "" };
  return { owner: sel.slice(0, i), pin: sel.slice(i + 1) };
}

// Upsert `connections[pinLabel] = target` on the component named `ownerName`.
// Creates the connections prop if absent. `target` must be compact
// ("U2.SDA" / "net.V3_3"); it is emitted as a raw string literal.
export function setComponentConnection(
  tsx: string,
  ownerName: string,
  pinLabel: string,
  target: string
): string {
  try {
    const ast = parse(tsx);
    let modified = false;
    traverse(ast, {
      JSXOpeningElement(path) {
        if (modified) return;
        const tag = getJSXElementName(path.node);
        if (!isComponentElement(tag)) return;
        if (getStringAttr(path.node, "name") !== ownerName) return;

        const keyNode = t.isValidIdentifier(pinLabel)
          ? t.identifier(pinLabel)
          : t.stringLiteral(pinLabel);
        const newProp = t.objectProperty(keyNode, t.stringLiteral(target));

        const connAttr = path.node.attributes.find(
          (a): a is t.JSXAttribute =>
            t.isJSXAttribute(a) &&
            t.isJSXIdentifier(a.name) &&
            a.name.name === "connections"
        );
        if (!connAttr) {
          path.node.attributes.push(
            t.jsxAttribute(
              t.jsxIdentifier("connections"),
              t.jsxExpressionContainer(t.objectExpression([newProp]))
            )
          );
          modified = true;
        } else if (
          t.isJSXExpressionContainer(connAttr.value) &&
          t.isObjectExpression(connAttr.value.expression)
        ) {
          const obj = connAttr.value.expression;
          const existing = obj.properties.find(
            (p): p is t.ObjectProperty =>
              t.isObjectProperty(p) && objectPropKeyName(p) === pinLabel
          );
          if (existing) existing.value = t.stringLiteral(target);
          else obj.properties.push(newProp);
          modified = true;
        }
        path.stop();
      },
    });
    return modified ? print(ast) : tsx;
  } catch {
    return tsx;
  }
}

// Remove `connections[pinLabel]` from `ownerName`; drop the whole connections
// prop when it becomes empty.
export function removeComponentConnection(
  tsx: string,
  ownerName: string,
  pinLabel: string
): string {
  try {
    const ast = parse(tsx);
    let modified = false;
    traverse(ast, {
      JSXOpeningElement(path) {
        if (modified) return;
        if (getStringAttr(path.node, "name") !== ownerName) return;
        const idx = path.node.attributes.findIndex(
          (a) =>
            t.isJSXAttribute(a) &&
            t.isJSXIdentifier(a.name) &&
            a.name.name === "connections"
        );
        if (idx < 0) return;
        const connAttr = path.node.attributes[idx] as t.JSXAttribute;
        if (
          !t.isJSXExpressionContainer(connAttr.value) ||
          !t.isObjectExpression(connAttr.value.expression)
        )
          return;
        const obj = connAttr.value.expression;
        const before = obj.properties.length;
        obj.properties = obj.properties.filter(
          (p) => !(t.isObjectProperty(p) && objectPropKeyName(p) === pinLabel)
        );
        if (obj.properties.length !== before) modified = true;
        if (obj.properties.length === 0) path.node.attributes.splice(idx, 1);
        path.stop();
      },
    });
    return modified ? print(ast) : tsx;
  } catch {
    return tsx;
  }
}

// Mint a unique net name from a pin label. Sanitizes to a valid identifier
// (uppercase, non-alnum → `_`, digit-leading → `N` prefix). Generic numeric
// pin labels (pin1, p2, …) are treated as unusable and fall back to `N<i>`.
// Uniqueness is checked against existing `net.*` connection targets and
// `<net name="...">` elements.
export function mintNetName(tsx: string, baseLabel: string): string {
  const used = new Set<string>();
  for (const c of extractConnections(tsx)) {
    const m = /^net\.(.+)$/.exec(c.target);
    if (m) used.add(m[1]);
  }
  for (const comp of extractComponents(tsx)) {
    if (comp.elementTag === "net" && comp.name) used.add(comp.name);
  }

  const usable =
    baseLabel && !/^(pin|p)\d+$/i.test(baseLabel.trim());
  let base = "";
  if (usable) {
    base = baseLabel.trim().replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
    if (/^[0-9]/.test(base)) base = `N${base}`;
  }

  if (base) {
    if (!used.has(base)) return base;
    let i = 1;
    while (used.has(`${base}_${i}`)) i++;
    return `${base}_${i}`;
  }
  let i = 1;
  while (used.has(`N${i}`)) i++;
  return `N${i}`;
}

// Promote three pins onto one minted net: removes any existing pin→pin entry
// among the endpoints, then writes a pin→net entry (`net.<netName>`) for each.
// Endpoints are compact "Owner.pin" selectors.
export function promoteToNet(
  tsx: string,
  selA: string,
  selB: string,
  selC: string,
  netName: string
): string {
  const eps = [selA, selB, selC].map(normalizeSelectorString);
  const netTarget = `net.${netName}`;
  let out = tsx;
  // Remove whichever endpoint currently stores the pin→pin entry (single-side
  // storage means only one of these removes anything; the rest are no-ops).
  for (const ep of eps) {
    const { owner, pin } = splitSelector(ep);
    if (owner && pin) out = removeComponentConnection(out, owner, pin);
  }
  for (const ep of eps) {
    const { owner, pin } = splitSelector(ep);
    if (owner && pin) out = setComponentConnection(out, owner, pin, netTarget);
  }
  return out;
}

export function updateBoardDimensions(
  tsx: string,
  width: string,
  height: string
): string {
  try {
    const ast = parse(tsx);
    const board = findBoardElement(ast);
    if (!board) return tsx;

    let modified = false;
    for (const attr of board.openingElement.attributes) {
      if (!t.isJSXAttribute(attr) || !t.isJSXIdentifier(attr.name)) continue;
      if (attr.name.name === "width") {
        attr.value = jsxAttrString(width);
        modified = true;
      }
      if (attr.name.name === "height") {
        attr.value = jsxAttrString(height);
        modified = true;
      }
    }

    return modified ? print(ast) : tsx;
  } catch {
    return tsx;
  }
}

// Set the board's copper layer count via the `layers={N}` prop. Passing 2
// (the tscircuit default) removes the prop to keep the tsx clean; any other
// value (4, 6, 8, …) is written as a numeric JSX expression. No-ops when the
// board already matches.
export function updateBoardLayers(tsx: string, layers: number): string {
  const n = clampBoardLayers(layers);
  try {
    const ast = parse(tsx);
    const board = findBoardElement(ast);
    if (!board) return tsx;

    const attrs = board.openingElement.attributes;
    const idx = attrs.findIndex(
      (a) =>
        t.isJSXAttribute(a) &&
        t.isJSXIdentifier(a.name) &&
        a.name.name === "layers"
    );

    if (n === 2) {
      // Default — strip the explicit prop if present.
      if (idx === -1) return tsx;
      attrs.splice(idx, 1);
      return print(ast);
    }

    const value = t.jsxExpressionContainer(t.numericLiteral(n));
    if (idx === -1) {
      attrs.push(t.jsxAttribute(t.jsxIdentifier("layers"), value));
    } else {
      const existing = attrs[idx];
      if (!t.isJSXAttribute(existing)) return tsx;
      existing.value = value;
    }
    return print(ast);
  } catch {
    return tsx;
  }
}

// ─── Regex-based fallbacks (for environments where AST parsing fails) ──────────

function extractComponentsFallback(tsx: string): ExtractedComponent[] {
  const components: ExtractedComponent[] = [];
  const tagPattern = /<(\w+)\s+([^>]*?)\/>/g;
  let match;
  while ((match = tagPattern.exec(tsx)) !== null) {
    const tag = match[1];
    const attrString = match[2];
    if (tag === "board" || tag === "trace") continue;
    if (!isComponentElement(tag)) continue;

    const nameMatch = attrString.match(/name="([^"]*)"/);
    if (!nameMatch) continue;

    const props: Record<string, string> = {};
    const attrPattern = /(\w+)="([^"]*)"/g;
    let attrMatch;
    while ((attrMatch = attrPattern.exec(attrString)) !== null) {
      props[attrMatch[1]] = attrMatch[2];
    }
    const boolPattern = /\b(\w+)(?=\s|\/|>)/g;
    let boolMatch;
    while ((boolMatch = boolPattern.exec(attrString)) !== null) {
      if (!(boolMatch[1] in props)) props[boolMatch[1]] = "true";
    }
    const exprPattern = /(\w+)=\{([^}]*)}/g;
    let exprMatch;
    while ((exprMatch = exprPattern.exec(attrString)) !== null) {
      if (!(exprMatch[1] in props)) props[exprMatch[1]] = exprMatch[2];
    }

    components.push({ name: nameMatch[1], elementTag: tag, props });
  }
  return components;
}

// Regex fallback for extractConnections — only runs when the AST parse throws.
// Scans self-closing component tags that carry a `connections={{ ... }}` object
// and pulls each entry, handling both raw-string targets and the `sel.X.Y` form.
function extractConnectionsFallback(tsx: string): ExtractedConnection[] {
  const out: ExtractedConnection[] = [];
  // Self-closing tags with a connections prop. Capture the whole tag attr span.
  const tagPattern = /<(\w+)\b([^>]*?)\/>/g;
  let m: RegExpExecArray | null;
  while ((m = tagPattern.exec(tsx)) !== null) {
    const tag = m[1];
    const attrs = m[2];
    if (tag === "trace" || tag === "board" || !isComponentElement(tag)) continue;
    const nameMatch = attrs.match(/\bname="([^"]+)"/);
    const connMatch = attrs.match(/\bconnections=\{\{([\s\S]*?)\}\}/);
    if (!nameMatch || !connMatch) continue;
    const owner = nameMatch[1];
    const body = connMatch[1];
    const entryRe =
      /(['"]?)([A-Za-z_]\w*)\1\s*:\s*(?:"([^"]+)"|sel\.([\w.]+))/g;
    let e: RegExpExecArray | null;
    while ((e = entryRe.exec(body)) !== null) {
      const pinLabel = e[2];
      let target: string | undefined;
      if (e[3] !== undefined) {
        target = e[3];
      } else if (e[4] !== undefined) {
        // sel.U2.SDA / sel.net.V3_3 → compact form
        const parts = e[4].split(".");
        if (parts[0] === "net") target = `net.${parts.slice(1).join(".")}`;
        else if (parts.length >= 2)
          target = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
      }
      if (target) pushConnection(out, owner, pinLabel, target);
    }
  }
  return out;
}

function extractBoardConfigFallback(tsx: string): ExtractedBoard {
  const widthMatch = tsx.match(/<board[^>]*\swidth="([^"]*)"/);
  const heightMatch = tsx.match(/<board[^>]*\sheight="([^"]*)"/);
  const layersMatch = tsx.match(/<board[^>]*\slayers=\{?\s*(\d+)/);
  return {
    width: widthMatch?.[1] ?? "50mm",
    height: heightMatch?.[1] ?? "50mm",
    layers: clampBoardLayers(layersMatch ? Number(layersMatch[1]) : 2),
  };
}

// ─── Default empty TSX ─────────────────────────────────────────────────────────

export const DEFAULT_TSX = `export default () => (
  <board width="50mm" height="50mm">
  </board>
)
`;
