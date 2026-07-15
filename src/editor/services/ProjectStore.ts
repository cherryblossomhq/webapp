// ProjectStore — schema validation and pure-function load/save helpers for the
// .cherryblossom.json file.
//
// v1 (current):
//   { version: 1, tsxCode, manualEdits, metadata? }
//
// This is the only supported format. The app hasn't shipped, so there are no
// older files in the wild to migrate. A loader for a future schema version can
// branch on `version` here once backward compatibility is actually needed.

import { collectKeys } from "../shared/keys";
import { extractConnections } from "../../utils/tsxTransform";
import type {
  ManualEditsMap,
  PcbRoutePoint,
  ProjectFile,
  StableKey,
  ManualEditEntry,
} from "../shared/types";

export const CURRENT_PROJECT_VERSION = 1;

export interface ProjectLoadResult {
  project: ProjectFile;
  // Warnings (non-fatal): e.g., malformed manualEdits entries dropped.
  warnings: string[];
}

export class ProjectParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectParseError";
  }
}

// Parse a JSON string into a project. Strict on structural shape, lenient on
// missing optional fields. Throws ProjectParseError on anything we can't
// understand.
export function parseProjectJson(raw: string): ProjectLoadResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new ProjectParseError(
      `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return loadProject(data);
}

// Coerce `unknown` from disk / memory into a ProjectFile. Strict on the
// required shape (must carry a string `tsxCode`), lenient on optional fields.
// Used by both parseProjectJson and direct in-memory load paths (e.g.,
// localStorage autosave). Throws ProjectParseError on anything we can't read.
export function loadProject(data: unknown): ProjectLoadResult {
  if (!data || typeof data !== "object") {
    throw new ProjectParseError("Project data is not an object");
  }
  const obj = data as Record<string, unknown>;

  if (typeof obj.tsxCode !== "string") {
    throw new ProjectParseError("Missing required field: tsxCode (string)");
  }

  const warnings: string[] = [];
  const metadata = parseMetadata(obj.metadata);
  const manualEdits = sanitizeManualEdits(obj.manualEdits, warnings);

  return {
    project: {
      version: CURRENT_PROJECT_VERSION,
      tsxCode: obj.tsxCode,
      manualEdits,
      metadata,
    },
    warnings,
  };
}

function parseMetadata(
  m: unknown
): { title: string } | undefined {
  if (!m || typeof m !== "object") return undefined;
  const o = m as Record<string, unknown>;
  return {
    title: typeof o.title === "string" ? o.title : "Untitled Circuit",
  };
}

const KEY_RE = /^[a-z][a-z0-9]{0,7}_[a-z0-9]{6}$/;

function sanitizeManualEdits(
  raw: unknown,
  warnings: string[]
): ManualEditsMap {
  if (!raw || typeof raw !== "object") {
    if (raw !== undefined) warnings.push("manualEdits was not an object — ignored");
    return {};
  }
  const out: ManualEditsMap = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!KEY_RE.test(key)) {
      warnings.push(`Dropped manualEdits entry with invalid key: "${key}"`);
      continue;
    }
    if (!val || typeof val !== "object") continue;
    const entry = val as Record<string, unknown>;
    const sanitized: ManualEditEntry = {};
    if (entry.schematic && typeof entry.schematic === "object") {
      sanitized.schematic = sanitizeSchematic(entry.schematic);
    }
    if (entry.pcb && typeof entry.pcb === "object") {
      sanitized.pcb = sanitizePcb(entry.pcb);
    }
    if (sanitized.schematic || sanitized.pcb) {
      out[key] = sanitized;
    }
  }
  return out;
}

function sanitizeSchematic(o: object) {
  const r = o as Record<string, unknown>;
  const out: {
    x?: number;
    y?: number;
    rotation?: number;
    waypoints?: Array<[number, number]>;
  } = {};
  if (typeof r.x === "number" && Number.isFinite(r.x)) out.x = r.x;
  if (typeof r.y === "number" && Number.isFinite(r.y)) out.y = r.y;
  if (typeof r.rotation === "number" && Number.isFinite(r.rotation))
    out.rotation = r.rotation;
  // Wire route corners (trace keys only). Filter aggressively so a malformed
  // saved file can't bring back garbage NaN coords or Infinities.
  if (Array.isArray(r.waypoints)) {
    const wp: Array<[number, number]> = [];
    for (const p of r.waypoints) {
      if (
        Array.isArray(p) &&
        p.length === 2 &&
        typeof p[0] === "number" &&
        typeof p[1] === "number" &&
        Number.isFinite(p[0]) &&
        Number.isFinite(p[1])
      ) {
        wp.push([p[0], p[1]]);
      }
    }
    if (wp.length > 0) out.waypoints = wp;
  }
  return out;
}

interface SanitizedPcb {
  x?: number;
  y?: number;
  rotation?: number;
  layer?: string;
  mirror_x?: boolean;
  route?: PcbRoutePoint[];
  width?: number;
}

function sanitizePcb(o: object): SanitizedPcb {
  const r = o as Record<string, unknown>;
  const out: SanitizedPcb = {};
  if (typeof r.x === "number" && Number.isFinite(r.x)) out.x = r.x;
  if (typeof r.y === "number" && Number.isFinite(r.y)) out.y = r.y;
  if (typeof r.rotation === "number" && Number.isFinite(r.rotation))
    out.rotation = r.rotation;
  if (typeof r.layer === "string") out.layer = r.layer;
  if (typeof r.mirror_x === "boolean") out.mirror_x = r.mirror_x;
  // Routed-trace geometry. Dropping this on round-trip is what made manual
  // routes vanish after save → quit → reopen: the route lives in the saved file
  // but the loader never copied it back out. Filter aggressively so a corrupt
  // file can't reintroduce NaN coords or a layerless point.
  if (Array.isArray(r.route)) {
    const route: PcbRoutePoint[] = [];
    for (const point of r.route) {
      if (!point || typeof point !== "object") continue;
      const p = point as Record<string, unknown>;
      if (
        typeof p.x === "number" &&
        Number.isFinite(p.x) &&
        typeof p.y === "number" &&
        Number.isFinite(p.y) &&
        typeof p.layer === "string" &&
        p.layer.length > 0
      ) {
        route.push({ x: p.x, y: p.y, layer: p.layer });
      }
    }
    // A route needs at least two points to describe a segment; pcbModel
    // ignores anything shorter, so don't bother carrying it.
    if (route.length >= 2) out.route = route;
  }
  if (typeof r.width === "number" && Number.isFinite(r.width) && r.width > 0) {
    out.width = r.width;
  }
  return out;
}

// Drop any manualEdits entries whose keys are no longer present in the live
// tsx. This protects the file from accumulating dead state forever after AI
// rewrites prune components.
//
// Critical safety: when the tsx fails to parse (the user is mid-keystroke,
// or an AI rewrite produced syntactically invalid code), collectKeys() returns
// null. We MUST NOT prune in that state, or every save while tsx is invalid
// would silently wipe the entire sidecar. Instead, return manualEdits
// unchanged with pruned=[] so the caller knows nothing happened.
//
// `liveRouteConnIds` carries PCB-route liveness, which the tsx ALONE cannot
// answer: a route is keyed by the connection id of its two PAD endpoints in
// eval'd port-hint space (`.<comp> > .pin<N>`), while the tsx `connections`
// prop uses authored pin labels (`anode`, `SDA`, `left`) — the two only
// coincide for numeric pins. The caller derives the authoritative set from the
// evaluated circuit-json (see `liveRouteConnIds` in circuitJsonMerge.ts). When
// it's null/undefined (no eval yet), we can't prove a route is orphaned, so we
// KEEP every route — never delete drawn copper on a guess.
export function pruneOrphanEdits(
  tsx: string,
  manualEdits: ManualEditsMap,
  liveRouteConnIds?: ReadonlySet<StableKey> | null
): { manualEdits: ManualEditsMap; pruned: StableKey[] } {
  const liveKeys = collectKeys(tsx);
  if (liveKeys === null) {
    // tsx didn't parse; we can't safely identify orphans. Skip the prune.
    return { manualEdits, pruned: [] };
  }
  // Connection waypoints are keyed by a content-derived `conn_<6hex>` id, NOT a
  // tsx element `key=` attr, so collectKeys never sees them. Treat the ids of
  // connections present in the current tsx as live too — otherwise every
  // connection's hand-drawn waypoints would be wiped on save. Computed only
  // after the parse-failure guard above so a mid-keystroke parse error can't
  // drop them. (extractConnections falls back to regex and never throws.)
  const liveConnIds = new Set(extractConnections(tsx).map((c) => c.connId));
  // Without an evaluated circuit-json the route-liveness set is unavailable;
  // fall back to keeping every route so a pre-eval save can't drop copper.
  const canPruneRoutes = liveRouteConnIds != null;
  const pruned: StableKey[] = [];
  const out: ManualEditsMap = {};
  for (const [key, val] of Object.entries(manualEdits)) {
    const hasRoute = (val.pcb?.route?.length ?? 0) >= 2;
    const keep =
      liveKeys.has(key) ||
      liveConnIds.has(key) ||
      // PCB route geometry is sidecar-OWNED (no `<trace>` in the tsx). Keep it
      // iff its endpoints are still co-netted in the evaluated design; an
      // orphaned route (its net/components deleted) is pruned. When liveness is
      // unknown (canPruneRoutes === false), keep it.
      (hasRoute && (!canPruneRoutes || liveRouteConnIds!.has(key)));
    if (keep) out[key] = val;
    else pruned.push(key);
  }
  return { manualEdits: out, pruned };
}

// Build the JSON that gets written to disk / localStorage.
export function serializeProject(p: ProjectFile): string {
  if (p.version !== CURRENT_PROJECT_VERSION) {
    // Caller bug; we should always be writing the current version.
    throw new Error(
      `serializeProject: refusing to serialize version ${p.version}`
    );
  }
  return JSON.stringify(p, null, 2);
}

// Tiny convenience: build a ProjectFile struct from raw fields.
export function makeProjectFile(opts: {
  tsxCode: string;
  manualEdits: ManualEditsMap;
  metadata?: { title: string };
}): ProjectFile {
  return {
    version: CURRENT_PROJECT_VERSION,
    tsxCode: opts.tsxCode,
    manualEdits: opts.manualEdits,
    metadata: opts.metadata,
  };
}

// Build a one-line-per-component summary that the chat prompt can include so
// the LLM can answer "where is R5?" without ever editing positions itself.
export function summarizeManualEdits(m: ManualEditsMap): string {
  const keys = Object.keys(m).sort();
  if (keys.length === 0) return "(none — all positions auto-laid-out)";
  const lines: string[] = [];
  for (const k of keys) {
    const e = m[k];
    const parts: string[] = [];
    if (e.schematic) {
      const sx = e.schematic.x?.toFixed(1) ?? "?";
      const sy = e.schematic.y?.toFixed(1) ?? "?";
      const sr = e.schematic.rotation ?? 0;
      parts.push(`schematic(${sx}, ${sy}, ${sr}deg)`);
    }
    if (e.pcb) {
      const px = e.pcb.x?.toFixed(1) ?? "?";
      const py = e.pcb.y?.toFixed(1) ?? "?";
      const pr = e.pcb.rotation ?? 0;
      const layer = e.pcb.layer ?? "top";
      parts.push(`pcb(${px}, ${py}, ${pr}deg, ${layer})`);
    }
    if (parts.length > 0) lines.push(`- ${k}: ${parts.join(", ")}`);
  }
  return lines.join("\n");
}
