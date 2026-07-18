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
  renameComponent,
  setComponentConnection,
  updateBoardDimensions,
  updateBoardLayers,
  updateComponentValueProp,
  validateTsx,
  type ComponentPropValue,
} from "../utils/tsxTransform";

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
export const SEMANTIC_CIRCUIT_TOOLS: unknown[] = [
  {
    name: "inspect_circuit",
    description:
      "Read a compact structured manifest of the working circuit: board settings, components, props, and connections. Use this when you need exact current state before targeted edits.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "add_component",
    description:
      "Add one component to the working circuit using a documented tscircuit tag and typed props. A stable key is generated automatically. For arbitrary devices use tag=chip with pinLabels; imported parts may use the exact uppercase tag returned by import_component.",
    input_schema: {
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
  {
    name: "update_component",
    description:
      "Update typed props, remove props, or rename one existing component. Stable keys, placement, and connection references are preserved unless explicitly changed. Prefer this over raw TSX replacement for component edits.",
    input_schema: {
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
  {
    name: "remove_component",
    description:
      "Remove one component by designator and prune authored connections that target it.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "Component designator." } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "connect_pins",
    description:
      "Author one connection on a component. Define chip pinLabels first. Use Component.pin for a point-to-point connection or net.NAME for shared rails and multi-pin nets.",
    input_schema: {
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
  {
    name: "disconnect_pin",
    description: "Remove one authored connection from a component pin.",
    input_schema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Component carrying the connection." },
        pin: { type: "string", description: "Pin label to disconnect." },
      },
      required: ["owner", "pin"],
      additionalProperties: false,
    },
  },
  {
    name: "set_board",
    description:
      "Update board width, height, or copper-layer count without rewriting components.",
    input_schema: {
      type: "object",
      properties: {
        width: { type: "string", description: "Physical width with units, e.g. 50mm." },
        height: { type: "string", description: "Physical height with units, e.g. 40mm." },
        layers: { type: "integer", enum: [2, 4, 6, 8] },
      },
      additionalProperties: false,
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

const BUILTIN_COMPONENT_TAGS = new Set([
  "resistor",
  "capacitor",
  "inductor",
  "diode",
  "led",
  "fuse",
  "pushbutton",
  "potentiometer",
  "transistor",
  "mosfet",
  "opamp",
  "chip",
  "battery",
  "crystal",
  "resonator",
  "switch",
  "jumper",
  "solderjumper",
  "connector",
  "pinheader",
]);

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
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
  return BUILTIN_COMPONENT_TAGS.has(tag) || /^[A-Z][A-Za-z0-9_]*$/.test(tag);
}

function validateProps(
  props: unknown
): { ok: true; value: Record<string, ComponentPropValue> } | { ok: false; error: string } {
  if (props === undefined) return { ok: true, value: {} };
  if (!isRecord(props)) return { ok: false, error: "props must be an object" };
  const clean: Record<string, ComponentPropValue> = {};
  for (const [name, value] of Object.entries(props)) {
    if (!IDENTIFIER.test(name)) {
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
    if (!IDENTIFIER.test(prop) || FORBIDDEN_DIRECT_PROPS.has(prop)) {
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
  if (newName && newName !== name) next = renameComponent(next, name, newName);
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
  const next = removeComponentElement(tsx, name);
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
  if (/^net\.[A-Za-z_][A-Za-z0-9_]*$/.test(target)) {
    return { ok: true, target };
  }
  const match = /^([A-Za-z][A-Za-z0-9_-]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(target);
  if (!match) {
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
  if (!IDENTIFIER.test(pin)) return fail(tsx, "pin must be a valid pin label");
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
  if (!IDENTIFIER.test(pin)) return fail(tsx, "pin must be a valid pin label");
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
