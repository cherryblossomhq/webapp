// CodeEditorTab — read/edit the live circuit TSX for debugging.
//
// circuitStore.tsxCode is the single source of truth. This tab keeps a local
// *draft* buffer so half-typed (syntactically broken) TSX never reaches the
// store, the evaluator, or the history ring. Editing model:
//
//   • Apply (button) is the only commit point. It parse-gates the draft via
//     validateTsx(); broken TSX is refused and the error is shown inline, so
//     the canvas/history never see garbage. On success it goes through the
//     "direct replacement" door — setTsxCode() (which re-keys + pushes one
//     history snapshot) followed by refreshFootprintIssues() — deliberately
//     bypassing block locks so a hand-edit is authoritative.
//   • After a successful Apply the buffer is re-seeded from the stored TSX
//     (setTsxCode injects key="..." props), so what you see matches storage
//     and the buffer goes clean.
//
// Sync vs. external writes (AI chat edits, drag bakes, undo/redo, file load):
//   • Clean buffer  → tracks the store live, so the code reflects changes.
//   • Dirty buffer  → sticky; a non-destructive banner lets the user reload
//     from the circuit or keep editing. No silent data loss either direction.

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useCircuitStore } from "@/store/circuitStore";
import { openInEditor } from "@/utils/externalEditor";
import { onBeforeAppReload } from "@/utils/appReload";
import { validateTsx, type TsxValidation } from "@/utils/tsxTransform";
import { useTheme } from "@/hooks/useTheme";
import { Button } from "@/components/ui/button";

// CodeMirror is heavy-ish; keep it off the critical path. EditorShell already
// lazy-loads this whole tab, but lazy-loading the editor itself too means the
// chrome (toolbar/banner) paints instantly while the editor core streams in.
const CodeMirrorLazy = lazy(async () => {
  const [{ default: CodeMirror }, { javascript }] = await Promise.all([
    import("@uiw/react-codemirror"),
    import("@codemirror/lang-javascript"),
  ]);
  const jsx = javascript({ jsx: true, typescript: true });
  function Editor({
    value,
    onChange,
    theme,
  }: {
    value: string;
    onChange: (v: string) => void;
    theme: "light" | "dark";
  }) {
    return (
      <CodeMirror
        value={value}
        onChange={onChange}
        theme={theme}
        height="100%"
        style={{ height: "100%", fontSize: 13 }}
        extensions={[jsx]}
        basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true }}
      />
    );
  }
  return { default: Editor };
});

const CODE_DRAFT_RECOVERY_KEY = "cherryblossom:codeDraftRecovery";

interface CodeDraftRecovery {
  draft: string;
  baseline: string;
}

function readCodeDraftRecovery(): CodeDraftRecovery | null {
  try {
    const raw = sessionStorage.getItem(CODE_DRAFT_RECOVERY_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Partial<CodeDraftRecovery>;
    return typeof saved.draft === "string" && typeof saved.baseline === "string"
      ? { draft: saved.draft, baseline: saved.baseline }
      : null;
  } catch {
    return null;
  }
}

function clearCodeDraftRecovery(): void {
  try {
    sessionStorage.removeItem(CODE_DRAFT_RECOVERY_KEY);
  } catch {
    // The live editor state is already clean, so a stale backup is harmless.
  }
}

export function CodeEditorTab() {
  const tsxCode = useCircuitStore((s) => s.tsxCode);
  const setTsxCode = useCircuitStore((s) => s.setTsxCode);
  const refreshFootprintIssues = useCircuitStore((s) => s.refreshFootprintIssues);
  const { theme } = useTheme();

  // "Download .tsx" — saves a read-only snapshot of the circuit TSX as a file
  // (no sync-back).
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [recovery] = useState(readCodeDraftRecovery);

  const handleOpenInEditor = async () => {
    setOpening(true);
    setOpenError(null);
    try {
      await openInEditor();
    } catch (e) {
      setOpenError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpening(false);
    }
  };

  const [draft, setDraft] = useState(recovery?.draft ?? tsxCode);
  // The store value the draft was seeded from. Drives both dirty-detection
  // (draft !== baseline) and external-change detection (tsxCode !== baseline).
  const [baseline, setBaseline] = useState(recovery?.baseline ?? tsxCode);
  const [parseError, setParseError] = useState<TsxValidation & { ok: false } | null>(
    null
  );
  const [conflict, setConflict] = useState(
    recovery !== null && recovery.baseline !== tsxCode,
  );

  const isDirty = draft !== baseline;
  const recoveryStateRef = useRef({ draft, baseline });

  useEffect(() => {
    recoveryStateRef.current = { draft, baseline };
  }, [draft, baseline]);

  useEffect(() => {
    clearCodeDraftRecovery();
    return onBeforeAppReload((event) => {
      const current = recoveryStateRef.current;
      if (current.draft === current.baseline) {
        clearCodeDraftRecovery();
        return;
      }
      try {
        sessionStorage.setItem(CODE_DRAFT_RECOVERY_KEY, JSON.stringify(current));
      } catch {
        event.preventDefault();
        toast.error("Reload paused to protect Code edits", {
          description: "Apply or copy the unsaved TSX, then reload the app.",
        });
      }
    });
  }, []);

  // React to external store writes (AI edits, drag bakes, undo/redo, file load)
  // using the "adjust state during render" pattern React recommends over a sync
  // effect. `seenTsx` is the last store value we reconciled against; when the
  // store moves past it we either follow it (clean) or flag a conflict (dirty).
  const [seenTsx, setSeenTsx] = useState(tsxCode);
  if (tsxCode !== seenTsx) {
    setSeenTsx(tsxCode);
    if (draft === baseline) {
      // Clean buffer follows the store live.
      setDraft(tsxCode);
      setBaseline(tsxCode);
      setConflict(false);
      setParseError(null);
    } else {
      // Dirty buffer is sticky — surface a conflict, never clobber edits.
      setConflict(true);
    }
  }

  const handleApply = () => {
    const result = validateTsx(draft);
    if (!result.ok) {
      setParseError(result);
      return;
    }
    setParseError(null);
    // Direct replacement (re-keys + one history snapshot), then keep footprint
    // badges fresh.
    setTsxCode(draft);
    refreshFootprintIssues();
    // setTsxCode may have injected key="..." props — re-seed from the stored
    // result so the editor shows the canonical form and the buffer goes clean.
    const stored = useCircuitStore.getState().tsxCode;
    setDraft(stored);
    setBaseline(stored);
    setConflict(false);
    clearCodeDraftRecovery();
  };

  const handleReload = () => {
    setDraft(tsxCode);
    setBaseline(tsxCode);
    setConflict(false);
    setParseError(null);
    clearCodeDraftRecovery();
  };

  const handleKeepEditing = () => {
    // Re-baseline to the current store value so the draft stays dirty relative
    // to the latest circuit; a *further* external change re-raises the banner.
    setBaseline(tsxCode);
    setConflict(false);
  };

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 h-9 border-b border-border bg-sidebar shrink-0">
        <span className="text-xs font-medium text-muted-foreground">
          Circuit TSX
        </span>
        {isDirty ? (
          <span className="flex items-center gap-1 text-xs text-amber-500">
            <span className="size-1.5 rounded-full bg-amber-500" />
            Unsaved edits
          </span>
        ) : (
          <span className="flex items-center gap-1 text-xs text-muted-foreground/70">
            <Check className="size-3" />
            In sync
          </span>
        )}
        <div className="flex-1" />
        <Button
          size="xs"
          variant="outline"
          disabled={opening}
          onClick={() => void handleOpenInEditor()}
          title="Download a read-only snapshot of this circuit's TSX"
        >
          <Download className="size-3" />
          {opening ? "Saving…" : "Download .tsx"}
        </Button>
        <Button
          size="xs"
          variant="default"
          onClick={handleApply}
          disabled={!isDirty}
          title="Parse-check and apply this TSX to the circuit"
        >
          Apply
        </Button>
      </div>

      {/* External-editor launch error */}
      {openError && (
        <div className="flex items-start gap-2 px-3 py-2 border-b border-destructive/30 bg-destructive/10 text-xs">
          <AlertTriangle className="size-3.5 text-destructive shrink-0 mt-0.5" />
          <span className="text-destructive whitespace-pre-wrap">{openError}</span>
        </div>
      )}

      {/* Conflict banner */}
      {conflict && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-amber-500/30 bg-amber-500/10 text-xs">
          <AlertTriangle className="size-3.5 text-amber-500 shrink-0" />
          <span className="text-foreground/90">
            The circuit changed elsewhere while you were editing.
          </span>
          <div className="flex-1" />
          <Button size="xs" variant="ghost" onClick={handleReload}>
            Reload from circuit
          </Button>
          <Button size="xs" variant="ghost" onClick={handleKeepEditing}>
            Keep editing
          </Button>
        </div>
      )}

      {/* Parse error */}
      {parseError && (
        <div className="flex items-start gap-2 px-3 py-2 border-b border-destructive/30 bg-destructive/10 text-xs">
          <AlertTriangle className="size-3.5 text-destructive shrink-0 mt-0.5" />
          <div className="text-destructive font-mono whitespace-pre-wrap">
            {parseError.line != null
              ? `Line ${parseError.line}: ${parseError.error}`
              : parseError.error}
          </div>
        </div>
      )}

      {/* Editor */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading editor…
            </div>
          }
        >
          <CodeMirrorLazy
            value={draft}
            onChange={setDraft}
            theme={theme === "dark" ? "dark" : "light"}
          />
        </Suspense>
      </div>
    </div>
  );
}
