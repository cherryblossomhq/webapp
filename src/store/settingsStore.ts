import { create } from "zustand";

/** The Settings dialog's nav sections. */
export type SettingsTab = "advanced";

// Persisted across sessions on this device. The Code tab is how circuits get
// authored here, so it defaults ON and is only hidden if explicitly opted out.
const SHOW_CODE_TAB_KEY = "cherryblossom:showCodeTab";

function loadShowCodeTab(): boolean {
  try {
    return localStorage.getItem(SHOW_CODE_TAB_KEY) !== "0";
  } catch {
    return true;
  }
}

interface SettingsState {
  /** Whether the Settings dialog is open. */
  open: boolean;
  /** Which section is showing in the content pane. */
  activeTab: SettingsTab;

  /** Show the raw-TSX "Code" tab in the editor. On by default. */
  showCodeTab: boolean;

  /**
   * Open the dialog to a specific tab. Every open resets the active tab to the
   * requested one rather than remembering the last view, so callers — the
   * toolbar gear, the Cmd/Ctrl+, shortcut — land the user exactly where they
   * expect.
   */
  openSettings: (tab?: SettingsTab) => void;
  closeSettings: () => void;
  setActiveTab: (tab: SettingsTab) => void;
  setShowCodeTab: (value: boolean) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  open: false,
  activeTab: "advanced",
  showCodeTab: loadShowCodeTab(),

  openSettings: (tab = "advanced") => set({ open: true, activeTab: tab }),
  closeSettings: () => set({ open: false }),
  setActiveTab: (tab) => set({ activeTab: tab }),
  setShowCodeTab: (value) => {
    try {
      localStorage.setItem(SHOW_CODE_TAB_KEY, value ? "1" : "0");
    } catch (err) {
      console.error("[settings] failed to persist Code tab preference:", err);
    }
    set({ showCodeTab: value });
  },
}));

