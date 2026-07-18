// useBackgroundEvaluator — keeps circuitStore.circuitJson fresh by running
// CircuitEvaluator on every (tsx + manualEdits) change.
//
// Why this exists: the read-only schematic viewer, the PCB / 3D viewers, the
// BOM tab, and the (future) fab-file exporters (Gerber, BOM CSV, pick-and-place
// CSV — see circuit-json-to-* deps in package.json) ALL render from circuitJson.
// This hook is the single producer that keeps it fresh on every tsx change.
//
// Mounting this hook once at the EditorShell level is enough — every tsx
// change triggers a debounced eval, the result lands in circuitStore, and
// every consumer (PCB tab, 3D tab, ExportDialog, etc.) reads from the same
// store value.
//
// Costs: lazy-loads @tscircuit/eval (~8MB) only when the hook first mounts;
// debounce is 300ms so rapid keystrokes don't thrash the worker.

import { useEffect, useRef } from "react";
import { useCircuitStore } from "@/store/circuitStore";
import { useEditorStore } from "@/editor/state/editorStore";
import { CircuitEvaluator, hashInput } from "./CircuitEvaluator";
import { buildPcbModel } from "@/editor/pcb/pcbModel";
import type { StableKey } from "@/editor/shared/types";
import type { AnyCircuitElement } from "circuit-json";
import { log } from "@/utils/logger";
import { collectEvalIssues } from "@/editor/issues";

export function useBackgroundEvaluator(): void {
  const tsxCode = useCircuitStore((s) => s.tsxCode);
  const manualEdits = useEditorStore((s) => s.manualEdits);
  const setCircuitJson = useCircuitStore((s) => s.setCircuitJson);
  const setEvalResult = useCircuitStore((s) => s.setEvalResult);
  const setEvalIssues = useCircuitStore((s) => s.setEvalIssues);
  const setEvalFailure = useCircuitStore((s) => s.setEvalFailure);

  const evaluatorRef = useRef<CircuitEvaluator | null>(null);

  // One-time evaluator construction. Subsequent renders just call schedule().
  useEffect(() => {
    const ev = new CircuitEvaluator({
      onResult: (r) => {
        const circuitJson = r.circuitJson as AnyCircuitElement[];
        // Publish the version/hash before circuitJson. Zustand subscribers run
        // synchronously, and the chat validation gate must see this result's
        // metadata (and the resulting pending issues version) before the JSON
        // becomes available.
        setEvalResult({ version: r.version, inputHash: r.inputHash });
        setCircuitJson(circuitJson);
        if (useCircuitStore.getState().isValidating) {
          // AI edits keep the existing full validation pass before chat reports
          // completion. The store's version guard drops it if a newer edit
          // evaluates first.
          void collectEvalIssues(circuitJson).then((issues) => {
            setEvalIssues({ version: r.version, issues });
          });
        } else {
          // Ordinary edits publish the findings already emitted by eval without
          // paying for a second, CPU-heavy full check pass. PCB routing DRC has
          // its own debounced pass while the PCB tab is visible.
          setEvalIssues({ version: r.version, issues: r.issues });
        }

        // Reconcile the optimistic PCB drag overrides: now that this eval
        // reflects the baked tsx, any sidecar placement that matches the
        // evaluated position has served its purpose as a drag preview and is
        // dropped. Keeping it would let it mask a LATER tsx change (an AI
        // edit, undo, or code-tab edit) — the bug this whole flow fixes.
        // Best-effort: a parse hiccup just leaves overrides untouched.
        try {
          const tsx = useCircuitStore.getState().tsxCode;
          const edits = useEditorStore.getState().manualEdits;
          // Only reconcile when this result still reflects the live state. If
          // tsx/manualEdits changed after this eval dispatched (e.g. the user
          // started another drag), a newer eval is pending — matching this
          // stale circuitJson against the newer overrides could coincidentally
          // drop a still-in-flight drag and reset the part. Skip; the pending
          // eval reconciles once things settle.
          if (hashInput(tsx, edits) !== r.inputHash) return;
          // Empty manualEdits → component coords come straight from the eval.
          const model = buildPcbModel(circuitJson, tsx, {});
          const evalById = new Map<
            StableKey,
            { x: number; y: number; rotation: number }
          >();
          for (const c of model.components) {
            evalById.set(c.key, { x: c.x, y: c.y, rotation: c.rotationDeg });
          }
          useEditorStore.getState().reconcilePcbPlacements(evalById);
        } catch (err) {
          log.warn("[useBackgroundEvaluator] placement reconcile skipped:", err);
        }
      },
      onError: (e) => {
        // Compile / runtime errors (and eval timeouts) land here. circuitStore
        // .circuitJson stays at its previous value, so the read-only schematic
        // keeps showing the last good render. Recording the failed input's hash
        // (not just the message) lets the chat validation cycle react to a failed
        // render of the exact tsx it applied — instead of waiting out its ceiling
        // and mislabeling the eval error as "validation timed out".
        setEvalFailure({ version: e.version, inputHash: e.inputHash, message: e.message });
        log.warn("[useBackgroundEvaluator] eval error:", e.message);
      },
    });
    evaluatorRef.current = ev;
    return () => {
      ev.dispose();
      evaluatorRef.current = null;
    };
  }, [setCircuitJson, setEvalResult, setEvalIssues, setEvalFailure]);

  // Schedule a fresh eval whenever tsx or manualEdits changes.
  useEffect(() => {
    const ev = evaluatorRef.current;
    if (!ev) return;
    ev.schedule(tsxCode, manualEdits);
  }, [tsxCode, manualEdits]);
}
