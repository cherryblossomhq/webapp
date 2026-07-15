// PcbToolbar — floating tool dock for the PCB editor.

import {
  MousePointer2,
  Spline,
  Maximize,
  Zap,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import type { PcbRoutingMode, ToolMode } from "@/editor/shared/types";
import { PCB_ROUTING_MODES, routingModeLabel } from "./layers";

interface PcbToolbarProps {
  toolMode: ToolMode;
  routingMode: PcbRoutingMode;
  onSelectTool: (mode: ToolMode) => void;
  onSetRoutingMode: (mode: PcbRoutingMode) => void;
  onFit: () => void;
  onAutoroute: () => void;
  onAutorouteAll: () => void;
  canAutoroute: boolean;
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
  onFit,
  onAutoroute,
  onAutorouteAll,
  canAutoroute,
}: PcbToolbarProps) {
  return (
    <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 flex flex-row items-center gap-1 p-1 rounded-lg bg-sidebar/90 backdrop-blur-sm border border-border shadow-lg">
      {TOOLS.map((tool) => {
        const Icon = tool.icon;
        const active = toolMode === tool.mode;
        return (
          <ToolButton
            key={tool.mode}
            Icon={Icon}
            active={active}
            title={`${tool.label} (${tool.shortcut})`}
            onClick={() => onSelectTool(tool.mode)}
          />
        );
      })}

      <div className="w-px h-6 mx-0.5 bg-border shrink-0" />

      <div className="flex items-center gap-0.5">
        {PCB_ROUTING_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            title={`Routing mode: ${routingModeLabel(mode)} (G cycles)`}
            onClick={() => onSetRoutingMode(mode)}
            className={`h-7 min-w-7 px-1.5 rounded-md text-[10px] font-mono transition-colors ${
              routingMode === mode
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
            }`}
          >
            {routingModeLabel(mode)}
          </button>
        ))}
      </div>

      <div className="w-px h-6 mx-0.5 bg-border shrink-0" />

      <ToolButton
        Icon={Zap}
        title="Autoroute focused net (A)"
        disabled={!canAutoroute}
        onClick={onAutoroute}
      />

      <ToolButton
        Icon={Waypoints}
        title="Autoroute all nets (⇧A)"
        disabled={!canAutoroute}
        onClick={onAutorouteAll}
      />

      <ToolButton Icon={Maximize} title="Fit to view (F)" onClick={onFit} />
    </div>
  );
}

function ToolButton({
  Icon,
  active = false,
  disabled = false,
  title,
  onClick,
}: {
  Icon: LucideIcon;
  active?: boolean;
  disabled?: boolean;
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
      className={`size-8 flex items-center justify-center rounded-md transition-colors ${
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
