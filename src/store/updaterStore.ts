import { create } from "zustand";

// On the web there is no updater: a page reload always serves the latest
// deployed build. This store keeps the desktop updater's shape so the
// Settings → Updates tab and UpdateManager keep working — `phase` simply
// never leaves null, and a manual check reports "uptodate".

/** Dialog phases. `null` means no update dialog is showing. */
export type UpdatePhase = "available" | "downloading" | "ready";

/**
 * Outcome of the most recent manual check, surfaced inline in the Settings
 * Updates tab. `idle` = no check run yet (or one is in flight).
 */
export type CheckResult = "idle" | "uptodate" | "error";

interface UpdaterState {
  /** Currently installed app version, e.g. "0.2.0". Empty until loaded. */
  currentVersion: string;
  /** The version offered by the pending update, if any. Always null on web. */
  newVersion: string | null;
  /** Which dialog (if any) to render. Always null on web. */
  phase: UpdatePhase | null;
  /** Download progress, 0..1. */
  progress: number;
  /** True while a check is in flight (drives the spinner). */
  checking: boolean;
  /** Result of the last manual check — drives the Settings tab's inline status. */
  checkResult: CheckResult;

  loadVersion: () => Promise<void>;
  checkForUpdates: (opts?: { silent?: boolean }) => Promise<void>;
  startDownload: () => Promise<void>;
  restartNow: () => Promise<void>;
  dismiss: () => void;
  /** Clear the transient inline check status (idle/uptodate/error). */
  resetCheckResult: () => void;
}

export const useUpdaterStore = create<UpdaterState>((set) => ({
  currentVersion: "",
  newVersion: null,
  phase: null,
  progress: 0,
  checking: false,
  checkResult: "idle",

  loadVersion: async () => {
    set({ currentVersion: __APP_VERSION__ });
  },

  checkForUpdates: async ({ silent = false } = {}) => {
    // The web build is always current after a reload — a manual check just
    // confirms that inline; the silent startup check has nothing to do.
    if (!silent) set({ checkResult: "uptodate" });
  },

  startDownload: async () => {},

  restartNow: async () => {
    window.location.reload();
  },

  dismiss: () => set({ phase: null }),

  resetCheckResult: () => set({ checkResult: "idle" }),
}));
