import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  X,
} from "lucide-react";
import { useCircuitStore } from "@/store/circuitStore";
import { useEditorStore } from "@/editor/state/editorStore";
import {
  buildEditorIssues,
  countGroupedIssues,
  groupEditorIssues,
  type IssueGroup,
} from "@/editor/issues";
import { COMPACT_BREAKPOINT, useIsTouch } from "@/hooks/useViewport";
import { cn } from "@/lib/utils";

const HEIGHT_KEY = "cherryblossom:issues-panel-height";
// Desktop geometry: a fixed triage list, resizable between these bounds.
const DEFAULT_HEIGHT = 260;
const MIN_HEIGHT = 150;
const MAX_HEIGHT = 520;
/** Desktop ceiling, so a short window still leaves most of the column to the canvas. */
const MAX_HEIGHT_FRACTION = 0.65;
// Compact geometry: the same three numbers, but as fractions of the viewport.
// Fixed pixels don't survive the trip down — on a 667px-tall phone the 260px
// default plus a 40px header is more than half the editor column once the
// toolbar, tab bar and status bar have taken their cut, and the 150px floor
// can outlive the canvas entirely. Scaling all three keeps the canvas the
// majority shareholder at every height the user can drag to.
const COMPACT_DEFAULT_FRACTION = 0.3;
const COMPACT_MIN_FRACTION = 0.18;
const COMPACT_MAX_FRACTION = 0.5;

type SeverityFilter = "all" | "error" | "warning";
type SourceFilter = "all" | "eval" | "drc";

// Read off the window rather than through useIsCompact(): these run inside a
// useState initializer and a resize listener, neither of which is a render.
// Same breakpoint constant, so the two can't drift apart.
function isCompactViewport(): boolean {
  return window.innerWidth < COMPACT_BREAKPOINT;
}

/** Resize bounds + the height to open at, for whichever layout is current. */
function heightBounds(): { min: number; max: number; preferred: number } {
  if (typeof window === "undefined") {
    return { min: MIN_HEIGHT, max: MAX_HEIGHT, preferred: DEFAULT_HEIGHT };
  }
  const vh = window.innerHeight;
  if (isCompactViewport()) {
    const max = Math.floor(vh * COMPACT_MAX_FRACTION);
    return {
      min: Math.min(Math.floor(vh * COMPACT_MIN_FRACTION), max),
      max,
      preferred: Math.floor(vh * COMPACT_DEFAULT_FRACTION),
    };
  }
  const max = Math.min(MAX_HEIGHT, Math.floor(vh * MAX_HEIGHT_FRACTION));
  return { min: Math.min(MIN_HEIGHT, max), max, preferred: DEFAULT_HEIGHT };
}

/** Pixels per arrow-key press on the resize handle. */
const RESIZE_STEP = 24;

function clampHeight(height: number): number {
  const { min, max } = heightBounds();
  return Math.min(Math.max(height, min), max);
}

function persistHeight(height: number): void {
  try {
    localStorage.setItem(HEIGHT_KEY, String(height));
  } catch {
    // The panel remains usable when storage is unavailable.
  }
}

function loadHeight(): number {
  const { preferred } = heightBounds();
  try {
    const raw = localStorage.getItem(HEIGHT_KEY);
    if (raw === null) return clampHeight(preferred);
    const stored = Number(raw);
    return Number.isFinite(stored) ? clampHeight(stored) : clampHeight(preferred);
  } catch {
    return clampHeight(preferred);
  }
}

export function IssuesPanel() {
  const evalIssues = useCircuitStore((s) => s.evalIssues);
  const evalError = useCircuitStore((s) => s.evalError);
  const evalVersion = useCircuitStore((s) => s.evalVersion);
  const evalIssuesVersion = useCircuitStore((s) => s.evalIssuesVersion);
  const circuitJson = useCircuitStore((s) => s.circuitJson);
  const drcViolations = useCircuitStore((s) => s.drcViolations);
  const setIssuesOpen = useEditorStore((s) => s.setIssuesOpen);
  const setActiveTab = useEditorStore((s) => s.setActiveTab);
  const requestDrcFocus = useEditorStore((s) => s.requestDrcFocus);
  const isTouch = useIsTouch();
  const [height, setHeight] = useState(loadHeight);
  const [severity, setSeverity] = useState<SeverityFilter>("error");
  const [source, setSource] = useState<SourceFilter>("all");
  const dragStartRef = useRef<{ y: number; height: number } | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  const groups = useMemo(
    () =>
      groupEditorIssues(
        buildEditorIssues(evalIssues, drcViolations, evalError),
      ),
    [evalIssues, drcViolations, evalError],
  );
  const counts = useMemo(() => countGroupedIssues(groups), [groups]);
  const checking =
    evalError === null &&
    (circuitJson === null || evalIssuesVersion !== evalVersion);

  // Errors are the default triage view. When the circuit has warnings only,
  // show those instead of opening onto an apparently empty panel.
  const effectiveSeverity: SeverityFilter =
    severity === "error" && counts.errors === 0 && counts.warnings > 0
      ? "warning"
      : severity;

  useEffect(() => {
    const onResize = () => setHeight((current) => clampHeight(current));
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      dragCleanupRef.current?.();
    };
  }, []);

  const filtered = useMemo(
    () =>
      groups.filter(
        (group) =>
          (effectiveSeverity === "all" ||
            group.severity === effectiveSeverity) &&
          (source === "all" || group.sources.includes(source)),
      ),
    [groups, effectiveSeverity, source],
  );

  const onResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      dragCleanupRef.current?.();
      dragStartRef.current = { y: event.clientY, height };
      let finalHeight = height;

      const onMove = (moveEvent: PointerEvent) => {
        const start = dragStartRef.current;
        if (!start) return;
        finalHeight = clampHeight(start.height + start.y - moveEvent.clientY);
        setHeight(finalHeight);
      };
      const onEnd = () => {
        dragStartRef.current = null;
        dragCleanupRef.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onEnd);
        window.removeEventListener("pointercancel", onEnd);
        persistHeight(finalHeight);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onEnd);
      window.addEventListener("pointercancel", onEnd);
      dragCleanupRef.current = onEnd;
    },
    [height],
  );

  // The drag handle was pointer-only, so a keyboard user could shrink the
  // canvas by opening the panel and had no way to give the space back.
  const onResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step =
        event.key === "ArrowUp"
          ? RESIZE_STEP
          : event.key === "ArrowDown"
            ? -RESIZE_STEP
            : 0;
      if (step === 0) return;
      event.preventDefault();
      const next = clampHeight(height + step);
      setHeight(next);
      persistHeight(next);
    },
    [height],
  );

  const openGroup = useCallback(
    (group: IssueGroup) => {
      if (group.drcViolationId) {
        requestDrcFocus(group.drcViolationId);
        setActiveTab("pcb");
        return;
      }
      const context = `${group.types.join(" ")} ${group.message}`;
      if (/\bpcb[_ ]/i.test(context)) {
        setActiveTab("pcb");
      } else if (/schematic/i.test(context)) {
        setActiveTab("schematic");
      }
    },
    [requestDrcFocus, setActiveTab],
  );

  // A focusable separator is a window splitter, and a splitter without a
  // reported range announces as "0 percent" at every height.
  const resizeBounds = heightBounds();

  return (
    <section
      className="relative shrink-0 border-t border-border bg-sidebar flex flex-col min-w-0"
      style={{ height }}
      aria-label="Circuit issues"
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize Issues panel"
        tabIndex={0}
        aria-valuenow={height}
        aria-valuemin={resizeBounds.min}
        aria-valuemax={resizeBounds.max}
        onPointerDown={onResizeStart}
        onKeyDown={onResizeKeyDown}
        className={cn(
          // The visual affordance is a 1px line; the hit zone is a transparent
          // band centred on it. 8px is fine for a cursor with a visible hotspot
          // and unhittable with a ~9mm contact patch, so it grows to 24px on a
          // coarse pointer. touch-none keeps the browser from claiming the drag
          // as a scroll and firing pointercancel mid-resize.
          "group absolute inset-x-0 top-0 z-10 -translate-y-1/2 cursor-row-resize touch-none",
          "outline-none",
          isTouch ? "h-6" : "h-2"
        )}
      >
        <div
          className={cn(
            // Hover reveals the line on a mouse. There is no hover on touch, so
            // an invisible-until-hovered grip would simply never exist there.
            // Focus lights the same line hover does — otherwise tabbing to the
            // handle looks identical to nothing having happened.
            "absolute inset-x-0 top-1/2 h-px group-focus-visible:bg-primary",
            isTouch ? "bg-border" : "bg-transparent group-hover:bg-primary"
          )}
        />
        {isTouch && (
          // A short centred pill — the standard "this edge drags" hint, and the
          // only thing marking the band as interactive without a cursor change.
          <span className="absolute left-1/2 top-1/2 h-1 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted-foreground/40" />
        )}
      </div>

      <header
        className={cn(
          "shrink-0 flex items-center gap-2 border-b border-border px-3",
          isTouch ? "h-11" : "h-10"
        )}
      >
        <span className="text-xs font-semibold text-foreground">Issues</span>
        {checking && (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> Checking…
          </span>
        )}

        {/* The filter row scrolls sideways rather than wrapping — it must not
            add a second row of chrome to an already short column. */}
        <div className="ml-2 flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
          <div className="flex items-center gap-1">
            <FilterButton
              active={effectiveSeverity === "all"}
              isTouch={isTouch}
              onClick={() => setSeverity("all")}
            >
              All {counts.errors + counts.warnings}
            </FilterButton>
            <FilterButton
              active={effectiveSeverity === "error"}
              tone="error"
              isTouch={isTouch}
              onClick={() => setSeverity("error")}
            >
              Errors {counts.errors}
            </FilterButton>
            <FilterButton
              active={effectiveSeverity === "warning"}
              tone="warning"
              isTouch={isTouch}
              onClick={() => setSeverity("warning")}
            >
              Warnings {counts.warnings}
            </FilterButton>
          </div>

          <div className="h-4 w-px shrink-0 bg-border" />
          <div className="flex items-center gap-1">
            {(["all", "eval", "drc"] as const).map((value) => (
              <FilterButton
                key={value}
                active={source === value}
                isTouch={isTouch}
                onClick={() => setSource(value)}
              >
                {value === "all" ? "All sources" : value.toUpperCase()}
              </FilterButton>
            ))}
          </div>
        </div>

        <button
          type="button"
          onClick={() => setIssuesOpen(false)}
          className={cn(
            "shrink-0 rounded text-muted-foreground hover:bg-muted hover:text-foreground",
            // p-1 puts a 16px glyph in a 24px target. Pad it out to the 40px
            // floor on touch — it still fits the 44px header.
            isTouch ? "p-3" : "p-1"
          )}
          aria-label="Close Issues panel"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="flex-1 min-h-0 overflow-auto">
        {filtered.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-muted-foreground">
            {checking ? (
              <Loader2 className="size-5 animate-spin" />
            ) : (
              <CheckCircle2 className="size-5 text-emerald-500" />
            )}
            <span className="text-xs">
              {checking
                ? "Checking circuit…"
                : groups.length === 0
                ? "No circuit issues"
                : "No issues match these filters"}
            </span>
          </div>
        ) : (
          <div role="list">
            {filtered.map((group) => (
              <IssueRow key={group.id} group={group} onOpen={openGroup} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function FilterButton({
  active,
  tone,
  isTouch,
  onClick,
  children,
}: {
  active: boolean;
  tone?: "error" | "warning";
  isTouch: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "shrink-0 whitespace-nowrap rounded px-2 py-1 text-[11px] transition-colors",
        // ~24px tall by default — fine for a cursor, a coin-toss for a thumb.
        // 40px is the floor the rest of the mobile chrome holds.
        isTouch && "min-h-10 px-3",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
        active && tone === "error" && "text-red-500",
        active && tone === "warning" && "text-amber-500",
      )}
    >
      {children}
    </button>
  );
}

function IssueRow({
  group,
  onOpen,
}: {
  group: IssueGroup;
  onOpen: (group: IssueGroup) => void;
}) {
  const Icon = group.severity === "error" ? AlertCircle : AlertTriangle;
  const isNavigable =
    !!group.drcViolationId ||
    /pcb|schematic/i.test(`${group.types.join(" ")} ${group.message}`);

  // role="listitem" belongs on a wrapper, not on the button: overriding the
  // button's own role is what dropped every row out of the tab-and-activate
  // story a screen reader gets, while the list still needed listitem children.
  return (
    <div role="listitem">
      <button
        type="button"
        onClick={() => onOpen(group)}
        className={cn(
          "w-full flex items-start gap-2 border-b border-border/50 px-3 py-2 text-left",
          isNavigable && "hover:bg-muted/50",
        )}
      >
        <Icon
          className={cn(
            "mt-0.5 size-3.5 shrink-0",
            group.severity === "error" ? "text-red-500" : "text-amber-500",
          )}
        />
        <span className="min-w-0 flex-1 text-xs leading-relaxed text-foreground break-words">
          {group.message}
        </span>
        {group.count > 1 && (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
            ×{group.count}
          </span>
        )}
        <span className="shrink-0 text-[10px] uppercase text-muted-foreground/70">
          {group.sources.join(" + ")}
        </span>
      </button>
    </div>
  );
}
