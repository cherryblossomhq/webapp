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
import { useIsTouch } from "@/hooks/useViewport";
import { modKeyLabel } from "@/lib/platform";
import { cn } from "@/lib/utils";

interface ShortcutsHelpProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Audited against the live handlers: global keys in src/views/EditorView.tsx
// (file / undo / settings) and PCB editing keys in
// src/editor/pcb/PcbCanvas.tsx. The schematic is READ-ONLY — it has no edit
// shortcuts; its only interactions are mouse select + pan/zoom via
// @tscircuit/schematic-viewer (structure is edited by the code editor + Properties
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
      { keys: ["S"], alt: ["M"], desc: "Select / move tool" },
      { keys: ["W"], desc: "Route tool" },
      { keys: ["T"], desc: "Cycle trace width" },
      { keys: ["Shift", "Space"], desc: "Cycle corner style" },
      { keys: ["Shift", "R"], desc: "Cycle conflict mode" },
      { keys: ["Shift", "C"], desc: "Toggle clearance halo" },
      { keys: ["1"], alt: ["2"], desc: "Switch copper layer" },
      { keys: ["A"], desc: "Re-autoroute focused net" },
      { keys: ["Shift", "A"], desc: "Re-autoroute board (discards edits)" },
      { keys: ["Del"], desc: "Delete selection" },
      { keys: ["F"], desc: "Fit to view" },
      { keys: ["Ctrl", "0"], desc: "Reset zoom" },
      { keys: ["Space", "Drag"], desc: "Pan canvas" },
    ],
  },
  {
    // Split out because every key below needs a route in progress, and several
    // of them do something different when there isn't one — Space pans, and
    // Backspace deletes the selection. Annotating each row "(while routing)"
    // was how the two sets got confused for one in the first place.
    title: "While routing",
    shortcuts: [
      { keys: ["Click pad"], desc: "Finish route here" },
      { keys: ["Space"], alt: ["/"], desc: "Swap corner order" },
      { keys: ["V"], desc: "Via at cursor; V again cancels" },
      { keys: ["Enter"], alt: ["End"], desc: "Finish at cursor (stub)" },
      { keys: ["Backspace"], desc: "Undo last route point" },
      { keys: ["Esc"], desc: "Abandon route" },
      { keys: [","], alt: ["."], desc: "Corner radius −/+ (Shift ×5)" },
      { keys: ["Shift", "Drag"], desc: "Ignore object snapping" },
      { keys: ["Ctrl", "Drag"], desc: "Ignore grid snapping" },
    ],
  },
];

// The table above is written with "Ctrl" because that is what the handlers
// match on (ctrlKey OR metaKey). What the reader has on their keyboard is a
// different question — on a Mac the row said Ctrl+S while the working chord was
// ⌘S, so every entry read as wrong.
function keyLabel(key: string): string {
  return key === "Ctrl" ? modKeyLabel() : key;
}

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
  // Every entry below needs a physical keyboard, and none of the ways *out* of
  // this dialog ("?" / Esc) exist on a phone either — so a touch reader gets a
  // preface explaining that, and a close instruction it can actually follow.
  const isTouch = useIsTouch();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Height cap + internal scroll come from DialogContent. It used to be set
          here as `max-h-[80vh]`, which on mobile Safari measures the URL-bar-
          hidden viewport and so overflowed the visible one. */}
      <DialogContent
        className="sm:max-w-xl p-6"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader>
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
        </DialogHeader>

        {isTouch && (
          <p className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            These need a hardware keyboard. Without one, everything here is also
            reachable from the toolbar and the properties panel.
          </p>
        )}

        {/* Single column until `sm`: two columns of a `100vw - 2rem` dialog is
            ~143px each on a 390px phone, and each row is a description plus a
            `shrink-0` key group, so the description had nowhere to go. */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6">
          {SECTIONS.map((section) => (
            <div key={section.title}>
              <p className="ui-label text-primary mb-2">{section.title}</p>
              <div className="flex flex-col gap-1.5">
                {section.shortcuts.map((s) => (
                  <div key={s.desc} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 text-sm text-muted-foreground">{s.desc}</span>
                    {/* Adjacent chips mean "together"; an explicit "or" marks a
                        second binding for the SAME action. Without the word,
                        `Shift A` and `, .` render identically and the reader has
                        to already know which is a chord and which is a choice. */}
                    <div className="flex items-center gap-1 shrink-0">
                      {s.keys.map((k) => <Kbd key={k}>{keyLabel(k)}</Kbd>)}
                      {s.alt && (
                        <>
                          <span className="text-[10px] text-muted-foreground/70">or</span>
                          {s.alt.map((k) => <Kbd key={k}>{keyLabel(k)}</Kbd>)}
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <p className="text-center text-xs text-muted-foreground">
          {isTouch ? (
            "Tap outside this card to close"
          ) : (
            <>
              Press <Kbd>?</Kbd> or <Kbd>Esc</Kbd> to close
            </>
          )}
        </p>
      </DialogContent>
    </Dialog>
  );
}
