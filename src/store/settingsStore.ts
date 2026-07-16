import { create } from "zustand";

/** The Settings dialog's nav sections. `ai` is the default landing tab. */
export type SettingsTab = "ai" | "advanced" | "account";

// Persisted across sessions on this device (like the API key). The Code tab is
// power-user surface, so it's hidden by default and opted into here.
const SHOW_CODE_TAB_KEY = "cherryblossom:showCodeTab";

function loadShowCodeTab(): boolean {
  try {
    return localStorage.getItem(SHOW_CODE_TAB_KEY) === "1";
  } catch {
    return false;
  }
}

interface SettingsState {
  /** Whether the Settings dialog is open. */
  open: boolean;
  /** Which section is showing in the content pane. */
  activeTab: SettingsTab;

  /** Show the raw-TSX "Code" tab in the editor. Off by default. */
  showCodeTab: boolean;

  /**
   * Open the dialog to a specific tab (defaults to `ai`). Every open resets the
   * active tab to the requested one rather than remembering the last view, so
   * callers — the toolbar gear, the Cmd/Ctrl+, shortcut, the chat's "Open
   * Settings" CTA — land the user exactly where they expect.
   */
  openSettings: (tab?: SettingsTab) => void;
  closeSettings: () => void;
  setActiveTab: (tab: SettingsTab) => void;
  setShowCodeTab: (value: boolean) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  open: false,
  activeTab: "ai",
  showCodeTab: loadShowCodeTab(),

  openSettings: (tab = "ai") => set({ open: true, activeTab: tab }),
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
