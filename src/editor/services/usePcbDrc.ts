// usePcbDrc — runs routing DRC over the merged circuit-json and publishes the
// violations to circuitStore for the PCB canvas + StatusBar to render.
//
// Mounted by the PCB tab only (PcbTabContent), so DRC does NOT run while the
// user is on the schematic / 3D / BOM tabs — design-rule markers are a
// PCB-view concern and running checks in the background for hidden views just
// burned the main thread. This replaces the earlier wiring that ran DRC inside
// useBackgroundEvaluator on every eval regardless of tab.
//
// Guards:
//   - Debounced so a burst of edits collapses into one check.
//   - Element-count capped: @tscircuit/checks is CPU-bound and synchronous on
//     the JS thread, so on very large boards we skip rather than freeze the UI.
//   - Stale-run guarded: each scheduled run bumps a counter; a late async
//     result is dropped if a newer run has started.
//   - Clears violations on unmount (leaving the PCB tab) so stale markers don't
//     flash when the tab is reopened before the first check completes.

import { useEffect, useRef } from "react";

import { useCircuitStore } from "@/store/circuitStore";
import { useEditorStore } from "@/editor/state/editorStore";
import { runPcbDrc } from "@/editor/pcb/drc";

const DRC_DEBOUNCE_MS = 400;
// Above this element count, skip DRC rather than block the main thread. Real
// hobbyist/pro boards this tool targets are well under it; pathological inputs
// won't freeze the editor. Raise once DRC moves to a worker.
const DRC_MAX_ELEMENTS = 8000;

export function usePcbDrc(): void {
  const circuitJson = useCircuitStore((s) => s.circuitJson);
  const manualEdits = useEditorStore((s) => s.manualEdits);
  const setDrcViolations = useCircuitStore((s) => s.setDrcViolations);

  // Bumped on every scheduled run so a late async result from a superseded
  // run is discarded.
  const runIdRef = useRef(0);

  useEffect(() => {
    if (!circuitJson || circuitJson.length === 0) {
      setDrcViolations([]);
      return;
    }
    const runId = ++runIdRef.current;
    const timer = setTimeout(() => {
      // The manual-route overlay merge is itself O(circuit). Do it INSIDE the
      // debounce window: this effect re-fires on every manualEdits change —
      // every pointermove of a drag — and paying a full circuit-json merge per
      // frame just to throw it away on the next move made dragging chug.
      const merged = useCircuitStore.getState().getCircuitJsonForExport();
      if (!merged || merged.length === 0 || merged.length > DRC_MAX_ELEMENTS) {
        if (runId === runIdRef.current) setDrcViolations([]);
        return;
      }
      void runPcbDrc(merged).then((violations) => {
        if (runId === runIdRef.current) setDrcViolations(violations);
      });
    }, DRC_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      // A run may already be awaiting the lazy checks import. Invalidate its
      // token so it cannot republish violations after a dependency change or
      // after the PCB tab unmounts.
      if (runIdRef.current === runId) runIdRef.current += 1;
    };
    // Re-run whenever the eval output or the manual-route sidecar changes. A
    // tsx edit produces a new circuitJson, so tsxCode isn't needed as a dep.
  }, [circuitJson, manualEdits, setDrcViolations]);

  // Drop markers when the PCB tab unmounts so they don't linger.
  useEffect(() => {
    return () => setDrcViolations([]);
  }, [setDrcViolations]);
}
