import { create } from "zustand";
import type { ManualEditEvent } from "@tscircuit/props";
import type { AnyCircuitElement } from "circuit-json";
import { toast } from "sonner";
import { COMPONENT_LIBRARY } from "../data/components";
import {
  extractComponents,
  extractBoardConfig,
  extractComponentByName,
  updateComponentProp as tsxUpdateProp,
  updateComponentNumericProp as tsxUpdateNumericProp,
  updateComponentPinLabels as tsxUpdatePinLabels,
  setComponentLayerProp as tsxSetComponentLayer,
  renameComponent as tsxRename,
  addComponentElement,
  removeComponentElement,
  removeComponentProp as tsxRemoveProp,
  normalizeSelectorString,
  extractConnections,
  setComponentConnection,
  removeComponentConnection,
  mintNetName,
  promoteToNet,
  updateBoardDimensions,
  updateBoardLayers,
  DEFAULT_TSX,
  type ExtractedComponent,
  type ExtractedBoard,
} from "../utils/tsxTransform";
import {
  validateCircuitFootprints,
  type FootprintIssue,
} from "../utils/footprintCatalog";
import { injectKeysIntoTsx } from "../editor/shared/keys";
import { connectionId, canonEndpoint } from "../editor/shared/connectionId";
import { isChipLike } from "../editor/schematic/symbols";
import {
  loadProject as parseProjectData,
  makeProjectFile,
  pruneOrphanEdits,
} from "../editor/services/ProjectStore";
import { useEditorStore } from "../editor/state/editorStore";
import { overlayManualRoutes, liveRouteConnIds } from "../editor/pcb/circuitJsonMerge";
import type { DrcViolation } from "../editor/pcb/drc";
import type {
  EvalIssue,
  ManualEditsMap,
  ProjectFile,
} from "../editor/shared/types";
import type { PcbTransformUpdate } from "../editor/pcb/pcbModel";

// ─── Reverse mappings ───────────────────────────────────────────────────────────

const ELEMENT_TO_TYPE: Record<string, string> = {
  resistor: "resistor",
  capacitor: "capacitor",
  inductor: "inductor",
  led: "led",
  diode: "diode",
  transistor: "transistor_npn",
  chip: "ic",
  pinheader: "connector",
  net: "gnd",
};

const ELEMENT_VALUE_PROP: Record<string, string> = {
  resistor: "resistance",
  capacitor: "capacitance",
  inductor: "inductance",
  led: "color",
  diode: "partNumber",
  transistor: "partNumber",
  chip: "partNumber",
  pinheader: "pinCount",
};

// ─── Component view for consumers ───────────────────────────────────────────────

export interface ComponentView {
  name: string;
  type: string;
  value: string;
  footprint: string;
  elementTag: string;
}

function toComponentView(ec: ExtractedComponent): ComponentView {
  let type = ELEMENT_TO_TYPE[ec.elementTag] ?? ec.elementTag;
  if (ec.elementTag === "net") {
    type = ec.props.isPowerNet === "true" ? "vcc" : "gnd";
  }
  const valuePropName = ELEMENT_VALUE_PROP[ec.elementTag];
  const value = valuePropName ? (ec.props[valuePropName] ?? "") : "";
  const footprint = ec.props.footprint ?? "";
  return { name: ec.name, type, value, footprint, elementTag: ec.elementTag };
}

// ─── Memoized extraction cache ──────────────────────────────────────────────────

let _cachedTsx = "";
let _cachedComponents: ExtractedComponent[] | null = null;
let _cachedBoard: ExtractedBoard | null = null;

function invalidateCache() {
  _cachedTsx = "";
  _cachedComponents = null;
  _cachedBoard = null;
}

function getCachedComponents(tsx: string): ExtractedComponent[] {
  if (tsx !== _cachedTsx) invalidateCache();
  if (!_cachedComponents) {
    _cachedTsx = tsx;
    _cachedComponents = extractComponents(tsx);
  }
  return _cachedComponents;
}

function getCachedBoard(tsx: string) {
  if (tsx !== _cachedTsx) invalidateCache();
  if (!_cachedBoard) {
    _cachedTsx = tsx;
    _cachedBoard = extractBoardConfig(tsx);
  }
  return _cachedBoard;
}

// ─── Store interface ────────────────────────────────────────────────────────────

interface CircuitStore {
  // ─── Source of truth ──────────────────────────────────────────────────────
  tsxCode: string;

  // ─── Project metadata ─────────────────────────────────────────────────────
  metadata: { title: string };

  // ─── Edit events buffer (in-progress drags) ──────────────────────────────
  pendingEditEvents: ManualEditEvent[];

  // ─── Selection state ──────────────────────────────────────────────────────
  selectedComponentName: string | null;

  // ─── History (TSX snapshots) ──────────────────────────────────────────────
  history: string[];
  historyIndex: number;

  // ─── Actions ──────────────────────────────────────────────────────────────
  setMetadata: (title: string) => void;

  addComponent: (type: string, overrides?: Partial<{ name: string; value: string; footprint: string }>) => string;
  removeComponent: (name: string) => void;
  updateComponent: (name: string, updates: Partial<{ value: string; footprint: string }>) => void;
  // Set pinCount={N} on a chip-like component. Used by the Properties panel
  // when the user edits the pin count of an imported (or library) chip.
  setComponentPinCount: (name: string, pinCount: number) => void;
  // Replace the entire pinLabels object on a chip-like component. Pass the
  // full ordered array; the helper writes {"1": labels[0], "2": labels[1], ...}.
  setComponentPinLabels: (name: string, labels: ReadonlyArray<string>) => void;
  renameComponent: (
    oldName: string,
    newName: string
  ) => { success: true } | { success: false; error: string };

  // ─── Connections (connectivity source of truth) ─────────────────────────
  // Connect two endpoints in the schematic by writing a `connections` entry
  // (the netlist). Returns the content-derived connection id so the caller can
  // attach hand-drawn waypoints, plus the kind of edit performed. Returns null
  // for a no-op (self-connection or already connected). See the hybrid model:
  //   - pin↔net (or a pin joining a net an endpoint already sits on) → pin→net
  //   - pin↔pin → pin→pin wire (chip-first ownership)
  //   - a 3rd pin joining an existing pin→pin pair → promote to a minted net
  connectPins: (
    selA: string,
    selB: string
  ) => { connId: string; kind: "wire" | "net" | "promoted" } | null;
  // Remove a connection (and its sidecar waypoints) by connection id. PCB
  // <trace> geometry is left untouched (a now-dangling route is a DRC concern).
  disconnect: (connId: string) => void;

  setBoard: (
    config: Partial<{ width: string; height: string; layers: number }>
  ) => void;

  setSelectedComponent: (name: string | null) => void;

  handleEditEvent: (event: ManualEditEvent) => void;

  // Bake PCB x/y/rotation/layer into tsx. X/Y use manualEdits.pcb as a
  // during-drag preview; this commits final values into pcbX / pcbY /
  // pcbRotation / layer. circuitJson is intentionally NOT cleared.
  bakePcbComponentTransform: (
    updates: ReadonlyArray<PcbTransformUpdate>
  ) => void;

  // Direct TSX replacement (for AI edits)
  setTsxCode: (tsx: string) => void;

  // ─── History ──────────────────────────────────────────────────────────────
  saveSnapshot: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  // ─── File I/O ─────────────────────────────────────────────────────────────
  resetCircuit: () => void;
  loadProject: (data: {
    version?: number;
    tsxCode?: string;
    metadata?: { title: string };
    manualEdits?: ManualEditsMap;
  }) => void;
  getProjectData: () => ProjectFile;

  // ─── Component metadata (imported part footprints, etc.) ─────────────────
  // Map of source-component-name → expected metadata. Currently the only
  // field is `expectedFootprint`, stamped when a JLCPCB import resolves so
  // the validator can cross-check the model's TSX against the real part.
  componentMeta: Record<string, { expectedFootprint?: string }>;
  setComponentMeta: (
    name: string,
    meta: { expectedFootprint?: string }
  ) => void;

  // ─── Footprint validation ─────────────────────────────────────────────────
  // Cached snapshot of footprint issues, refreshed by `validateFootprints`.
  // Consumers like PropertiesPanel and the AI dynamic context read this.
  footprintIssues: FootprintIssue[];
  // Re-runs `validateCircuitFootprints` against the current tsx + meta.
  // Called automatically from every TSX-mutating action.
  refreshFootprintIssues: () => void;

  // ─── AI ───────────────────────────────────────────────────────────────────
  // Applies an AI-authored TSX edit. Returns `true` if it changed the circuit,
  // `false` if the (key-injected) TSX is byte-identical to the current code — a
  // no-op echo the caller should not run a validation cycle on.
  applyAiEdit: (tsxCode: string) => boolean;
  circuitJson: AnyCircuitElement[] | null;
  setCircuitJson: (json: AnyCircuitElement[]) => void;
  isValidating: boolean;
  setValidating: (v: boolean) => void;
  // Hard eval failure (compile / runtime throw) for the CURRENT tsx. circuitJson
  // keeps the last good render, so this is how the read-only schematic surfaces
  // a subtle "showing last working version" chip. Cleared on the next good eval.
  evalError: string | null;
  // Structured findings from the latest successful tscircuit eval + checks.
  evalIssues: EvalIssue[];
  evalIssuesVersion: number;

  // ─── Evaluator versioning (Phase 0) ──────────────────────────────────────
  // The CircuitEvaluator stamps every result with a monotonic version. The
  // store records the latest one so that consumers (chat validation, future
  // editors) can refuse to act on stale outputs.
  evalVersion: number;
  // Hash of the (tsxCode + manualEdits) input that produced the latest eval.
  // Used by chatStore to gate validation on a result that matches the tsx
  // the chat saw when it sent the message — closes the codex finding #6 race.
  evalInputHash: string | null;
  setEvalResult: (params: { version: number; inputHash: string }) => void;
  setEvalIssues: (params: { version: number; issues: EvalIssue[] }) => void;
  // Hash of the input whose eval FAILED (compile/runtime error or eval timeout),
  // mirroring evalInputHash for the success case. Lets the chat validation cycle
  // react to a failed render of the exact tsx it applied — instead of hanging
  // until its ceiling. Cleared on the next successful eval.
  evalErrorHash: string | null;
  setEvalFailure: (params: {
    version: number;
    inputHash: string;
    message: string;
  }) => void;

  // ─── Export ─────────────────────────────────────────────────────────────
  // circuit-json with the GUI's manual routes spliced over the autorouter's
  // geometry — the single artifact fabrication exporters should consume.
  // Returns null only when no eval result exists yet.
  getCircuitJsonForExport: () => AnyCircuitElement[] | null;

  // ─── DRC ────────────────────────────────────────────────────────────────
  // Routing design-rule violations from the latest check pass, run over the
  // merged circuit-json so manual routes are checked like autorouted ones.
  // Populated by useBackgroundEvaluator after each eval.
  drcViolations: DrcViolation[];
  setDrcViolations: (violations: DrcViolation[]) => void;

  // ─── Derived queries ──────────────────────────────────────────────────────
  getComponents: () => ComponentView[];
  getBoardConfig: () => ExtractedBoard;
  getComponent: (name: string) => ComponentView | undefined;
  getSelectedComponent: () => ComponentView | undefined;
}

// ─── Constants ──────────────────────────────────────────────────────────────────

const MAX_HISTORY = 50;

// ─── Helpers ────────────────────────────────────────────────────────────────────

function getNextDesignator(prefix: string, existingNames: string[]): string {
  let num = 1;
  while (existingNames.includes(`${prefix}${num}`)) num++;
  return `${prefix}${num}`;
}

function pushHistory(
  history: string[],
  historyIndex: number,
  snapshot: string
): { history: string[]; historyIndex: number } {
  const truncated = history.slice(0, historyIndex + 1);
  truncated.push(snapshot);
  const capped = truncated.slice(-MAX_HISTORY);
  return { history: capped, historyIndex: capped.length - 1 };
}

// Render a string as a complete JSX attribute value. JSX attribute strings
// have no escape sequences — a `"` can't be backslash-escaped, and a `\`
// wouldn't round-trip — so such values are emitted as expression containers,
// where JS string escaping is valid.
function jsxAttrValue(value: string): string {
  return value.includes('"') || value.includes("\\")
    ? `{${JSON.stringify(value)}}`
    : `"${value}"`;
}

export function cleanImportedTsx(tsx: string): string {
  let cleaned = tsx
    .replace(/^import\s+type\s+.*$/gm, "")
    .replace(/^import\s*\{[^}]*\}\s*from\s*['"][^'"]*['"];?\s*$/gm, "")
    .replace(/^export\s+/gm, "")
    .replace(/:\s*\w+Props(?:<[^>]*>)?/g, "")
    .replace(/\s+as\s+const/g, "");

  const pinLabelsMatch = cleaned.match(/const\s+pinLabels\s*=\s*(\{[\s\S]*?\n\})/);
  if (pinLabelsMatch) {
    cleaned = cleaned.replace(/const\s+pinLabels\s*=\s*\{[\s\S]*?\n\}\s*/, "");
    cleaned = cleaned.replace(
      /pinLabels=\{pinLabels\}/,
      `pinLabels={${pinLabelsMatch[1]}}`
    );
  }

  return cleaned.trim();
}

function buildComponentSnippet(
  type: string,
  name: string,
  value: string,
  footprint: string
): string {
  const def = COMPONENT_LIBRARY[type];
  if (!def) return `{/* Unknown component type: ${type} */}`;

  if (type === "gnd") {
    return `<net name=${jsxAttrValue(name)} isGroundNet />`;
  }
  if (type === "vcc") {
    return `<net name=${jsxAttrValue(name)} isPowerNet />`;
  }

  const elementName = def.tscircuitElement ?? type;
  // generateTsx used a different map for element names — use the same
  const ELEMENT_MAP: Record<string, string> = {
    resistor: "resistor",
    capacitor: "capacitor",
    inductor: "inductor",
    led: "led",
    diode: "diode",
    transistor_npn: "transistor",
    ic: "chip",
    connector: "pinheader",
  };
  const tag = ELEMENT_MAP[type] ?? elementName;

  const props: string[] = [`name=${jsxAttrValue(name)}`];

  const valuePropName = ELEMENT_VALUE_PROP[tag];
  if (valuePropName && value) {
    if (type === "connector") {
      const pinCount = def.pinCount ?? (parseInt(value, 10) || 2);
      props.push(`pinCount={${pinCount}}`);
    } else {
      props.push(`${valuePropName}=${jsxAttrValue(value)}`);
    }
  }

  if (footprint && footprint !== "none") {
    props.push(`footprint=${jsxAttrValue(footprint)}`);
  }

  if (type === "ic" && def.pinLabels) {
    const pinCount = Math.max(2, Number(def.pinCount) || 2);
    const leftPins = Math.ceil(pinCount / 2);
    const rightPins = pinCount - leftPins;
    props.push(`schPinArrangement={{ leftSize: ${leftPins}, rightSize: ${rightPins} }}`);
  }

  if (type === "transistor_npn") {
    props.push(`transistorType="npn"`);
  }

  return `<${tag} ${props.join(" ")} />`;
}

type ParsedLocationEdit =
  | { kind: "pcb"; componentId: string; center: { x: number; y: number } }
  | { kind: "schematic"; componentId: string; center: { x: number; y: number } };

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function parseLocationEditEvent(event: unknown): ParsedLocationEdit | null {
  if (!event || typeof event !== "object") return null;
  const ev = event as Record<string, unknown>;
  const evType = ev.edit_event_type;
  const center = ev.new_center as Record<string, unknown> | undefined;
  if (!center || !isFiniteNumber(center.x) || !isFiniteNumber(center.y)) return null;
  const c = { x: center.x, y: center.y };

  if (evType === "edit_pcb_component_location") {
    const id = ev.pcb_component_id;
    if (typeof id !== "string" || !id) return null;
    return { kind: "pcb", componentId: id, center: c };
  }
  if (evType === "edit_schematic_component_location") {
    const id = ev.schematic_component_id;
    if (typeof id !== "string" || !id) return null;
    return { kind: "schematic", componentId: id, center: c };
  }
  return null;
}

function resolveComponentName(
  circuitJson: AnyCircuitElement[],
  pcbComponentId?: string,
  schComponentId?: string
): string | null {
  const elements = circuitJson as Array<Record<string, unknown>>;

  let sourceComponentId: string | null = null;

  if (pcbComponentId) {
    const pcbComp = elements.find(
      (el) => el.type === "pcb_component" && el.pcb_component_id === pcbComponentId
    );
    if (pcbComp) sourceComponentId = pcbComp.source_component_id as string;
  }

  if (schComponentId) {
    const schComp = elements.find(
      (el) => el.type === "schematic_component" && el.schematic_component_id === schComponentId
    );
    if (schComp) sourceComponentId = schComp.source_component_id as string;
  }

  if (!sourceComponentId) return null;

  const srcComp = elements.find(
    (el) => el.type === "source_component" && el.source_component_id === sourceComponentId
  );

  return (srcComp?.name as string) ?? null;
}

// ─── Store ──────────────────────────────────────────────────────────────────────

export const useCircuitStore = create<CircuitStore>((set, get) => ({
  tsxCode: DEFAULT_TSX,

  metadata: { title: "Untitled Circuit" },

  pendingEditEvents: [],
  circuitJson: null,
  drcViolations: [],
  isValidating: false,
  evalError: null,
  evalIssues: [],
  evalIssuesVersion: 0,
  evalVersion: 0,
  evalInputHash: null,
  evalErrorHash: null,

  selectedComponentName: null,

  history: [DEFAULT_TSX],
  historyIndex: 0,

  componentMeta: {},
  footprintIssues: [],

  setComponentMeta: (name, meta) => {
    set((state) => ({
      componentMeta: {
        ...state.componentMeta,
        [name]: { ...state.componentMeta[name], ...meta },
      },
    }));
    // Re-validate immediately so a freshly stamped expected footprint flags
    // any mismatch the model already wrote.
    get().refreshFootprintIssues();
  },

  refreshFootprintIssues: () => {
    const { tsxCode, componentMeta } = get();
    const expectedByName: Record<string, string> = {};
    for (const [name, meta] of Object.entries(componentMeta)) {
      if (meta.expectedFootprint) expectedByName[name] = meta.expectedFootprint;
    }
    const next = validateCircuitFootprints(tsxCode, expectedByName);
    // Avoid a needless re-render when nothing changed.
    const prev = get().footprintIssues;
    const sameLength = prev.length === next.length;
    const sameContent =
      sameLength &&
      prev.every(
        (p, i) =>
          p.componentName === next[i].componentName &&
          p.kind === next[i].kind &&
          p.actual === next[i].actual &&
          p.expected === next[i].expected
      );
    if (!sameContent) set({ footprintIssues: next });
  },

  // ─── Metadata ─────────────────────────────────────────────────────────────

  setMetadata: (title) => set({ metadata: { title } }),

  // ─── Component actions ────────────────────────────────────────────────────

  addComponent: (type, overrides) => {
    const def = COMPONENT_LIBRARY[type];
    if (!def) throw new Error(`Unknown component type: ${type}`);

    const prefix = def.designatorPrefix ?? "U";
    const existingNames = getCachedComponents(get().tsxCode).map((c) => c.name);
    const name = overrides?.name ?? getNextDesignator(prefix, existingNames);
    const value = overrides?.value ?? def.defaultValue;
    const footprint = overrides?.footprint ?? def.defaultFootprint;

    const snippet = buildComponentSnippet(type, name, value, footprint);
    const newTsx = addComponentElement(get().tsxCode, snippet);

    set((state) => ({
      tsxCode: newTsx,
      ...pushHistory(state.history, state.historyIndex, newTsx),
    }));

    return name;
  },

  removeComponent: (name) => {
    const newTsx = removeComponentElement(get().tsxCode, name);
    set((state) => {
      // Drop component metadata for the removed name so a future component
      // with the same designator doesn't inherit a stale expected footprint.
      const { [name]: _, ...remainingMeta } = state.componentMeta;
      void _;
      return {
        tsxCode: newTsx,
        selectedComponentName:
          state.selectedComponentName === name ? null : state.selectedComponentName,
        componentMeta: remainingMeta,
        ...pushHistory(state.history, state.historyIndex, newTsx),
      };
    });
    get().refreshFootprintIssues();
  },

  updateComponent: (name, updates) => {
    let tsx = get().tsxCode;

    if (updates.value !== undefined) {
      const comp = extractComponentByName(tsx, name);
      if (comp) {
        const valueProp = ELEMENT_VALUE_PROP[comp.elementTag];
        if (valueProp) {
          tsx = tsxUpdateProp(tsx, name, valueProp, updates.value);
        }
      }
    }

    if (updates.footprint !== undefined) {
      tsx = tsxUpdateProp(tsx, name, "footprint", updates.footprint);
    }

    if (tsx !== get().tsxCode) {
      set((state) => ({
        tsxCode: tsx,
        ...pushHistory(state.history, state.historyIndex, tsx),
      }));
      if (updates.footprint !== undefined) get().refreshFootprintIssues();
    }
  },

  setComponentPinCount: (name, pinCount) => {
    const clamped = Math.max(1, Math.floor(pinCount));
    const tsx = tsxUpdateNumericProp(get().tsxCode, name, "pinCount", clamped);
    if (tsx === get().tsxCode) return;
    set((state) => ({
      tsxCode: tsx,
      ...pushHistory(state.history, state.historyIndex, tsx),
    }));
  },

  setComponentPinLabels: (name, labels) => {
    const tsx = tsxUpdatePinLabels(get().tsxCode, name, labels);
    if (tsx === get().tsxCode) return;
    set((state) => ({
      tsxCode: tsx,
      ...pushHistory(state.history, state.historyIndex, tsx),
    }));
  },

  renameComponent: (oldName, newName) => {
    const trimmed = newName.trim();
    if (!trimmed) return { success: false, error: "Name cannot be empty" };
    if (trimmed === oldName) return { success: true };

    const existing = getCachedComponents(get().tsxCode).find((c) => c.name === trimmed);
    if (existing) return { success: false, error: "Name already exists" };

    const newTsx = tsxRename(get().tsxCode, oldName, trimmed);

    set((state) => ({
      tsxCode: newTsx,
      selectedComponentName:
        state.selectedComponentName === oldName ? trimmed : state.selectedComponentName,
      ...pushHistory(state.history, state.historyIndex, newTsx),
    }));

    return { success: true };
  },

  // ─── Connections ────────────────────────────────────────────────────────
  connectPins: (selA, selB) => {
    const tsx = get().tsxCode;
    const a = normalizeSelectorString(selA);
    const b = normalizeSelectorString(selB);
    if (!a || !b || canonEndpoint(a) === canonEndpoint(b)) return null;

    const comps = getCachedComponents(tsx);
    const tagOf = (owner: string): string | undefined =>
      comps.find((c) => c.name === owner)?.elementTag;
    const split = (sel: string): { owner: string; pin: string } => {
      const i = sel.lastIndexOf(".");
      return i <= 0 ? { owner: "", pin: "" } : { owner: sel.slice(0, i), pin: sel.slice(i + 1) };
    };
    // A net endpoint is "net.X" or a reference to a <net> element.
    const netNameOf = (sel: string): string | null => {
      const m = /^net\.(.+)$/.exec(sel);
      if (m) return m[1];
      const { owner } = split(sel);
      if (owner && tagOf(owner) === "net") return owner;
      return null;
    };

    const commit = (newTsx: string) => {
      if (newTsx !== tsx) {
        set((state) => ({
          tsxCode: newTsx,
          ...pushHistory(state.history, state.historyIndex, newTsx),
        }));
      }
    };

    const existing = extractConnections(tsx);
    const hasConn = (id: string) => existing.some((c) => c.connId === id);

    // (1) Explicit pin↔net.
    const aNet = netNameOf(a);
    const bNet = netNameOf(b);
    if (aNet || bNet) {
      const netName = (aNet ?? bNet)!;
      const pinSel = aNet ? b : a;
      const { owner, pin } = split(pinSel);
      if (!owner || !pin) return null;
      const target = `net.${netName}`;
      const connId = connectionId(pinSel, target);
      if (!hasConn(connId)) commit(setComponentConnection(tsx, owner, pin, target));
      return { connId, kind: "net" };
    }

    // (2) pin↔pin: dedup.
    const connId = connectionId(a, b);
    if (hasConn(connId)) return { connId, kind: "wire" };

    // (3) If either endpoint already sits on a net, join the other to it.
    const netMemberOf = (pinSel: string): string | null => {
      const e = existing.find(
        (c) =>
          /^net\./.test(c.target) &&
          canonEndpoint(`${c.owner}.${c.pinLabel}`) === canonEndpoint(pinSel)
      );
      return e ? e.target.slice(4) : null;
    };
    const na = netMemberOf(a);
    const nb = netMemberOf(b);
    if (na || nb) {
      // Both endpoints already sit on DIFFERENT nets → merge the two nets so
      // every member stays connected, not just the dragged pin. Repoint every
      // connection whose target is net.nb onto net.na. (Just adding b to net.na
      // would strand the rest of net B's members.)
      if (na && nb && na !== nb) {
        let out = tsx;
        for (const c of existing) {
          if (c.target === `net.${nb}`) {
            out = setComponentConnection(out, c.owner, c.pinLabel, `net.${na}`);
          }
        }
        commit(out);
        return { connId: connectionId(b, `net.${na}`), kind: "net" };
      }
      const netName = (na ?? nb)!;
      const pinSel = na ? b : a;
      const { owner, pin } = split(pinSel);
      const target = `net.${netName}`;
      const cid = connectionId(pinSel, target);
      if (!hasConn(cid)) commit(setComponentConnection(tsx, owner, pin, target));
      return { connId: cid, kind: "net" };
    }

    // (4) 3rd-pin promotion: is either endpoint already in a pin→pin link?
    const linkMemberOf = (pinSel: string) =>
      existing.find(
        (c) =>
          !/^net\./.test(c.target) &&
          (canonEndpoint(`${c.owner}.${c.pinLabel}`) === canonEndpoint(pinSel) ||
            canonEndpoint(c.target) === canonEndpoint(pinSel))
      );
    const link = linkMemberOf(a) ?? linkMemberOf(b);
    if (link) {
      const e1 = `${link.owner}.${link.pinLabel}`;
      const e2 = link.target;
      const linkEps = [canonEndpoint(e1), canonEndpoint(e2)];
      const joiner = linkEps.includes(canonEndpoint(a)) ? b : a;
      const netName = mintNetName(tsx, link.pinLabel);
      commit(promoteToNet(tsx, e1, e2, joiner, netName));
      return { connId: connectionId(joiner, `net.${netName}`), kind: "promoted" };
    }

    // (5) Plain pin→pin, chip-first ownership (drag-origin = selA as tiebreak).
    const { owner: oa, pin: pa } = split(a);
    const { owner: ob, pin: pb } = split(b);
    const aChip = isChipLike(tagOf(oa) ?? "");
    const bChip = isChipLike(tagOf(ob) ?? "");
    let owner = oa, ownerPin = pa, peer = b;
    if (bChip && !aChip) {
      owner = ob;
      ownerPin = pb;
      peer = a;
    }
    if (!owner || !ownerPin) return null;
    commit(setComponentConnection(tsx, owner, ownerPin, peer));
    return { connId, kind: "wire" };
  },

  disconnect: (connId) => {
    const tsx = get().tsxCode;
    const hit = extractConnections(tsx).find((c) => c.connId === connId);
    if (!hit) return;
    const newTsx = removeComponentConnection(tsx, hit.owner, hit.pinLabel);
    if (newTsx !== tsx) {
      set((state) => ({
        tsxCode: newTsx,
        ...pushHistory(state.history, state.historyIndex, newTsx),
      }));
    }
    // Drop the connection's hand-drawn waypoints from the sidecar.
    useEditorStore.getState().setSchematicEdit(connId, null);
  },

  // ─── Board ────────────────────────────────────────────────────────────────

  setBoard: (config) => {
    const current = getCachedBoard(get().tsxCode);
    let nextTsx = get().tsxCode;

    if (config.width !== undefined || config.height !== undefined) {
      const w = config.width ?? current.width;
      const h = config.height ?? current.height;
      nextTsx = updateBoardDimensions(nextTsx, w, h);
    }

    if (config.layers !== undefined) {
      nextTsx = updateBoardLayers(nextTsx, config.layers);
    }

    if (nextTsx !== get().tsxCode) {
      set({ tsxCode: nextTsx });
    }
  },

  // ─── Selection ────────────────────────────────────────────────────────────

  setSelectedComponent: (name) => set({ selectedComponentName: name }),

  // ─── Edit events (drag-and-drop position baking) ─────────────────────────

  handleEditEvent: (event) => {
    // Buffer all events for RunFrame live preview
    set((state) => ({
      pendingEditEvents: [...state.pendingEditEvents, event],
    }));

    // When drag completes, bake position into TSX
    if (event.in_progress) return;

    const { circuitJson, tsxCode } = get();
    if (!circuitJson) return;

    const parsed = parseLocationEditEvent(event);
    if (!parsed) {
      // Unknown event shape — keep buffered events so RunFrame can still
      // render the drag, but don't try to bake position.
      return;
    }

    const componentName = resolveComponentName(
      circuitJson,
      parsed.kind === "pcb" ? parsed.componentId : undefined,
      parsed.kind === "schematic" ? parsed.componentId : undefined
    );

    if (!componentName) {
      console.warn("[circuit] drag edit: couldn't resolve component name", parsed);
      toast.error("Drag edit lost", {
        description: "Couldn't find the dragged component in the source. Try again or undo.",
      });
      // Don't clear pendingEditEvents — let the next render reset them.
      return;
    }

    const propX = parsed.kind === "pcb" ? "pcbX" : "schX";
    const propY = parsed.kind === "pcb" ? "pcbY" : "schY";
    let newTsx = tsxUpdateProp(tsxCode, componentName, propX, String(parsed.center.x));
    newTsx = tsxUpdateProp(newTsx, componentName, propY, String(parsed.center.y));
    set((state) => ({
      tsxCode: newTsx,
      pendingEditEvents: [],
      ...pushHistory(state.history, state.historyIndex, newTsx),
    }));
  },

  // ─── PCB transform bake (drag + rotate from PcbCanvas) ──────────────────

  bakePcbComponentTransform: (updates) => {
    if (updates.length === 0) return;
    let tsx = get().tsxCode;
    for (const u of updates) {
      if (u.x !== undefined) {
        tsx = tsxUpdateNumericProp(tsx, u.name, "pcbX", u.x);
      }
      if (u.y !== undefined) {
        tsx = tsxUpdateNumericProp(tsx, u.name, "pcbY", u.y);
      }
      if (u.rotation !== undefined) {
        // Normalize to [0, 360). At 0 we strip the prop so the tsx stays
        // clean AND any prior non-zero pcbRotation gets cleared — otherwise
        // rotating from e.g. 270° back to 0° would leave `pcbRotation={270}`
        // stale in the source, and an undo / history replay would snap the
        // part back to 270.
        const norm = (((u.rotation % 360) + 360) % 360);
        if (norm === 0) {
          tsx = tsxRemoveProp(tsx, u.name, "pcbRotation");
        } else {
          tsx = tsxUpdateNumericProp(tsx, u.name, "pcbRotation", norm);
        }
      }
      if (u.layer !== undefined) {
        tsx = tsxSetComponentLayer(tsx, u.name, u.layer);
      }
    }
    if (tsx === get().tsxCode) return;
    // NOTE: do NOT touch circuitJson here. Clearing it would cause the
    // PCB canvas to flash through "No PCB yet" between this bake and the
    // next eval. The pcbModel reads manualEdits.pcb as an optimistic override
    // so the canvas keeps showing the dragged position until eval lands a new
    // circuit-json that already matches — at which point useBackgroundEvaluator
    // reconciles (drops) the now-redundant override. The override is therefore
    // transient (drag preview), NOT a second source of truth for position.
    set((state) => ({
      tsxCode: tsx,
      ...pushHistory(state.history, state.historyIndex, tsx),
    }));
  },

  // ─── Direct TSX replacement ───────────────────────────────────────────────

  setTsxCode: (tsx) => {
    // Mirror applyAiEdit: defensively re-key so the sidecar always has a
    // stable target. injectKeysIntoTsx is idempotent for already-keyed tsx.
    const keyed = injectKeysIntoTsx(tsx);
    set((state) => ({
      tsxCode: keyed,
      circuitJson: null,
      drcViolations: [],
      evalIssues: [],
      ...pushHistory(state.history, state.historyIndex, keyed),
    }));
  },

  // ─── History ──────────────────────────────────────────────────────────────

  saveSnapshot: () => {
    set((state) => pushHistory(state.history, state.historyIndex, state.tsxCode));
  },

  undo: () => {
    set((state) => {
      if (state.historyIndex <= 0) return {};
      const newIndex = state.historyIndex - 1;
      return { tsxCode: state.history[newIndex], historyIndex: newIndex };
    });
  },

  redo: () => {
    set((state) => {
      if (state.historyIndex >= state.history.length - 1) return {};
      const newIndex = state.historyIndex + 1;
      return { tsxCode: state.history[newIndex], historyIndex: newIndex };
    });
  },

  canUndo: () => get().historyIndex > 0,
  canRedo: () => get().historyIndex < get().history.length - 1,

  // ─── File I/O ─────────────────────────────────────────────────────────────

  resetCircuit: () => {
    set({
      tsxCode: DEFAULT_TSX,
      pendingEditEvents: [],
      selectedComponentName: null,
      history: [DEFAULT_TSX],
      historyIndex: 0,
      metadata: { title: "Untitled Circuit" },
      // Drop the prior project's render so the read-only schematic doesn't show
      // it under the new (empty) project until the next eval lands.
      circuitJson: null,
      drcViolations: [],
      evalError: null,
      evalIssues: [],
      evalIssuesVersion: 0,
      evalVersion: 0,
      evalInputHash: null,
      evalErrorHash: null,
    });
    useEditorStore.getState().reset();
  },

  loadProject: (data) => {
    let tsx: string;
    let manualEdits: ManualEditsMap = {};
    let metadata: { title: string } | undefined;

    if (typeof data.tsxCode === "string") {
      const result = parseProjectData(data);
      tsx = result.project.tsxCode;
      manualEdits = result.project.manualEdits;
      // Use the parsed/coerced metadata (whitelisted to { title }) rather than
      // the raw input, so a stale field from an older file can't leak through.
      metadata = result.project.metadata;
    } else {
      tsx = DEFAULT_TSX;
    }

    set({
      tsxCode: tsx,
      pendingEditEvents: [],
      metadata: metadata ?? { title: "Untitled Circuit" },
      selectedComponentName: null,
      history: [tsx],
      historyIndex: 0,
      // Clear the outgoing project's render + error so the read-only schematic
      // shows "Building schematic…" for the new tsx rather than the prior
      // project's stale circuit (or a stale failure banner) until eval lands.
      circuitJson: null,
      drcViolations: [],
      evalError: null,
      evalIssues: [],
      evalIssuesVersion: 0,
      evalVersion: 0,
      evalInputHash: null,
      evalErrorHash: null,
    });

    // Hydrate the editor sidecar. Avoid pulling editorStore into render-path
    // hot-loops by importing through the static reference at the top of the
    // file; setManualEdits resets `localEditsSinceEval` to 0 too.
    useEditorStore.getState().setManualEdits(manualEdits);
    useEditorStore.getState().clearSelection();
  },

  getProjectData: () => {
    const state = get();
    // Prune any sidecar entries whose component was removed from tsx since
    // the last save — keeps the file from accumulating dead state. PCB-route
    // liveness can't be read from the tsx (routes are keyed in eval'd
    // port-hint space), so derive the authoritative co-netted-pad set from the
    // current circuit-json; null (no eval yet) tells pruneOrphanEdits to keep
    // every route rather than risk deleting drawn copper.
    const editor = useEditorStore.getState();
    const { manualEdits } = pruneOrphanEdits(
      state.tsxCode,
      editor.manualEdits,
      liveRouteConnIds(state.circuitJson)
    );
    return makeProjectFile({
      tsxCode: state.tsxCode,
      manualEdits,
      metadata: state.metadata,
    });
  },

  // ─── AI ───────────────────────────────────────────────────────────────────

  applyAiEdit: (tsxCode) => {
    // The AI is supposed to preserve key="..." props on existing components
    // and emit them on new ones, but we defensively re-inject so a forgetful
    // model doesn't strand the sidecar. Existing valid keys are preserved.
    //
    // Position props (pcbX/pcbY/pcbRotation, schX/schY/schRotation) are the
    // source of truth for layout (Option B) and the model is told to preserve
    // them like key=. We rely on the prompt for that — no re-injection here.
    const keyed = injectKeysIntoTsx(tsxCode);
    // No-op edit: the model re-emitted the current circuit unchanged. Skip the
    // state churn (and the circuitJson null that triggers a re-eval) and tell the
    // caller there's nothing to validate. Otherwise `useEffect([tsxCode])` never
    // refires for an identical string, no fresh eval lands, and the chat's
    // validation cycle hangs on `circuitJson === null` until its backstop fires.
    if (keyed === get().tsxCode) return false;
    set((state) => ({
      tsxCode: keyed,
      circuitJson: null,
      drcViolations: [],
      evalError: null,
      evalIssues: [],
      ...pushHistory(state.history, state.historyIndex, keyed),
    }));
    get().refreshFootprintIssues();
    return true;
  },

  setCircuitJson: (json) => set({ circuitJson: json, drcViolations: [] }),
  setDrcViolations: (violations) => set({ drcViolations: violations }),
  setValidating: (v) => set({ isValidating: v }),

  setEvalResult: ({ version, inputHash }) => {
    // Monotonic; older results that race in late are dropped silently. A good
    // render clears any failure previously recorded for this input — both the
    // hash and the user-facing banner, together under the one guard.
    if (version <= get().evalVersion) return;
    set({
      evalVersion: version,
      evalInputHash: inputHash,
      evalErrorHash: null,
      evalError: null,
    });
  },

  setEvalIssues: ({ version, issues }) => {
    // Full checks finish asynchronously after the core eval. Only publish them
    // if the corresponding eval is still current.
    if (version !== get().evalVersion) return;
    set({ evalIssues: issues, evalIssuesVersion: version });
  },

  setEvalFailure: ({ version, inputHash, message }) => {
    // Same monotonic guard as setEvalResult, so a late error from a superseded
    // eval can't clobber a newer result. Records the failed input's hash (and
    // message) so the chat validation cycle reacts immediately instead of waiting
    // out its ceiling. Leaves circuitJson + evalInputHash on the last good render
    // so the read-only views keep showing it under a "stale" chip.
    if (version <= get().evalVersion) return;
    set({
      evalVersion: version,
      evalErrorHash: inputHash,
      evalError: message,
      evalIssues: [],
      evalIssuesVersion: version,
      drcViolations: [],
    });
    // A hard compiler/runtime failure leaves the canvas showing stale output,
    // so bring the dedicated Issues surface forward immediately.
    useEditorStore.getState().setIssuesOpen(true);
  },

  // ─── Derived queries ──────────────────────────────────────────────────────

  getCircuitJsonForExport: () => {
    const { circuitJson } = get();
    if (!circuitJson) return null;
    const { manualEdits } = useEditorStore.getState();
    return overlayManualRoutes(circuitJson, manualEdits);
  },

  getComponents: () => {
    return getCachedComponents(get().tsxCode).map(toComponentView);
  },

  getBoardConfig: () => getCachedBoard(get().tsxCode),

  getComponent: (name) => {
    const ec = extractComponentByName(get().tsxCode, name);
    return ec ? toComponentView(ec) : undefined;
  },

  getSelectedComponent: () => {
    const { selectedComponentName, tsxCode } = get();
    if (!selectedComponentName) return undefined;
    const ec = extractComponentByName(tsxCode, selectedComponentName);
    return ec ? toComponentView(ec) : undefined;
  },
}));
