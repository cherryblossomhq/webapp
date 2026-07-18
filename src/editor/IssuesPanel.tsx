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
import { cn } from "@/lib/utils";

const HEIGHT_KEY = "cherryblossom:issues-panel-height";
const DEFAULT_HEIGHT = 260;
const MIN_HEIGHT = 150;
const MAX_HEIGHT = 520;

type SeverityFilter = "all" | "error" | "warning";
type SourceFilter = "all" | "eval" | "drc";

function clampHeight(height: number): number {
  const viewportMax =
    typeof window === "undefined"
      ? MAX_HEIGHT
      : Math.max(MIN_HEIGHT, Math.floor(window.innerHeight * 0.65));
  return Math.min(Math.max(height, MIN_HEIGHT), MAX_HEIGHT, viewportMax);
}

function loadHeight(): number {
  try {
    const raw = localStorage.getItem(HEIGHT_KEY);
    if (raw === null) return DEFAULT_HEIGHT;
    const stored = Number(raw);
    return Number.isFinite(stored) ? clampHeight(stored) : DEFAULT_HEIGHT;
  } catch {
    return DEFAULT_HEIGHT;
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
        try {
          localStorage.setItem(
            HEIGHT_KEY,
            String(finalHeight),
          );
        } catch {
          // The panel remains usable when storage is unavailable.
        }
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onEnd);
      window.addEventListener("pointercancel", onEnd);
      dragCleanupRef.current = onEnd;
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
        onPointerDown={onResizeStart}
        className="group absolute inset-x-0 top-0 z-10 h-2 -translate-y-1/2 cursor-row-resize"
      >
        <div className="absolute inset-x-0 top-1/2 h-px bg-transparent group-hover:bg-primary" />
      </div>

      <header className="h-10 shrink-0 flex items-center gap-2 border-b border-border px-3">
        <span className="text-xs font-semibold text-foreground">Issues</span>
        {checking && (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> Checking…
          </span>
        )}

        <div className="ml-2 flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
          <div className="flex items-center gap-1">
            <FilterButton
              active={effectiveSeverity === "all"}
              onClick={() => setSeverity("all")}
            >
              All {counts.errors + counts.warnings}
            </FilterButton>
            <FilterButton
              active={effectiveSeverity === "error"}
              tone="error"
              onClick={() => setSeverity("error")}
            >
              Errors {counts.errors}
            </FilterButton>
            <FilterButton
              active={effectiveSeverity === "warning"}
              tone="warning"
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
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
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
  onClick,
  children,
}: {
  active: boolean;
  tone?: "error" | "warning";
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "shrink-0 whitespace-nowrap rounded px-2 py-1 text-[11px] transition-colors",
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

  return (
    <button
      type="button"
      role="listitem"
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
  );
}
