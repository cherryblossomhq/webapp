import type { EvalIssue } from "../editor/shared/types";
import {
  extractBoardConfig,
  extractComponents,
  extractConnections,
} from "../utils/tsxTransform";

const PRIMARY_VALUE_PROPS = [
  "resistance",
  "capacitance",
  "inductance",
  "partNumber",
  "manufacturerPartNumber",
  "color",
  "standard",
  "pinCount",
] as const;

function componentDetail(props: Record<string, string>): string {
  const parts: string[] = [];
  for (const prop of PRIMARY_VALUE_PROPS) {
    const value = props[prop];
    if (value !== undefined) parts.push(`${prop}=${value}`);
  }
  if (props.footprint) parts.push(`footprint=${props.footprint}`);
  if (props.layer) parts.push(`layer=${props.layer}`);
  if (props.pcbX || props.pcbY || props.pcbRotation) {
    parts.push(
      `pcb=(${props.pcbX ?? "?"},${props.pcbY ?? "?"},${props.pcbRotation ?? "0"}deg)`
    );
  }
  if (props.pinLabels) parts.push(`pinLabels=${props.pinLabels}`);
  if (props.pinAttributes) parts.push(`pinAttributes=${props.pinAttributes}`);
  return parts.join(" | ");
}

function isPowerRail(netName: string): boolean {
  return /^(gnd|vcc|vdd|vss|vin|vout|vbatt|bat|v\d+(?:v\d+)?|\+?-?\d+(?:v\d+)?)/i.test(netName);
}

/** Build a compact, deterministic view of the concepts the model edits. */
export function buildCircuitManifest(
  tsx: string,
  issues: readonly EvalIssue[] = []
): string {
  const board = extractBoardConfig(tsx);
  const components = extractComponents(tsx);
  const connections = extractConnections(tsx);
  const namedNets = new Map<string, string[]>();
  const directConnections: string[] = [];

  for (const connection of connections) {
    const endpoint = `${connection.owner}.${connection.pinLabel}`;
    if (connection.target.startsWith("net.")) {
      const name = connection.target.slice(4);
      const endpoints = namedNets.get(name) ?? [];
      endpoints.push(endpoint);
      namedNets.set(name, endpoints);
    } else {
      directConnections.push(`${endpoint} -> ${connection.target}`);
    }
  }

  const typeCounts = new Map<string, number>();
  for (const component of components) {
    typeCounts.set(component.elementTag, (typeCounts.get(component.elementTag) ?? 0) + 1);
  }

  const lines = [
    "## Circuit Manifest",
    "",
    `Board: ${board.width} x ${board.height} | ${board.layers} copper layers`,
    `Inventory: ${components.length} components | ${connections.length} authored connections`,
    `Types: ${[...typeCounts.entries()].map(([tag, count]) => `${tag}=${count}`).join(", ") || "none"}`,
    "",
    "Components:",
  ];
  if (components.length === 0) lines.push("- (none)");
  for (const component of components) {
    const detail = componentDetail(component.props);
    lines.push(
      `- ${component.name} <${component.elementTag}>${detail ? ` | ${detail}` : ""}`
    );
  }

  lines.push("", "Named nets:");
  if (namedNets.size === 0) lines.push("- (none)");
  for (const [name, endpoints] of [...namedNets.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    lines.push(
      `- net.${name}${isPowerRail(name) ? " [power]" : ""}: ${endpoints.join(", ")}`
    );
  }

  lines.push("", "Direct connections:");
  if (directConnections.length === 0) lines.push("- (none)");
  else for (const connection of directConnections) lines.push(`- ${connection}`);

  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  lines.push("", `Evaluation: ${errors.length} errors | ${warnings.length} warnings`);
  for (const issue of issues.slice(0, 12)) {
    lines.push(`- [${issue.severity}] ${issue.type}: ${issue.message}`);
  }
  if (issues.length > 12) lines.push(`- ... ${issues.length - 12} more issues in the Issues panel`);

  return lines.join("\n");
}
