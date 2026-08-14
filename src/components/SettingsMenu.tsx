import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSettingsStore } from "@/store/settingsStore";
import { Settings } from "lucide-react";

/**
 * Settings gear in the toolbar. Opens the full Settings dialog (Account /
 * Advanced) — see SettingsDialog. Open state lives in settingsStore so the gear,
 * and the Cmd/Ctrl+, shortcut share one source.
 */
export function SettingsMenu() {
  const openSettings = useSettingsStore((s) => s.openSettings);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Settings"
          onClick={() => openSettings()}
        >
          <Settings className="size-3.5" aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        Settings ({navigator.platform?.includes("Mac") ? "⌘" : "Ctrl+"},)
      </TooltipContent>
    </Tooltip>
  );
}
