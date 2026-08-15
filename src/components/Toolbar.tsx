import { useState } from "react";
import logoUrl from "@/assets/logo.svg";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SettingsMenu } from "@/components/SettingsMenu";
import { ProjectMenu, ProjectDialog } from "@/components/ProjectMenu";
import { useTheme } from "@/hooks/useTheme";
import { useIsCompact, useIsTouch } from "@/hooks/useViewport";
import { useCircuitStore } from "@/store/circuitStore";
import { useSettingsStore } from "@/store/settingsStore";
import { cn } from "@/lib/utils";
import { modKeyPrefix } from "@/lib/platform";
import {
  Check,
  Download,
  FilePlus2,
  FolderOpen,
  HelpCircle,
  Moon,
  MoreVertical,
  Redo2,
  Save,
  Settings,
  Sun,
  Undo2,
  type LucideIcon,
} from "lucide-react";

interface ToolbarProps {
  onNew?: () => void;
  onOpen?: () => void;
  onSave?: () => void;
  onExport?: () => void;
  onHelp?: () => void;
  savedFlash?: boolean;
}

/**
 * Toolbar icon button. Wraps the tooltip + aria-label pairing every one of these
 * needs, and grows the hit area on touch — the base 28px `icon-sm` is well under
 * a fingertip. `tooltip` defaults to `label` for the common case where the
 * accessible name and the hint are the same string.
 */
function ToolbarIconButton({
  icon: Icon,
  label,
  tooltip,
  onClick,
  disabled,
  active,
  large,
  className,
}: {
  icon: LucideIcon;
  label: string;
  tooltip?: string;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  large: boolean;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={active ? "secondary" : "ghost"}
          size="icon"
          className={cn(large ? "size-10" : "size-7", className)}
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          aria-pressed={active}
        >
          <Icon className={large ? "size-[18px]" : "size-3.5"} aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip ?? label}</TooltipContent>
    </Tooltip>
  );
}

export function Toolbar({
  onNew,
  onOpen,
  onSave,
  onExport,
  onHelp,
  savedFlash,
}: ToolbarProps) {
  const { theme, toggleTheme } = useTheme();
  // Structure keys off available width, hit sizing off pointer type: a narrow
  // desktop window needs the collapsed layout but not fingertip-sized targets.
  const isCompact = useIsCompact();
  const isTouch = useIsTouch();
  const openSettings = useSettingsStore((s) => s.openSettings);
  const [projectOpen, setProjectOpen] = useState(false);

  const historyIndex = useCircuitStore((s) => s.historyIndex);
  const historyLength = useCircuitStore((s) => s.history.length);
  const undo = useCircuitStore((s) => s.undo);
  const redo = useCircuitStore((s) => s.redo);

  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < historyLength - 1;

  const themeLabel = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";

  return (
    <header
      className={cn(
        "flex shrink-0 items-center gap-1 border-b border-border bg-sidebar px-2 text-xs select-none",
        // No overflow-x-auto: the compact layout fits, and `overflow-x` alone
        // also makes `overflow-y` compute to `auto`, so the bar became a
        // scroll container that a horizontal scrollbar ate 15px of.
        isTouch ? "h-12" : "h-10",
      )}
    >
      <div className="flex items-center gap-1.5 shrink-0 mr-0.5">
        <img src={logoUrl} alt="Cherry Blossom" className="size-5" />
        {!isCompact && (
          <span className="font-semibold text-xs tracking-tight">Cherry Blossom</span>
        )}
      </div>

      {isCompact ? (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className={cn("gap-1", isTouch && "h-10 px-3 text-sm")}
              >
                {savedFlash ? (
                  <>
                    <Check className="size-3.5 text-primary" aria-hidden="true" />
                    Saved
                  </>
                ) : (
                  "File"
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={onNew}>
                <FilePlus2 aria-hidden="true" />
                New
                {!isTouch && <DropdownMenuShortcut>{modKeyPrefix()}N</DropdownMenuShortcut>}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onOpen}>
                <FolderOpen aria-hidden="true" />
                Open…
                {!isTouch && <DropdownMenuShortcut>{modKeyPrefix()}O</DropdownMenuShortcut>}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onSave}>
                <Save aria-hidden="true" />
                Save
                {!isTouch && <DropdownMenuShortcut>{modKeyPrefix()}S</DropdownMenuShortcut>}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onExport}>
                <Download aria-hidden="true" />
                Export…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setProjectOpen(true)}>
                Project settings…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <ProjectDialog open={projectOpen} onOpenChange={setProjectOpen} />
        </>
      ) : (
        <>
          <ProjectMenu />

          <div className="flex items-center gap-0.5">
            <Button variant="ghost" size="sm" onClick={onNew}>New</Button>
            <Button variant="ghost" size="sm" onClick={onOpen}>Open</Button>
            <Button
              variant="ghost"
              size="sm"
              className={savedFlash ? "text-primary" : undefined}
              onClick={onSave}
            >
              {savedFlash ? "Saved" : "Save"}
            </Button>
            <Button variant="ghost" size="sm" onClick={onExport}>Export</Button>
          </div>
        </>
      )}

      <div className="flex items-center gap-0.5">
        <ToolbarIconButton
          icon={Undo2}
          label="Undo (Ctrl+Z)"
          onClick={undo}
          disabled={!canUndo}
          large={isTouch}
        />
        <ToolbarIconButton
          icon={Redo2}
          label="Redo (Ctrl+Shift+Z)"
          onClick={redo}
          disabled={!canRedo}
          large={isTouch}
        />
      </div>

      <div className="flex-1" />

      {isCompact ? (
        // Help / theme / settings are all secondary — collapsing them into one
        // menu is what buys the room to keep undo/redo on the bar, which is
        // where they belong. Previously all four were pushed off-screen
        // entirely, making Settings reachable only by keyboard shortcut.
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={isTouch ? "size-10" : "size-7"}
              aria-label="More options"
            >
              <MoreVertical
                className={isTouch ? "size-[18px]" : "size-3.5"}
                aria-hidden="true"
              />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onHelp}>
              <HelpCircle aria-hidden="true" />
              Keyboard shortcuts
              {!isTouch && <DropdownMenuShortcut>?</DropdownMenuShortcut>}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={toggleTheme}>
              {theme === "dark" ? (
                <Sun aria-hidden="true" />
              ) : (
                <Moon aria-hidden="true" />
              )}
              {theme === "dark" ? "Light mode" : "Dark mode"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => openSettings()}>
              <Settings aria-hidden="true" />
              Settings
              {!isTouch && <DropdownMenuShortcut>{modKeyPrefix()},</DropdownMenuShortcut>}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <>
          <ToolbarIconButton
            icon={HelpCircle}
            label="Keyboard shortcuts"
            tooltip="Keyboard shortcuts (?)"
            onClick={onHelp}
            large={false}
            className="text-muted-foreground"
          />
          <ToolbarIconButton
            icon={theme === "dark" ? Sun : Moon}
            label={themeLabel}
            tooltip={theme === "dark" ? "Light mode" : "Dark mode"}
            onClick={toggleTheme}
            large={false}
          />
          <SettingsMenu />
        </>
      )}
    </header>
  );
}
