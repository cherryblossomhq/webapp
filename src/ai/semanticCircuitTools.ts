import * as recast from "recast";
import * as babelTsParser from "recast/parsers/babel-ts";
import _traverse from "@babel/traverse";
import * as t from "@babel/types";
import {
  addComponentElement,
  extractBoardConfig,
  extractComponentByName,
  extractComponents,
  extractConnections,
  normalizeSelectorString,
  removeComponentConnection,
  removeComponentElement,
  removeComponentProp,
  setComponentConnection,
  updateBoardDimensions,
  updateBoardLayers,
  updateComponentValueProp,
  validateTsx,
  type ComponentPropValue,
} from "../utils/tsxTransform";
import {
  isAiPlaceableComponentTag,
  isValidJsxPropName,
  isValidNetName,
  isValidPinLabel,
} from "./tscircuitCapabilities";

const traverse: typeof _traverse =
  typeof _traverse === "function"
    ? _traverse
    : (_traverse as unknown as { default: typeof _traverse }).default;

export const SEMANTIC_CIRCUIT_TOOL_NAMES = [
  "inspect_circuit",
  "add_component",
  "update_component",
  "remove_component",
  "connect_pins",
  "disconnect_pin",
  "set_board",
] as const;

export type SemanticCircuitToolName =
  (typeof SEMANTIC_CIRCUIT_TOOL_NAMES)[number];

const JSON_PROPS_SCHEMA = {
  type: "object",
  description:
    "Documented tscircuit props as JSON values. Do not include name, key, or connections. For chip, include pinLabels here before wiring it.",
  additionalProperties: true,
};

/** Model-facing definitions. These operate on the loop-local draft, not the live board. */
export const SEMANTIC_CIRCUIT_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "inspect_circuit",
      description:
        "Read a compact structured manifest of the working circuit: board settings, components, props, and connections. Use this when you need exact current state before targeted edits.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "add_component",
      description:
        "Add one component to the working circuit using a documented tscircuit tag and typed props. A stable key is generated automatically. For arbitrary devices use tag=chip with pinLabels; imported parts may use the exact uppercase tag returned by import_component.",
      parameters: {
        type: "object",
        properties: {
          tag: {
            type: "string",
            description:
              "A documented builtin such as resistor, capacitor, mosfet, connector, pinheader, or chip; or an imported uppercase tag.",
          },
          name: { type: "string", description: "Unique designator, e.g. R1, U2, J1." },
          props: JSON_PROPS_SCHEMA,
        },
        required: ["tag", "name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "update_component",
      description:
        "Update typed props, remove props, or rename one existing component. Stable keys, placement, and connection references are preserved unless explicitly changed. Prefer this over raw TSX replacement for component edits.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Current component designator." },
          new_name: { type: "string", description: "Optional new unique designator." },
          props: JSON_PROPS_SCHEMA,
          delete_props: {
            type: "array",
            items: { type: "string" },
            description: "Optional prop names to remove.",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "remove_component",
      description:
        "Remove one component by designator and prune authored connections that target it.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Component designator." } },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "connect_pins",
      description:
        "Author one connection on a component. Define chip pinLabels first. Use Component.pin for a point-to-point connection or net.NAME for shared rails and multi-pin nets.",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string", description: "Component carrying the connections prop." },
          pin: { type: "string", description: "That component's documented pin label." },
          target: { type: "string", description: "Another Component.pin or a named net.NAME." },
        },
        required: ["owner", "pin", "target"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "disconnect_pin",
      description: "Remove one authored connection from a component pin.",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string", description: "Component carrying the connection." },
          pin: { type: "string", description: "Pin label to disconnect." },
        },
        required: ["owner", "pin"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "set_board",
      description:
        "Update board width, height, or copper-layer count without rewriting components.",
      parameters: {
        type: "object",
        properties: {
          width: { type: "string", description: "Physical width with units, e.g. 50mm." },
          height: { type: "string", description: "Physical height with units, e.g. 40mm." },
          layers: { type: "integer", enum: [2, 4, 6, 8] },
        },
        additionalProperties: false,
      },
    },
  },
];

export interface SemanticCircuitToolResult {
  ok: boolean;
  edited: boolean;
  tsx: string;
  content: string;
  activity: string;
}

const COMPONENT_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
const FORBIDDEN_DIRECT_PROPS = new Set(["name", "key", "connections"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isComponentPropValue(value: unknown): value is ComponentPropValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isComponentPropValue);
  return (
    isRecord(value) && Object.values(value).every(isComponentPropValue)
  );
}

function stringInput(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value.trim() : "";
}

function fail(tsx: string, content: string): SemanticCircuitToolResult {
  return { ok: false, edited: false, tsx, content: `Error: ${content}`, activity: "" };
}

function success(
  tsx: string,
  content: string,
  activity: string,
  edited: boolean
): SemanticCircuitToolResult {
  return { ok: true, edited, tsx, content, activity };
}

function validComponentTag(tag: string): boolean {
  return isAiPlaceableComponentTag(tag) || /^[A-Z][A-Za-z0-9_]*$/.test(tag);
}

function parseCircuitTsx(tsx: string) {
  return recast.parse(tsx, { parser: babelTsParser });
}

function printCircuitTsx(ast: ReturnType<typeof parseCircuitTsx>): string {
  return recast.print(ast).code;
}

function stringAttr(
  opening: t.JSXOpeningElement,
  attrName: string
): string | undefined {
  const attr = opening.attributes.find(
    (candidate): candidate is t.JSXAttribute =>
      t.isJSXAttribute(candidate) &&
      t.isJSXIdentifier(candidate.name) &&
      candidate.name.name === attrName
  );
  if (!attr) return undefined;
  if (t.isStringLiteral(attr.value)) return attr.value.value;
  if (
    t.isJSXExpressionContainer(attr.value) &&
    t.isStringLiteral(attr.value.expression)
  ) {
    return attr.value.expression.value;
  }
  return undefined;
}

function memberChain(node: t.Node): string[] | null {
  if (t.isIdentifier(node)) return [node.name];
  if (t.isMemberExpression(node) && !node.computed) {
    const head = memberChain(node.object);
    if (head && t.isIdentifier(node.property)) {
      return [...head, node.property.name];
    }
  }
  return null;
}

function memberExpressionFromChain(chain: readonly string[]): t.Expression {
  let expression: t.Expression = t.identifier(chain[0]);
  for (const part of chain.slice(1)) {
    expression = t.memberExpression(expression, t.identifier(part));
  }
  return expression;
}

function selectorOwnerFromString(raw: string): string | null {
  const normalized = normalizeSelectorString(raw);
  if (normalized.startsWith("net.")) return null;
  const dot = normalized.lastIndexOf(".");
  return dot > 0 ? normalized.slice(0, dot) : null;
}

function selectorOwnerFromMember(node: t.MemberExpression): string | null {
  const chain = memberChain(node);
  if (!chain) return null;
  const selector = chain[0] === "sel" ? chain.slice(1) : chain;
  if (selector.length < 2 || selector[0] === "net") return null;
  return selector[selector.length - 2];
}

function selectorOwner(node: t.Expression): string | null {
  if (t.isStringLiteral(node)) return selectorOwnerFromString(node.value);
  if (t.isMemberExpression(node)) return selectorOwnerFromMember(node);
  return null;
}

function renameSelectorString(
  raw: string,
  oldName: string,
  newName: string
): string {
  if (selectorOwnerFromString(raw) !== oldName) return raw;
  const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return raw.replace(
    new RegExp(`^(\\s*\\.?)${escaped}(?=(?:\\s*>\\s*\\.?|\\.))`),
    `$1${newName}`
  );
}

function renameSelectorExpression(
  value: t.Expression,
  oldName: string,
  newName: string
): t.Expression {
  if (t.isStringLiteral(value)) {
    const renamed = renameSelectorString(value.value, oldName, newName);
    return renamed === value.value ? value : t.stringLiteral(renamed);
  }
  if (t.isMemberExpression(value)) {
    if (selectorOwnerFromMember(value) !== oldName) return value;
    const chain = memberChain(value);
    if (!chain) return value;
    const renamed = [...chain];
    renamed[renamed.length - 2] = newName;
    return memberExpressionFromChain(renamed);
  }
  if (t.isArrayExpression(value)) {
    let modified = false;
    const elements = value.elements.map((element) => {
      if (!element || !t.isExpression(element)) return element;
      const renamed = renameSelectorExpression(element, oldName, newName);
      if (renamed !== element) modified = true;
      return renamed;
    });
    return modified ? t.arrayExpression(elements) : value;
  }
  return value;
}

function renameComponentAndSelectors(
  tsx: string,
  oldName: string,
  newName: string
): string {
  try {
    const ast = parseCircuitTsx(tsx);
    let modified = false;
    traverse(ast, {
      JSXOpeningElement(path) {
        const opening = path.node;
        if (stringAttr(opening, "name") === oldName) {
          const attr = opening.attributes.find(
            (candidate): candidate is t.JSXAttribute =>
              t.isJSXAttribute(candidate) &&
              t.isJSXIdentifier(candidate.name) &&
              candidate.name.name === "name"
          );
          if (attr) {
            attr.value = t.stringLiteral(newName);
            modified = true;
          }
        }

        const tag = t.isJSXIdentifier(opening.name) ? opening.name.name : "";
        for (const attr of opening.attributes) {
          if (
            !t.isJSXAttribute(attr) ||
            !t.isJSXIdentifier(attr.name)
          ) {
            continue;
          }
          if (attr.name.name === "connections") {
            if (
              !t.isJSXExpressionContainer(attr.value) ||
              !t.isObjectExpression(attr.value.expression)
            ) {
              continue;
            }
            for (const prop of attr.value.expression.properties) {
              if (!t.isObjectProperty(prop) || !t.isExpression(prop.value)) continue;
              const renamed = renameSelectorExpression(prop.value, oldName, newName);
              if (renamed !== prop.value) {
                prop.value = renamed;
                modified = true;
              }
            }
            continue;
          }
          if (
            tag === "trace" &&
            (attr.name.name === "path" ||
              attr.name.name === "from" ||
              attr.name.name === "to")
          ) {
            if (t.isStringLiteral(attr.value)) {
              const renamed = renameSelectorString(
                attr.value.value,
                oldName,
                newName
              );
              if (renamed !== attr.value.value) {
                attr.value = t.stringLiteral(renamed);
                modified = true;
              }
            } else if (
              t.isJSXExpressionContainer(attr.value) &&
              t.isExpression(attr.value.expression)
            ) {
              const renamed = renameSelectorExpression(
                attr.value.expression,
                oldName,
                newName
              );
              if (renamed !== attr.value.expression) {
                attr.value.expression = renamed;
                modified = true;
              }
            }
          }
        }
      },
    });
    return modified ? printCircuitTsx(ast) : tsx;
  } catch {
    return tsx;
  }
}

function pruneFanOutTargets(tsx: string, removedName: string): string {
  try {
    const ast = parseCircuitTsx(tsx);
    let modified = false;
    traverse(ast, {
      JSXOpeningElement(path) {
        const opening = path.node;
        const attrIndex = opening.attributes.findIndex(
          (candidate) =>
            t.isJSXAttribute(candidate) &&
            t.isJSXIdentifier(candidate.name) &&
            candidate.name.name === "connections"
        );
        if (attrIndex < 0) return;
        const attr = opening.attributes[attrIndex];
        if (
          !t.isJSXAttribute(attr) ||
          !t.isJSXExpressionContainer(attr.value) ||
          !t.isObjectExpression(attr.value.expression)
        ) {
          return;
        }
        const connections = attr.value.expression;
        connections.properties = connections.properties.filter((prop) => {
          if (!t.isObjectProperty(prop) || !t.isArrayExpression(prop.value)) {
            return true;
          }
          const kept = prop.value.elements.filter(
            (element) =>
              !element ||
              !t.isExpression(element) ||
              selectorOwner(element) !== removedName
          );
          if (kept.length === prop.value.elements.length) return true;
          prop.value.elements = kept;
          modified = true;
          return kept.length > 0;
        });
        if (connections.properties.length === 0) {
          opening.attributes.splice(attrIndex, 1);
          modified = true;
        }
      },
    });
    return modified ? printCircuitTsx(ast) : tsx;
  } catch {
    return tsx;
  }
}

function validateProps(
  props: unknown
): { ok: true; value: Record<string, ComponentPropValue> } | { ok: false; error: string } {
  if (props === undefined) return { ok: true, value: {} };
  if (!isRecord(props)) return { ok: false, error: "props must be an object" };
  const clean: Record<string, ComponentPropValue> = {};
  for (const [name, value] of Object.entries(props)) {
    if (!isValidJsxPropName(name)) {
      return { ok: false, error: `invalid JSX prop name: ${name}` };
    }
    if (FORBIDDEN_DIRECT_PROPS.has(name)) {
      return {
        ok: false,
        error: `${name} is managed by a dedicated semantic field/tool`,
      };
    }
    if (!isComponentPropValue(value)) {
      return { ok: false, error: `${name} must be a finite JSON value` };
    }
    clean[name] = value;
  }
  return { ok: true, value: clean };
}

function propToJsx(name: string, value: ComponentPropValue): string {
  if (typeof value === "string") return `${name}=${JSON.stringify(value)}`;
  return `${name}={${JSON.stringify(value)}}`;
}

function inspectCircuit(tsx: string): SemanticCircuitToolResult {
  const manifest = {
    board: extractBoardConfig(tsx),
    components: extractComponents(tsx).map((component) => ({
      name: component.name,
      tag: component.elementTag,
      props: component.props,
    })),
    connections: extractConnections(tsx).map(({ owner, pinLabel, target }) => ({
      from: `${owner}.${pinLabel}`,
      to: target,
    })),
  };
  return success(
    tsx,
    JSON.stringify(manifest, null, 2),
    `Inspected ${manifest.components.length} component${manifest.components.length === 1 ? "" : "s"}`,
    false
  );
}

function addComponent(
  tsx: string,
  input: Record<string, unknown>
): SemanticCircuitToolResult {
  const tag = stringInput(input, "tag");
  const name = stringInput(input, "name");
  if (!validComponentTag(tag)) {
    return fail(
      tsx,
      `unsupported component tag ${JSON.stringify(tag)}; use a documented builtin, <chip>, or an imported uppercase tag`
    );
  }
  if (!COMPONENT_NAME.test(name)) return fail(tsx, "name must be a valid designator");
  if (extractComponentByName(tsx, name)) {
    return fail(tsx, `a component named ${name} already exists`);
  }
  const props = validateProps(input.props);
  if (!props.ok) return fail(tsx, props.error);
  if (
    tag === "chip" &&
    (!isRecord(props.value.pinLabels) ||
      Object.keys(props.value.pinLabels).length === 0)
  ) {
    return fail(tsx, "chip requires non-empty pinLabels before it can be added");
  }

  const attributes = Object.entries(props.value).map(([prop, value]) =>
    propToJsx(prop, value)
  );
  const snippet = `<${tag} name=${JSON.stringify(name)}${
    attributes.length ? ` ${attributes.join(" ")}` : ""
  } />`;
  const next = addComponentElement(tsx, snippet);
  if (next === tsx) return fail(tsx, `could not add ${name} to the board`);
  return success(
    next,
    `Added ${name} as <${tag}>. The working circuit now includes the component with a stable key.`,
    `Added ${name}`,
    true
  );
}

function updateComponent(
  tsx: string,
  input: Record<string, unknown>
): SemanticCircuitToolResult {
  const name = stringInput(input, "name");
  if (!extractComponentByName(tsx, name)) return fail(tsx, `component ${name} was not found`);
  const props = validateProps(input.props);
  if (!props.ok) return fail(tsx, props.error);
  const deleteProps = Array.isArray(input.delete_props)
    ? input.delete_props.filter((value): value is string => typeof value === "string")
    : [];
  for (const prop of deleteProps) {
    if (!isValidJsxPropName(prop) || FORBIDDEN_DIRECT_PROPS.has(prop)) {
      return fail(tsx, `cannot delete managed or invalid prop ${JSON.stringify(prop)}`);
    }
  }
  const newName = stringInput(input, "new_name");
  if (newName && !COMPONENT_NAME.test(newName)) {
    return fail(tsx, "new_name must be a valid designator");
  }
  if (newName && newName !== name && extractComponentByName(tsx, newName)) {
    return fail(tsx, `a component named ${newName} already exists`);
  }
  if (!newName && Object.keys(props.value).length === 0 && deleteProps.length === 0) {
    return fail(tsx, "update_component requires props, delete_props, or new_name");
  }

  let next = tsx;
  for (const prop of deleteProps) next = removeComponentProp(next, name, prop);
  for (const [prop, value] of Object.entries(props.value)) {
    next = updateComponentValueProp(next, name, prop, value);
  }
  if (newName && newName !== name) {
    next = renameComponentAndSelectors(next, name, newName);
  }
  if (next === tsx) return fail(tsx, `the requested update did not change ${name}`);
  const finalName = newName || name;
  return success(
    next,
    `Updated ${finalName}. Existing stable keys and references were preserved.`,
    `Updated ${finalName}`,
    true
  );
}

function removeComponent(
  tsx: string,
  input: Record<string, unknown>
): SemanticCircuitToolResult {
  const name = stringInput(input, "name");
  if (!extractComponentByName(tsx, name)) return fail(tsx, `component ${name} was not found`);
  const pruned = pruneFanOutTargets(tsx, name);
  const next = removeComponentElement(pruned, name);
  if (next === tsx) return fail(tsx, `could not remove ${name}`);
  return success(
    next,
    `Removed ${name} and pruned connections that referenced it.`,
    `Removed ${name}`,
    true
  );
}

function normalizeConnectionTarget(
  tsx: string,
  rawTarget: string
): { ok: true; target: string } | { ok: false; error: string } {
  const target = normalizeSelectorString(rawTarget);
  const netMatch = /^net\.(.+)$/.exec(target);
  if (netMatch && isValidNetName(netMatch[1])) {
    return { ok: true, target };
  }
  const match = /^([A-Za-z][A-Za-z0-9_-]*)\.(.+)$/.exec(target);
  if (!match || !isValidPinLabel(match[2])) {
    return { ok: false, error: "target must be Component.pin or net.NAME" };
  }
  if (!extractComponentByName(tsx, match[1])) {
    return { ok: false, error: `target component ${match[1]} was not found` };
  }
  return { ok: true, target };
}

function connectPins(
  tsx: string,
  input: Record<string, unknown>
): SemanticCircuitToolResult {
  const owner = stringInput(input, "owner");
  const pin = stringInput(input, "pin");
  if (!extractComponentByName(tsx, owner)) return fail(tsx, `component ${owner} was not found`);
  if (!isValidPinLabel(pin)) return fail(tsx, "pin must be a valid pin label");
  const normalized = normalizeConnectionTarget(tsx, stringInput(input, "target"));
  if (!normalized.ok) return fail(tsx, normalized.error);
  const next = setComponentConnection(tsx, owner, pin, normalized.target);
  if (next === tsx) return fail(tsx, `could not connect ${owner}.${pin}`);
  return success(
    next,
    `Connected ${owner}.${pin} to ${normalized.target}.`,
    `Connected ${owner}.${pin}`,
    true
  );
}

function disconnectPin(
  tsx: string,
  input: Record<string, unknown>
): SemanticCircuitToolResult {
  const owner = stringInput(input, "owner");
  const pin = stringInput(input, "pin");
  if (!extractComponentByName(tsx, owner)) return fail(tsx, `component ${owner} was not found`);
  if (!isValidPinLabel(pin)) return fail(tsx, "pin must be a valid pin label");
  const next = removeComponentConnection(tsx, owner, pin);
  if (next === tsx) return fail(tsx, `${owner}.${pin} has no authored connection`);
  return success(
    next,
    `Disconnected ${owner}.${pin}.`,
    `Disconnected ${owner}.${pin}`,
    true
  );
}

function setBoard(
  tsx: string,
  input: Record<string, unknown>
): SemanticCircuitToolResult {
  const current = extractBoardConfig(tsx);
  const width = stringInput(input, "width") || current.width;
  const height = stringInput(input, "height") || current.height;
  const rawLayers = input.layers;
  if (!/^\d+(?:\.\d+)?(?:mm|cm|in)$/.test(width)) {
    return fail(tsx, "width must include a supported unit such as 50mm");
  }
  if (!/^\d+(?:\.\d+)?(?:mm|cm|in)$/.test(height)) {
    return fail(tsx, "height must include a supported unit such as 50mm");
  }
  if (rawLayers !== undefined && (typeof rawLayers !== "number" || ![2, 4, 6, 8].includes(rawLayers))) {
    return fail(tsx, "layers must be one of 2, 4, 6, or 8");
  }
  if (input.width === undefined && input.height === undefined && rawLayers === undefined) {
    return fail(tsx, "set_board requires width, height, or layers");
  }
  let next = updateBoardDimensions(tsx, width, height);
  if (typeof rawLayers === "number") next = updateBoardLayers(next, rawLayers);
  if (next === tsx) return fail(tsx, "the board already has those settings");
  const board = extractBoardConfig(next);
  return success(
    next,
    `Board set to ${board.width} × ${board.height}, ${board.layers} layers.`,
    `Set board to ${board.width} × ${board.height}`,
    true
  );
}

export function isSemanticCircuitTool(
  name: string
): name is SemanticCircuitToolName {
  return (SEMANTIC_CIRCUIT_TOOL_NAMES as readonly string[]).includes(name);
}

export function applySemanticCircuitTool(
  tsx: string,
  name: SemanticCircuitToolName,
  rawInput: unknown
): SemanticCircuitToolResult {
  const syntax = validateTsx(tsx);
  if (!syntax.ok) return fail(tsx, `the working circuit is not valid TSX: ${syntax.error}`);
  const input = isRecord(rawInput) ? rawInput : {};
  switch (name) {
    case "inspect_circuit":
      return inspectCircuit(tsx);
    case "add_component":
      return addComponent(tsx, input);
    case "update_component":
      return updateComponent(tsx, input);
    case "remove_component":
      return removeComponent(tsx, input);
    case "connect_pins":
      return connectPins(tsx, input);
    case "disconnect_pin":
      return disconnectPin(tsx, input);
    case "set_board":
      return setBoard(tsx, input);
  }
}
