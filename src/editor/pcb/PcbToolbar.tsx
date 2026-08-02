// PcbToolbar — floating tool dock for the PCB editor.
//
// Two rows. The first is the persistent dock (tools, routing mode, view);
// the second is a CONTEXTUAL strip that only exists on a coarse pointer or a
// compact viewport, where it stands in for keyboard shortcuts that otherwise
// have no reachable trigger at all — Esc (cancel route), Backspace (pop the
// last route point / delete selection), V (via + layer advance).
//
// Positioning is the parent's job: PcbCanvas stacks this and the route banner
// in one absolutely-positioned column so a second row can't overlap the banner.

import {
  CircleDot,
  CornerUpRight,
  Eye,
  Layers,
  Maximize,
  MoreHorizontal,
  MousePointer2,
  Spline,
  Trash2,
  Undo2,
  ShieldAlert,
  Waypoints,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useIsCompact, useIsTouch } from "@/hooks/useViewport";
import type {
  PcbConflictMode,
  PcbRoutingMode,
  RoutePosture,
  ToolMode,
} from "@/editor/shared/types";
import { PCB_ROUTING_MODES, routingModeLabel } from "./layers";

interface PcbToolbarProps {
  toolMode: ToolMode;
  routingMode: PcbRoutingMode;
  onSelectTool: (mode: ToolMode) => void;
  onSetRoutingMode: (mode: PcbRoutingMode) => void;
  onCycleRoutingMode: () => void;
  onFit: () => void;
  onRestoreNetAutoroute: () => void;
  onRestoreBoardAutoroute: () => void;
  canRestoreNet: boolean;
  canRestoreBoard: boolean;
  // ─── Touch / compact affordances ──────────────────────────────────────────
  /** A route draft is in flight — gates the cancel / pop / via actions. */
  drafting: boolean;
  /** The board has ≥2 copper layers, so a via has somewhere to go. */
  canAddVia: boolean;
  onAddVia: () => void;
  onUndoRoutePoint: () => void;
  onCancelRoute: () => void;
  /** Live leader posture / conflict mode — null when no route is in flight. */
  posture: RoutePosture | null;
  onSwapPosture: () => void;
  conflictMode: PcbConflictMode | null;
  onCycleConflictMode: () => void;
  haloVisible: boolean;
  onToggleHalo: () => void;
  hasSelection: boolean;
  onDeleteSelection: () => void;
  /** One-finger drag rubber-band-selects instead of panning. */
  marqueeMode: boolean;
  onToggleMarqueeMode: () => void;
  /** Layer panel visibility — only used while it's an overlay (compact). */
  layersOpen: boolean;
  onToggleLayers: () => void;
}

interface ToolDef {
  mode: ToolMode;
  icon: LucideIcon;
  label: string;
  shortcut: string;
}

const TOOLS: ReadonlyArray<ToolDef> = [
  { mode: "select", icon: MousePointer2, label: "Select & move", shortcut: "S" },
  { mode: "trace", icon: Spline, label: "Route", shortcut: "W" },
];

export function PcbToolbar({
  toolMode,
  routingMode,
  onSelectTool,
  onSetRoutingMode,
  onCycleRoutingMode,
  onFit,
  onRestoreNetAutoroute,
  onRestoreBoardAutoroute,
  canRestoreNet,
  canRestoreBoard,
  drafting,
  canAddVia,
  onAddVia,
  onUndoRoutePoint,
  onCancelRoute,
  posture,
  onSwapPosture,
  conflictMode,
  onCycleConflictMode,
  haloVisible,
  onToggleHalo,
  hasSelection,
  onDeleteSelection,
  marqueeMode,
  onToggleMarqueeMode,
  layersOpen,
  onToggleLayers,
}: PcbToolbarProps) {
  const isTouch = useIsTouch();
  const isCompact = useIsCompact();
  // A `title` tooltip never appears on a coarse pointer, so anything whose only
  // explanation lives in one — including the two re-autoroute buttons, which
  // DISCARD manual work — moves into the overflow menu where the warning is
  // real on-screen text.
  const useOverflow = isTouch || isCompact;

  const contextual = renderContextualRow({
    show: useOverflow,
    routing: toolMode === "trace",
    drafting,
    canAddVia,
    onAddVia,
    onUndoRoutePoint,
    onCancelRoute,
    posture,
    onSwapPosture,
    conflictMode,
    onCycleConflictMode,
    haloVisible,
    onToggleHalo,
    hasSelection,
    onDeleteSelection,
    isTouch,
  });

  return (
    <div className="flex flex-col items-center gap-1 max-w-full">
      <div className="pointer-events-auto flex flex-row items-center gap-1 p-1 rounded-lg bg-sidebar/90 backdrop-blur-sm border border-border shadow-lg">
        {TOOLS.map((tool) => (
          <ToolButton
            key={tool.mode}
            Icon={tool.icon}
            big={isTouch}
            active={toolMode === tool.mode}
            title={`${tool.label} (${tool.shortcut})`}
            onClick={() => onSelectTool(tool.mode)}
          />
        ))}

        <Divider />

        {/* Below the compact breakpoint the three-way segmented control costs
            ~120px the bar doesn't have; one button that cycles (same as G)
            carries the same information in a third of the space. */}
        {isCompact ? (
          <button
            type="button"
            title={`Corner style: ${routingModeLabel(routingMode)} — tap to cycle (⇧Space)`}
            aria-label={`Corner style: ${routingModeLabel(routingMode)}. Activate to cycle.`}
            onClick={onCycleRoutingMode}
            className={`${
              isTouch ? "h-11 min-w-14" : "h-7 min-w-10"
            } px-1.5 rounded-md text-[10px] font-mono bg-primary/15 text-primary transition-colors`}
          >
            {routingModeLabel(routingMode)}
          </button>
        ) : (
          <div className="flex items-center gap-0.5">
            {PCB_ROUTING_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                title={`Corner style: ${routingModeLabel(mode)} (⇧Space cycles)`}
                onClick={() => onSetRoutingMode(mode)}
                className={`${
                  isTouch ? "h-11 min-w-11" : "h-7 min-w-7"
                } px-1.5 rounded-md text-[10px] font-mono transition-colors ${
                  routingMode === mode
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                }`}
              >
                {routingModeLabel(mode)}
              </button>
            ))}
          </div>
        )}

        <Divider />

        {!useOverflow && (
          <>
            <ToolButton
              Icon={Zap}
              big={isTouch}
              title="Re-autoroute focused net — discard its manual routes & deletions (A)"
              disabled={!canRestoreNet}
              onClick={onRestoreNetAutoroute}
            />
            <ToolButton
              Icon={Waypoints}
              big={isTouch}
              title="Re-autoroute board — discard all manual routes & deletions (⇧A)"
              disabled={!canRestoreBoard}
              onClick={onRestoreBoardAutoroute}
            />
          </>
        )}

        <ToolButton
          Icon={Maximize}
          big={isTouch}
          title="Fit to view (F)"
          onClick={onFit}
        />

        {/* The layer panel is docked at desktop widths and an overlay below the
            compact breakpoint, so the toggle only exists in the latter case. */}
        {isCompact && (
          <ToolButton
            Icon={Layers}
            big={isTouch}
            active={layersOpen}
            title="Layers"
            onClick={onToggleLayers}
          />
        )}

        {useOverflow && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="More PCB actions"
                className={`${
                  isTouch ? "size-11" : "size-8"
                } flex items-center justify-center rounded-md transition-colors ${
                  marqueeMode
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                }`}
              >
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-w-72">
              <DropdownMenuCheckboxItem
                checked={marqueeMode}
                onCheckedChange={onToggleMarqueeMode}
              >
                <span className="flex flex-col">
                  <span>Box select</span>
                  <span className="text-[11px] text-muted-foreground">
                    Drag the board to rubber-band select instead of panning.
                  </span>
                </span>
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={!canRestoreNet}
                onSelect={onRestoreNetAutoroute}
              >
                <Zap aria-hidden />
                <span className="flex flex-col">
                  <span>Re-autoroute focused net</span>
                  <span className="text-[11px] text-muted-foreground">
                    Discards that net's manual routes and deletions.
                  </span>
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!canRestoreBoard}
                onSelect={onRestoreBoardAutoroute}
              >
                <Waypoints aria-hidden />
                <span className="flex flex-col">
                  <span>Re-autoroute whole board</span>
                  <span className="text-[11px] text-muted-foreground">
                    Discards every manual route and deletion on the board.
                  </span>
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {contextual}
    </div>
  );
}

// Second row. Route actions while the route tool is up (they're the ones with
// no touch trigger at all), otherwise the delete action whenever something is
// selected — on the PCB tab Del/Backspace is the only way to delete, and
// PropertiesPanel's button is schematic-only.
function renderContextualRow({
  show,
  routing,
  drafting,
  canAddVia,
  onAddVia,
  onUndoRoutePoint,
  onCancelRoute,
  posture,
  onSwapPosture,
  conflictMode,
  onCycleConflictMode,
  haloVisible,
  onToggleHalo,
  hasSelection,
  onDeleteSelection,
  isTouch,
}: {
  show: boolean;
  routing: boolean;
  drafting: boolean;
  canAddVia: boolean;
  onAddVia: () => void;
  onUndoRoutePoint: () => void;
  onCancelRoute: () => void;
  /** Live leader posture / conflict mode — null when no route is in flight. */
  posture: RoutePosture | null;
  onSwapPosture: () => void;
  conflictMode: PcbConflictMode | null;
  onCycleConflictMode: () => void;
  haloVisible: boolean;
  onToggleHalo: () => void;
  hasSelection: boolean;
  onDeleteSelection: () => void;
  isTouch: boolean;
}) {
  if (!show) return null;
  if (!routing && !hasSelection) return null;
  return (
    <div className="pointer-events-auto flex flex-row items-center gap-1 p-1 rounded-lg bg-sidebar/90 backdrop-blur-sm border border-border shadow-lg">
      {routing ? (
        <>
          <ActionChip
            Icon={CornerUpRight}
            // Null means the posture is still being guessed per frame; the chip
            // says so rather than naming whichever guess is current, and tapping
            // it locks a choice.
            label={
              posture === null
                ? "Auto"
                : posture === "diag-first"
                  ? "45 first"
                  : "H/V first"
            }
            title="Swap which leg leaves the corner first (Space or /)"
            disabled={!drafting}
            onClick={onSwapPosture}
            big={isTouch}
          />
          <ActionChip
            Icon={ShieldAlert}
            label={conflictMode === "ignore" ? "Ignore" : "Walk"}
            title="Route around copper, or draw straight through it (⇧R)"
            disabled={!drafting}
            onClick={onCycleConflictMode}
            big={isTouch}
          />
          <ActionChip
            Icon={Eye}
            label="Halo"
            title="Show the clearance the route needs (⇧C)"
            active={haloVisible}
            onClick={onToggleHalo}
            big={isTouch}
          />
          <ActionChip
            Icon={CircleDot}
            label="Via"
            title="Drop a via and continue on the next copper layer (V)"
            disabled={!drafting || !canAddVia}
            onClick={onAddVia}
            big={isTouch}
          />
          <ActionChip
            Icon={Undo2}
            label="Undo pt"
            title="Remove the last route point (Backspace)"
            disabled={!drafting}
            onClick={onUndoRoutePoint}
            big={isTouch}
          />
          <ActionChip
            Icon={X}
            label="Cancel"
            title="Discard the route in progress (Esc)"
            disabled={!drafting}
            onClick={onCancelRoute}
            danger
            big={isTouch}
          />
        </>
      ) : (
        <ActionChip
          Icon={Trash2}
          label="Delete"
          title="Delete the selection (Del)"
          onClick={onDeleteSelection}
          danger
          big={isTouch}
        />
      )}
    </div>
  );
}

function Divider() {
  return <div className="w-px h-6 mx-0.5 bg-border shrink-0" />;
}

function ToolButton({
  Icon,
  active = false,
  disabled = false,
  big = false,
  title,
  onClick,
}: {
  Icon: LucideIcon;
  active?: boolean;
  disabled?: boolean;
  /** 44px hit target — the smallest a fingertip can reliably land on. */
  big?: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`${
        big ? "size-11" : "size-8"
      } flex items-center justify-center rounded-md transition-colors ${
        disabled
          ? "opacity-40 cursor-not-allowed"
          : active
          ? "bg-primary/15 text-primary"
          : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
      }`}
    >
      <Icon className="size-4" />
    </button>
  );
}

// Labelled button for the contextual row. These stand in for keystrokes nobody
// can guess, so they carry visible text rather than an icon and a tooltip.
function ActionChip({
  Icon,
  label,
  title,
  disabled = false,
  danger = false,
  active,
  big = false,
  onClick,
}: {
  Icon: LucideIcon;
  label: string;
  title: string;
  disabled?: boolean;
  danger?: boolean;
  /**
   * Toggle state. LEFT UNDEFINED by the momentary chips (Via, Undo, Cancel,
   * Delete) on purpose: React renders a literal `aria-pressed="false"` for a
   * `false`, which would announce all of them as unpressed toggle buttons.
   */
  active?: boolean;
  big?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`${
        big ? "h-11" : "h-8"
      } flex items-center gap-1.5 px-2.5 rounded-md text-xs transition-colors ${
        disabled
          ? "opacity-40 cursor-not-allowed text-muted-foreground"
          : danger
          ? "text-red-400 hover:bg-red-500/10"
          : active
          ? "bg-primary/15 text-primary"
          : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
      }`}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      {label}
    </button>
  );
}

