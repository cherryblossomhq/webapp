/**
 * SettingsDialog — the app's settings surface. A modal Dialog (same primitive
 * as ShortcutsHelp) laid out as a left nav + right content pane. Open state and
 * the active tab live in `settingsStore`, so the toolbar gear and the
 * Cmd/Ctrl+, shortcut both drive it.
 *
 * Sections:
 *  - Advanced — power-user toggles
 */
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useDialogReturnFocus } from "@/hooks/useDialogReturnFocus";
import { useSettingsStore, type SettingsTab } from "@/store/settingsStore";
import { cn } from "@/lib/utils";
import { SlidersHorizontal } from "lucide-react";

const TABS: {
  id: SettingsTab;
  label: string;
  icon: typeof SlidersHorizontal;
}[] = [{ id: "advanced", label: "Advanced", icon: SlidersHorizontal }];

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        checked ? "bg-primary" : "bg-input"
      )}
    >
      <span
        className={cn(
          "inline-block size-4 rounded-full bg-background shadow transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-0.5"
        )}
      />
    </button>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        {description && (
          <span className="text-xs text-muted-foreground">{description}</span>
        )}
      </div>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="font-heading text-base font-medium leading-none">{title}</h3>
      {description && (
        <p className="text-sm text-muted-foreground">{description}</p>
      )}
    </div>
  );
}

function AdvancedSection() {
  const showCodeTab = useSettingsStore((s) => s.showCodeTab);
  const setShowCodeTab = useSettingsStore((s) => s.setShowCodeTab);

  return (
    <div className="flex flex-col gap-5">
      <SectionHeader
        title="Advanced"
        description="Power-user options for working closer to the circuit."
      />
      <ToggleRow
        label="Show Code tab"
        description="Add a tab to view and edit the circuit's raw TSX."
        checked={showCodeTab}
        onChange={setShowCodeTab}
      />
    </div>
  );
}

export function SettingsDialog() {
  const open = useSettingsStore((s) => s.open);
  const activeTab = useSettingsStore((s) => s.activeTab);
  const closeSettings = useSettingsStore((s) => s.closeSettings);
  const setActiveTab = useSettingsStore((s) => s.setActiveTab);
  const onCloseAutoFocus = useDialogReturnFocus(open);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) closeSettings(); }}>
      <DialogContent
        className="sm:max-w-2xl p-0 gap-0"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        {/* Nav orientation flips at `sm`, which is where the dialog's own width
            flips: above it the box is a fixed 672px and a 176px rail costs 26%;
            below it the box is only `100vw - 2rem`, so on a 390px phone that same
            rail eats half the dialog and leaves ~134px of readable pane. The
            breakpoint is the dialog's, not the shell's — `useIsCompact` (800px)
            would swap the layout while the dialog was still 668px wide.

            Height: a fixed 440px above `sm`, content-driven below it (a phone
            shouldn't get 200px of dead space under the Advanced toggle), both
            capped to the visible viewport so a short window can't push the pane
            past the fold. `min-h-0` is what lets the pane scroll instead of
            growing the flex container past that cap. */}
        <div className="flex max-h-[calc(100dvh-var(--safe-top)-var(--safe-bottom)-2rem)] flex-col sm:h-[440px] sm:flex-row">
          <div className="flex shrink-0 flex-col border-b border-border bg-muted/30 sm:w-44 sm:border-r sm:border-b-0">
            <div className="flex items-baseline gap-2 px-4 pt-3 pb-2">
              <DialogTitle className="text-sm">Settings</DialogTitle>
              {/* The rail's bottom-pinned version stamp has nowhere to pin to
                  once the nav is a horizontal strip, so it rides the title. */}
              <span className="text-xs text-muted-foreground tabular-nums sm:hidden">
                v{__APP_VERSION__}
              </span>
            </div>

            {/* Horizontal and scrollable below `sm` so more sections than fit can
                still be reached by swiping, vertical rail above it. */}
            <nav className="flex gap-0.5 overflow-x-auto px-2 pb-2 sm:flex-col sm:overflow-x-visible">
              {TABS.map(({ id, label, icon: Icon }) => {
                const active = activeTab === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setActiveTab(id)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm whitespace-nowrap transition-colors",
                      // ~44px tall on touch; the strip owns its own height, so
                      // nothing clips the way a fixed-height bar would.
                      "pointer-coarse:min-h-11 pointer-coarse:px-3",
                      active
                        ? "bg-background text-foreground ring-1 ring-foreground/10"
                        : "text-muted-foreground hover:bg-background/60 hover:text-foreground"
                    )}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden="true" />
                    {label}
                  </button>
                );
              })}
            </nav>

            <span className="mt-auto hidden px-4 pb-3 text-xs text-muted-foreground tabular-nums sm:block">
              v{__APP_VERSION__}
            </span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
            {activeTab === "advanced" && <AdvancedSection />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

