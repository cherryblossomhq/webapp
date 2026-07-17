/**
 * ShortcutsHelp: Modal overlay showing all keyboard shortcuts.
 * Triggered by pressing ? or clicking Help. Built on the shared shadcn Dialog
 * so the backdrop, focus trap, and Escape contract match every other modal.
 */
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDialogReturnFocus } from "@/hooks/useDialogReturnFocus";
import { cn } from "@/lib/utils";

interface ShortcutsHelpProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Audited against the live handlers: global keys in src/views/EditorView.tsx
// (file / undo / chat / settings) and PCB editing keys in
// src/editor/pcb/PcbCanvas.tsx. The schematic is READ-ONLY — it has no edit
// shortcuts; its only interactions are mouse select + pan/zoom via
// @tscircuit/schematic-viewer (structure is edited by the AI + Properties
// panel). Anything not backed by a live handler must NOT appear here —
// phantom shortcuts are worse than missing ones.
const SECTIONS = [
  {
    title: "General",
    shortcuts: [
      { keys: ["Ctrl", "N"], desc: "New schematic" },
      { keys: ["Ctrl", "O"], desc: "Open file" },
      { keys: ["Ctrl", "S"], desc: "Save schematic" },
      { keys: ["Ctrl", "Z"], desc: "Undo" },
      { keys: ["Ctrl", "Shift", "Z"], desc: "Redo" },
      { keys: ["Ctrl", "L"], desc: "Toggle AI chat" },
      { keys: ["Ctrl", ","], desc: "Open settings" },
      { keys: ["?"], desc: "Toggle this help" },
    ],
  },
  {
    title: "Schematic (read-only)",
    shortcuts: [
      { keys: ["Click"], desc: "Select component" },
      { keys: ["Click empty"], desc: "Deselect" },
      { keys: ["Scroll"], desc: "Zoom in / out" },
      { keys: ["Drag"], desc: "Pan canvas" },
    ],
  },
  {
    title: "PCB editor",
    shortcuts: [
      { keys: ["S"], desc: "Select tool" },
      { keys: ["M"], desc: "Move tool" },
      { keys: ["W"], desc: "Route (trace) tool" },
      { keys: ["A"], desc: "Re-autoroute focused net (click airwire or trace)" },
      { keys: ["Shift", "A"], desc: "Re-autoroute board (discard route edits)" },
      { keys: ["G"], desc: "Cycle manual routing angle (90 / 45 / free)" },
      { keys: ["V", "/"], desc: "Insert via + flip layer (while routing)" },
      { keys: ["T"], desc: "Cycle trace width" },
      { keys: ["Del"], desc: "Delete selection" },
      { keys: ["Backspace"], desc: "Delete / pop route point" },
      { keys: ["Esc"], desc: "Cancel route" },
      { keys: ["F"], desc: "Fit to view" },
      { keys: ["Space", "Drag"], desc: "Pan canvas" },
      { keys: ["Ctrl", "0"], desc: "Reset zoom" },
    ],
  },
];

function Kbd({ children }: { children: string }) {
  return (
    <kbd className={cn(
      "inline-flex items-center rounded border border-border bg-muted px-1.5 py-0.5",
      "font-mono text-[10px] text-muted-foreground leading-none shadow-sm"
    )}>
      {children}
    </kbd>
  );
}

export function ShortcutsHelp({ open, onOpenChange }: ShortcutsHelpProps) {
  // Escape + focus trap come from Radix. "?" toggling stays owned by EditorView
  // (it flips the same open state), so there's no double-fire to guard against.
  const onCloseAutoFocus = useDialogReturnFocus(open);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-xl max-h-[80vh] overflow-y-auto p-6"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader>
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-6">
          {SECTIONS.map((section) => (
            <div key={section.title}>
              <p className="ui-label text-primary mb-2">{section.title}</p>
              <div className="flex flex-col gap-1.5">
                {section.shortcuts.map((s) => (
                  <div key={s.desc} className="flex items-center justify-between gap-2">
                    <span className="text-sm text-muted-foreground">{s.desc}</span>
                    <div className="flex items-center gap-1 shrink-0">
                      {s.keys.map((k) => <Kbd key={k}>{k}</Kbd>)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <p className="text-center text-xs text-muted-foreground">
          Press <Kbd>?</Kbd> or <Kbd>Esc</Kbd> to close
        </p>
      </DialogContent>
    </Dialog>
  );
}
