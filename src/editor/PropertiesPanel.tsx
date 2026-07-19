import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useCircuitStore } from "@/store/circuitStore";
import { useEditorStore } from "@/editor/state/editorStore";
import {
  buildPcbModel,
  withAutoPlacedPins,
  type PcbTransformPatch,
} from "@/editor/pcb/pcbModel";
import {
  copperLayersForCount,
  getLayerColor,
  DEFAULT_TRACE_WIDTH_MM,
  TRACE_WIDTH_PROFILES,
  profileForId,
  profileForWidth,
  type LayerConfig,
} from "@/editor/pcb/layers";
import type { LayerId, StableKey } from "@/editor/shared/types";
import { componentNamesForKeys } from "@/editor/shared/componentSelection";
import { extractComponentByName } from "@/utils/tsxTransform";
import { COMPONENT_LIBRARY } from "@/data/components";
import { isChipLike } from "@/editor/schematic/symbols";
import { AlertTriangle, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

// Match the app chrome (status bar, tab bar): 11px labels, compact inputs.
const FIELD_LABEL =
  "text-[11px] font-normal leading-none text-muted-foreground";
const FIELD_INPUT = "font-mono h-7 text-[11px] rounded-md";

function SectionHeader({
  title,
  hint,
}: {
  title: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-[11px] font-medium text-muted-foreground">{title}</p>
      {hint && (
        <p className="text-[10px] leading-snug text-muted-foreground/80">
          {hint}
        </p>
      )}
    </div>
  );
}

function PropertyField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label className={FIELD_LABEL}>{label}</Label>
      {children}
    </div>
  );
}

export function PropertiesPanel() {
  // Use individual selectors so this panel only re-renders when its inputs
  // actually change — not on every store mutation.
  const updateComponent = useCircuitStore((s) => s.updateComponent);
  const setComponentPinCount = useCircuitStore((s) => s.setComponentPinCount);
  const setComponentPinLabels = useCircuitStore((s) => s.setComponentPinLabels);
  const renameComponent = useCircuitStore((s) => s.renameComponent);
  const removeComponent = useCircuitStore((s) => s.removeComponent);
  const bakePcbComponentTransform = useCircuitStore(
    (s) => s.bakePcbComponentTransform
  );

  // Track tsxCode + selection so derived getters re-evaluate on real changes.
  const tsxCode = useCircuitStore((s) => s.tsxCode);
  const circuitJson = useCircuitStore((s) => s.circuitJson);
  const manualEdits = useEditorStore((s) => s.manualEdits);
  const setPcbEdit = useEditorStore((s) => s.setPcbEdit);
  const setTraceWidth = useEditorStore((s) => s.setTraceWidth);
  const setActiveWidthProfile = useEditorStore((s) => s.setActiveWidthProfile);
  const selectedName = useCircuitStore((s) => s.selectedComponentName);
  const footprintIssues = useCircuitStore((s) => s.footprintIssues);
  const getSelectedComponent = useCircuitStore((s) => s.getSelectedComponent);
  const getComponent = useCircuitStore((s) => s.getComponent);
  const boardLayerCount = useCircuitStore((s) => s.getBoardConfig().layers);

  // Phase 1: prefer the new editor's selection (selectedKeys, by stable
  // key) over the legacy circuitStore selectedComponentName (by source name).
  // We resolve keys back to source names via the tsx so the rest of the
  // panel — which is name-based — keeps working.
  const selectedKeys = useEditorStore((s) => s.selectedKeys);
  // Component deletion only happens in the schematic — the PCB view is the
  // PHYSICAL layout and treats parts as placed/routed; removing a footprint
  // there would silently break the netlist's source of truth. The button
  // is still rendered on every other tab as long as the active tab is
  // "schematic".
  const activeTab = useEditorStore((s) => s.activeTab);
  const canDeleteComponents = activeTab === "schematic";
  const selectedNamesFromKeys = useMemo(
    () => componentNamesForKeys(tsxCode, selectedKeys),
    [tsxCode, selectedKeys]
  );

  // Effective single-component view: prefer key-based selection (Phase 1
  // canonical); fall back to legacy name-based selection only when keys
  // are empty (e.g. RunFrame click on PCB tab still uses the old path).
  const selectedComponent = useMemo(() => {
    if (selectedNamesFromKeys.length === 1) {
      return getComponent(selectedNamesFromKeys[0]);
    }
    if (selectedNamesFromKeys.length === 0 && selectedName) {
      return getSelectedComponent();
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tsxCode, selectedName, selectedNamesFromKeys]);
  const [designatorInput, setDesignatorInput] = useState("");
  const [designatorError, setDesignatorError] = useState<string | undefined>(
    undefined
  );

  useEffect(() => {
    if (!selectedComponent) {
      setDesignatorInput("");
      setDesignatorError(undefined);
      return;
    }
    setDesignatorInput(selectedComponent.name);
    setDesignatorError(undefined);
  }, [selectedComponent?.name]);

  const commitDesignatorRename = () => {
    if (!selectedComponent) return;
    const nextName = designatorInput.trim();
    const currentName = selectedComponent.name;

    if (nextName === currentName) {
      setDesignatorInput(currentName);
      setDesignatorError(undefined);
      return;
    }

    const result = renameComponent(currentName, nextName);
    if (!result.success) {
      setDesignatorInput(currentName);
      setDesignatorError((result as { success: false; error: string }).error);
      return;
    }

    setDesignatorError(undefined);
  };

  const def = selectedComponent
    ? COMPONENT_LIBRARY[selectedComponent.type]
    : undefined;

  // Chip-like (imported JLC chip OR library IC / connector): expose
  // pinCount + pinLabels for direct editing in the panel. Reading from the
  // live tsx (not the COMPONENT_LIBRARY) so imported parts with arbitrary
  // pinouts show their actual labels.
  const chipPinInfo = useMemo(() => {
    if (!selectedComponent) return null;
    if (!isChipLike(selectedComponent.elementTag)) return null;
    const raw = extractComponentByName(tsxCode, selectedComponent.name);
    if (!raw) return null;
    const pinCount = parsePinCountString(raw.props.pinCount) ?? 0;
    const labels = parsePinLabelsString(raw.props.pinLabels, pinCount);
    return { pinCount, labels };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tsxCode, selectedComponent?.name, selectedComponent?.elementTag]);

  // The PCB model is only consulted for board placement / trace fields, which
  // exist only on the PCB tab with a single component or trace selected.
  // buildPcbModel is heavy (re-parses the TSX, walks the whole circuit-json)
  // and this panel subscribes to manualEdits, so building it unconditionally
  // would duplicate PcbCanvas's per-frame model build on every drag — including
  // while the drawer is closed. Gate it so the work is only done when a field
  // that needs it is actually on screen.
  const needsPcbModel =
    activeTab === "pcb" && (!!selectedComponent || selectedKeys.size === 1);
  const pcbModel = useMemo(
    () =>
      needsPcbModel ? buildPcbModel(circuitJson, tsxCode, manualEdits) : null,
    [needsPcbModel, circuitJson, tsxCode, manualEdits]
  );

  const selectedPcbComponent = useMemo(() => {
    if (!selectedComponent || !pcbModel) return null;
    return (
      pcbModel.components.find((c) => c.name === selectedComponent.name) ??
      null
    );
  }, [pcbModel, selectedComponent?.name]);

  const selectedTrace = useMemo((): { key: StableKey; width: number } | null => {
    if (selectedKeys.size !== 1 || activeTab !== "pcb" || !pcbModel) return null;
    const key = [...selectedKeys][0];
    const record = pcbModel.byKey.get(key);
    if (!record || !("segments" in record) || !record.userRouted) return null;
    const width =
      manualEdits[key]?.pcb?.width ??
      record.segments[0]?.width ??
      DEFAULT_TRACE_WIDTH_MM;
    return { key, width };
  }, [selectedKeys, activeTab, pcbModel, manualEdits]);

  const showBoardFields = activeTab === "pcb" && !!selectedPcbComponent;
  const showTraceFields = activeTab === "pcb" && !!selectedTrace;

  const selectedComponentKey = useMemo((): StableKey | null => {
    if (!selectedComponent) return null;
    const raw = extractComponentByName(tsxCode, selectedComponent.name);
    return (raw?.props.key as StableKey | undefined) ?? null;
  }, [tsxCode, selectedComponent?.name]);

  const applyPcbPlacement = useCallback(
    (patch: PcbTransformPatch) => {
      if (!selectedComponent) return;
      const name = selectedComponent.name;
      const key = selectedComponentKey;

      if (
        key &&
        (patch.x !== undefined || patch.y !== undefined)
      ) {
        const cur = manualEdits[key]?.pcb;
        setPcbEdit(key, {
          ...cur,
          ...(patch.x !== undefined ? { x: patch.x } : {}),
          ...(patch.y !== undefined ? { y: patch.y } : {}),
        });
      }

      const hasBake =
        patch.x !== undefined ||
        patch.y !== undefined ||
        patch.rotation !== undefined ||
        patch.layer !== undefined;
      if (!hasBake) return;

      const needsAutoPlacedPins =
        patch.x !== undefined ||
        patch.y !== undefined ||
        patch.rotation !== undefined;
      const updates = [{ name, ...patch }];
      bakePcbComponentTransform(
        needsAutoPlacedPins && pcbModel && pcbModel.components.length > 0
          ? withAutoPlacedPins(pcbModel, updates)
          : updates
      );
    },
    [
      bakePcbComponentTransform,
      manualEdits,
      pcbModel,
      selectedComponent,
      selectedComponentKey,
      setPcbEdit,
    ]
  );

  const applySelectedTraceWidth = useCallback(
    (width: number) => {
      if (!selectedTrace) return;
      const route = manualEdits[selectedTrace.key]?.pcb?.route;
      setPcbEdit(selectedTrace.key, {
        ...(manualEdits[selectedTrace.key]?.pcb ?? {}),
        width,
        ...(route ? { route: route.map((p) => ({ ...p, width })) } : {}),
      });
    },
    [selectedTrace, manualEdits, setPcbEdit]
  );

  // Multi-select mode (2+): show a summary with batch delete. Bulk
  // edit-of-shared-props is a Phase 3 polish item per the plan.
  const isMultiSelect = selectedNamesFromKeys.length > 1;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center h-8 px-3 border-b border-border shrink-0">
        <p className="text-[11px] font-medium text-foreground truncate">
          {isMultiSelect
            ? `${selectedNamesFromKeys.length} components selected`
            : selectedTrace
              ? "Trace"
              : selectedComponent
                ? selectedComponent.name
                : "Properties"}
        </p>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-3 flex flex-col gap-3">
        {isMultiSelect ? (
          <MultiSelectPanel names={selectedNamesFromKeys} />
        ) : showTraceFields && selectedTrace ? (
          <TraceFields
            width={selectedTrace.width}
            onApplyWidth={(width) => {
              applySelectedTraceWidth(width);
              setTraceWidth(width);
            }}
            onApplyProfile={(profileId) => {
              const profile = profileForId(profileId);
              if (!profile) return;
              applySelectedTraceWidth(profile.widthMm);
              setActiveWidthProfile(profileId);
            }}
          />
        ) : selectedComponent ? (
          <>
            <PropertyField label="Designator">
              <div className="flex flex-col gap-1">
                <Input
                  value={designatorInput}
                  onChange={(e) => {
                    setDesignatorInput(e.target.value);
                    if (designatorError) setDesignatorError(undefined);
                  }}
                  onBlur={commitDesignatorRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      commitDesignatorRename();
                      e.currentTarget.blur();
                    }
                    if (e.key === "Escape") {
                      setDesignatorInput(selectedComponent.name);
                      setDesignatorError(undefined);
                    }
                  }}
                  className={FIELD_INPUT}
                />
                {designatorError && (
                  <p className="text-[11px] text-destructive">
                    {designatorError}
                  </p>
                )}
              </div>
            </PropertyField>

            <PropertyField label="Type">
              <Input
                value={def?.displayName ?? selectedComponent.type}
                readOnly
                className={cn(FIELD_INPUT, "bg-muted/50")}
              />
            </PropertyField>

            <PropertyField label="Value">
              <Input
                value={selectedComponent.value}
                onChange={(e) =>
                  updateComponent(selectedComponent.name, {
                    value: e.target.value,
                  })
                }
                className={FIELD_INPUT}
              />
            </PropertyField>

            <PropertyField label="Footprint">
              <div className="flex flex-col gap-1">
                <Input
                  value={selectedComponent.footprint}
                  onChange={(e) =>
                    updateComponent(selectedComponent.name, {
                      footprint: e.target.value,
                    })
                  }
                  className={FIELD_INPUT}
                />
                {(() => {
                  const issue = footprintIssues.find(
                    (i) => i.componentName === selectedComponent.name
                  );
                  if (!issue) return null;
                  return (
                    <div className="flex items-start gap-1.5 px-2 py-1.5 rounded-md text-[11px] leading-snug bg-amber-500/10 text-amber-800 dark:text-amber-300">
                      <AlertTriangle className="size-3 shrink-0 mt-0.5" />
                      <span>
                        {issue.kind === "missing"
                          ? "Footprint is missing. Add one before fabrication."
                          : issue.kind === "mismatch"
                            ? `Footprint does not match the imported part (expected ${issue.expected}).`
                            : "Footprint is not in the canonical catalog."}
                      </span>
                    </div>
                  );
                })()}
              </div>
            </PropertyField>

            {showBoardFields && selectedPcbComponent && (
              <>
                <Separator />
                <PcbPlacementFields
                  x={selectedPcbComponent.x}
                  y={selectedPcbComponent.y}
                  rotation={selectedPcbComponent.rotationDeg}
                  layer={selectedPcbComponent.layer}
                  copperLayers={copperLayersForCount(boardLayerCount)}
                  onApply={applyPcbPlacement}
                />
              </>
            )}

            {chipPinInfo && (
              <>
                <Separator />
                <PinEditor
                pinCount={chipPinInfo.pinCount}
                labels={chipPinInfo.labels}
                onPinCountChange={(n) =>
                  setComponentPinCount(selectedComponent.name, n)
                }
                onLabelChange={(idx, label) => {
                  const next = [...chipPinInfo.labels];
                  // Pad with empties if the user is naming a pin that doesn't
                  // have a slot yet (e.g. pinCount=8, only 4 names exist).
                  while (next.length < chipPinInfo.pinCount) next.push("");
                  next[idx] = label;
                  setComponentPinLabels(selectedComponent.name, next);
                }}
              />
              </>
            )}

            {canDeleteComponents && (
              <>
                <Separator />

                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-center gap-1.5 text-destructive hover:text-destructive hover:bg-destructive/10 h-7 text-[11px]"
                  onClick={() => removeComponent(selectedComponent.name)}
                >
                  <Trash2 className="size-3.5" />
                  Delete component
                </Button>
              </>
            )}
          </>
        ) : (
          <p className="text-[11px] text-muted-foreground leading-relaxed px-0.5 py-1">
            Select a component to view and edit its properties.
          </p>
        )}
      </div>
    </div>
  );
}

// Board placement — x/y preview via manualEdits; pcbX / pcbY / pcbRotation /
// layer bake into the tsx on commit.
function TraceFields({
  width,
  onApplyWidth,
  onApplyProfile,
}: {
  width: number;
  onApplyWidth: (width: number) => void;
  onApplyProfile: (profileId: string) => void;
}) {
  const activeProfile = profileForWidth(width)?.id ?? "";

  return (
    <>
      <SectionHeader
        title="Trace"
        hint="Width applies to all segments on this connection."
      />
      <PropertyField label="Width profile">
        <select
          value={activeProfile}
          onChange={(e) => {
            if (e.target.value) onApplyProfile(e.target.value);
          }}
          className={cn(
            FIELD_INPUT,
            "w-full appearance-none bg-background border border-input ps-2 pe-7 cursor-pointer"
          )}
        >
          <option value="">Custom</option>
          {TRACE_WIDTH_PROFILES.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label} ({p.widthMm.toFixed(2)} mm)
            </option>
          ))}
        </select>
      </PropertyField>
      <NumericPlacementField
        label="Width (mm)"
        value={width}
        step={0.05}
        onCommit={onApplyWidth}
      />
    </>
  );
}

function PcbPlacementFields({
  x,
  y,
  rotation,
  layer,
  copperLayers,
  onApply,
}: {
  x: number;
  y: number;
  rotation: number;
  layer: LayerId;
  copperLayers: ReadonlyArray<LayerConfig>;
  onApply: (patch: PcbTransformPatch) => void;
}) {
  return (
    <>
      <SectionHeader
        title="Board position"
        hint="Values in millimeters. Layer is written to the circuit source; position and rotation re-evaluate in about 300 ms."
      />
      <PropertyField label="Layer">
        <div className="relative">
          <select
            value={layer}
            onChange={(e) => onApply({ layer: e.target.value as LayerId })}
            className={cn(
              FIELD_INPUT,
              "w-full appearance-none bg-background border border-input ps-2 pe-7 cursor-pointer"
            )}
          >
            {copperLayers.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
          <span
            className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 size-2.5 rounded-sm border border-black/30"
            style={{ background: getLayerColor(layer) }}
            aria-hidden
          />
        </div>
      </PropertyField>
      <div className="grid grid-cols-2 gap-3">
        <NumericPlacementField
          label="X"
          value={x}
          onCommit={(n) => onApply({ x: n })}
        />
        <NumericPlacementField
          label="Y"
          value={y}
          onCommit={(n) => onApply({ y: n })}
        />
      </div>
      <NumericPlacementField
        label="Rotation (°)"
        value={rotation}
        step={1}
        onCommit={(n) => {
          const norm = (((n % 360) + 360) % 360);
          onApply({ rotation: norm });
        }}
      />
    </>
  );
}

function NumericPlacementField({
  label,
  value,
  step = 0.1,
  onCommit,
}: {
  label: string;
  value: number;
  step?: number;
  onCommit: (n: number) => void;
}) {
  const [draft, setDraft] = useState(formatPlacementNumber(value));
  useEffect(() => {
    setDraft(formatPlacementNumber(value));
  }, [value]);

  const commit = () => {
    const n = Number(draft);
    if (!Number.isFinite(n)) {
      setDraft(formatPlacementNumber(value));
      return;
    }
    if (Math.abs(n - value) > 1e-9) onCommit(n);
  };

  return (
    <PropertyField label={label}>
      <Input
        type="number"
        step={step}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            e.currentTarget.blur();
          }
          if (e.key === "Escape") {
            setDraft(formatPlacementNumber(value));
          }
        }}
        className={FIELD_INPUT}
      />
    </PropertyField>
  );
}

function formatPlacementNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

// Editable pin count + per-pin label list for chip-like elements. Both the
// count and the labels write straight back into the source tsx, so the
// schematic re-renders on each change without an evaluator round-trip.
function PinEditor({
  pinCount,
  labels,
  onPinCountChange,
  onLabelChange,
}: {
  pinCount: number;
  labels: string[];
  onPinCountChange: (n: number) => void;
  onLabelChange: (idx: number, label: string) => void;
}) {
  const [countDraft, setCountDraft] = useState(String(pinCount));
  // Keep the draft in sync when the underlying pinCount changes (e.g. the
  // user undoes, or another panel mutated the tsx).
  useEffect(() => {
    setCountDraft(String(pinCount));
  }, [pinCount]);

  const commitPinCount = () => {
    const n = Number(countDraft);
    if (Number.isFinite(n) && n > 0 && Math.floor(n) !== pinCount) {
      onPinCountChange(Math.floor(n));
    } else {
      setCountDraft(String(pinCount));
    }
  };

  // Render `pinCount` rows so the user can name pins that don't have an
  // entry in pinLabels yet (e.g. a 16-pin chip imported with only 8 named).
  const rows = Math.max(pinCount, labels.length);

  return (
    <>
      <PropertyField label="Pin count">
        <Input
          type="number"
          min={1}
          step={1}
          value={countDraft}
          onChange={(e) => setCountDraft(e.target.value)}
          onBlur={commitPinCount}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commitPinCount();
              e.currentTarget.blur();
            }
            if (e.key === "Escape") {
              setCountDraft(String(pinCount));
            }
          }}
          className={FIELD_INPUT}
        />
      </PropertyField>

      <PropertyField label="Pin labels">
        <div className="flex flex-col gap-1 max-h-48 overflow-y-auto overscroll-contain">
          {Array.from({ length: rows }, (_, idx) => (
            <PinLabelRow
              key={idx}
              index={idx}
              value={labels[idx] ?? ""}
              onCommit={(label) => onLabelChange(idx, label)}
            />
          ))}
        </div>
      </PropertyField>
    </>
  );
}

// Per-row pin label editor. Local draft state so the underlying tsx isn't
// rewritten on every keystroke (recast re-parse is cheap but pushing one
// history snapshot per character would shred Ctrl+Z).
function PinLabelRow({
  index,
  value,
  onCommit,
}: {
  index: number;
  value: string;
  onCommit: (label: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = () => {
    if (draft !== value) onCommit(draft);
  };

  return (
    <div className="flex gap-1.5 items-center font-mono">
      <span className="text-[10px] text-primary font-semibold min-w-4 text-right tabular-nums">
        {index + 1}
      </span>
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            e.currentTarget.blur();
          }
          if (e.key === "Escape") {
            setDraft(value);
          }
        }}
        placeholder={`pin${index + 1}`}
        className={cn(FIELD_INPUT, "h-6")}
      />
    </div>
  );
}

// Read pinCount out of the raw extracted-prop string. tsxTransform serializes
// `pinCount={8}` as the string "8" (via recast print), so plain Number()
// parsing is enough.
function parsePinCountString(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

// Parse the source text of `pinLabels={{"1": "VCC", "2": "GND"}}` into a
// dense array of length `pinCount` (labels for missing keys are empty
// strings). Uses the same forgiving regex pattern as schematicModel's
// inferPinLabels so the panel agrees with what the canvas is drawing.
function parsePinLabelsString(
  value: string | undefined,
  pinCount: number
): string[] {
  if (!value) return new Array(Math.max(0, pinCount)).fill("");
  const labels = new Array(Math.max(0, pinCount)).fill("");
  const re = /["']?(\d+)["']?\s*:\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    const idx = Number(m[1]) - 1;
    if (idx >= 0 && idx < labels.length) labels[idx] = m[2];
  }
  return labels;
}

// Shown when the editor has 2+ components selected (e.g. via marquee or
// shift-click). Per-prop editing across multiple components is Phase 3
// polish; for now we just list the selection and offer batch delete.
function MultiSelectPanel({ names }: { names: string[] }) {
  const removeComponent = useCircuitStore((s) => s.removeComponent);
  const clearSelection = useEditorStore((s) => s.clearSelection);
  const activeTab = useEditorStore((s) => s.activeTab);
  const canDeleteComponents = activeTab === "schematic";

  const onDeleteAll = () => {
    for (const n of names) removeComponent(n);
    clearSelection();
  };

  return (
    <>
      <div className="rounded-md border border-border bg-muted/30 p-2 flex flex-col gap-1 max-h-[280px] overflow-y-auto">
        {names.map((n) => (
          <div
            key={n}
            className="text-[11px] font-mono text-foreground px-1.5 py-0.5"
          >
            {n}
          </div>
        ))}
      </div>

      <p className="text-[11px] text-muted-foreground leading-relaxed">
        Shared fields are hidden while multiple components are selected. Drag
        any selected part on the canvas to move the group together.
      </p>

      {canDeleteComponents && (
        <>
          <Separator />

          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-center gap-1.5 text-destructive hover:text-destructive hover:bg-destructive/10 h-7 text-[11px]"
            onClick={onDeleteAll}
          >
            <Trash2 className="size-3.5" />
            Delete {names.length} components
          </Button>
        </>
      )}
    </>
  );
}
