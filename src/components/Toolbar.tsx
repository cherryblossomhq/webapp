import logoUrl from "@/assets/logo.svg";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SettingsMenu } from "@/components/SettingsMenu";
import { ProjectMenu } from "@/components/ProjectMenu";
import { useTheme } from "@/hooks/useTheme";
import { useCircuitStore } from "@/store/circuitStore";
import { Moon, Sun, Undo2, Redo2, HelpCircle, MessageSquare } from "lucide-react";

interface ToolbarProps {
  onNew?: () => void;
  onOpen?: () => void;
  onSave?: () => void;
  onExport?: () => void;
  onHelp?: () => void;
  onToggleChat?: () => void;
  chatOpen?: boolean;
  savedFlash?: boolean;
}

export function Toolbar({ onNew, onOpen, onSave, onExport, onHelp, onToggleChat, chatOpen, savedFlash }: ToolbarProps) {
  const { theme, toggleTheme } = useTheme();

  const historyIndex = useCircuitStore((s) => s.historyIndex);
  const historyLength = useCircuitStore((s) => s.history.length);
  const undo = useCircuitStore((s) => s.undo);
  const redo = useCircuitStore((s) => s.redo);

  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < historyLength - 1;

  return (
    <header className="flex h-10 shrink-0 items-center gap-1 border-b border-border bg-sidebar px-2 text-xs select-none overflow-x-auto">
      <div className="flex items-center gap-1.5 shrink-0 mr-0.5">
        <img src={logoUrl} alt="Cherry Blossom" className="size-5" />
        <span className="font-semibold text-xs tracking-tight">Cherry Blossom</span>
      </div>

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

      <div className="flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={undo}
              disabled={!canUndo}
              aria-label="Undo (Ctrl+Z)"
            >
              <Undo2 className="size-3.5" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Undo (Ctrl+Z)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={redo}
              disabled={!canRedo}
              aria-label="Redo (Ctrl+Shift+Z)"
            >
              <Redo2 className="size-3.5" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Redo (Ctrl+Shift+Z)</TooltipContent>
        </Tooltip>
      </div>

      <div className="flex-1" />

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={chatOpen ? "secondary" : "ghost"}
            size="icon-sm"
            onClick={onToggleChat}
            aria-label={chatOpen ? "Close AI chat" : "Open AI chat"}
            aria-pressed={chatOpen}
          >
            <MessageSquare className="size-3.5" aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">AI Chat ({navigator.platform?.includes("Mac") ? "⌘" : "Ctrl+"}L)</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            onClick={onHelp}
            aria-label="Keyboard shortcuts"
          >
            <HelpCircle className="size-3.5" aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Keyboard shortcuts (?)</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggleTheme}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? (
              <Sun className="size-3.5" aria-hidden="true" />
            ) : (
              <Moon className="size-3.5" aria-hidden="true" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {theme === "dark" ? "Light mode" : "Dark mode"}
        </TooltipContent>
      </Tooltip>

      <SettingsMenu />
    </header>
  );
}
