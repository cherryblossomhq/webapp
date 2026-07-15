import { create } from "zustand";
import { useEditorStore } from "@/editor/state/editorStore";

// The last app version we showed (or silently recorded) "What's New" for. When
// the running version differs from this on launch, the app was just updated
// and we surface the release notes once. Persisted per-device, like the API key.
const LAST_SEEN_VERSION_KEY = "cherryblossom:lastSeenVersion";

// The public, download-only repo whose GitHub releases double as our changelog.
// The release body (authored from the version-bump commit message) is what the
// post-update "What's New" tab renders. api.github.com is CORS-enabled, so the
// fetch is direct; unauthenticated (the repo is public) and GitHub's 60
// req/hour/IP limit is ample since this fires at most once per update.
const RELEASES_REPO = "cherryblossomhq/releases";

/**
 * Loading lifecycle for the release-notes fetch:
 *   loading → ready  (notes resolved — may be empty / not-found)
 *   loading → error  (fetch failed; the tab still shows with a GitHub fallback)
 */
type NotesStatus = "loading" | "ready" | "error";

interface WhatsNewState {
  /** Whether the "What's New" tab exists in the tab bar. */
  visible: boolean;
  /** The version the notes describe (the freshly-deployed one). */
  version: string;
  /** Release body Markdown, or null until it resolves. */
  notes: string | null;
  /** Link to the full release on GitHub (always set once a fetch starts). */
  url: string;
  status: NotesStatus;

  /**
   * Run once at startup. Compares the running version against the last one we
   * showed notes for; on a mismatch it reveals the tab, switches to it, and
   * fetches the release notes. First-ever launch just records the version
   * silently (nothing to announce yet).
   */
  init: () => Promise<void>;
  /** Refetch the notes (the tab's retry affordance after a failed fetch). */
  retry: () => Promise<void>;
  /** Close the tab. The version was already recorded on show, so it won't reappear. */
  dismiss: () => void;
}

function readLastSeen(): string | null {
  try {
    return localStorage.getItem(LAST_SEEN_VERSION_KEY);
  } catch {
    return null;
  }
}

function writeLastSeen(version: string): void {
  try {
    localStorage.setItem(LAST_SEEN_VERSION_KEY, version);
  } catch (err) {
    console.error("[whatsnew] failed to persist last-seen version:", err);
  }
}

async function fetchReleaseNotes(
  version: string
): Promise<{ notes: string; url: string }> {
  const tag = `v${version.trim().replace(/^v/, "")}`;
  const releasesPage = `https://github.com/${RELEASES_REPO}/releases/tag/${tag}`;

  const resp = await fetch(
    `https://api.github.com/repos/${RELEASES_REPO}/releases/tags/${tag}`,
    {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    }
  );
  // No matching release (dev build, unpublished draft) is an expected outcome,
  // not an error — fall back to a plain link to the releases page.
  if (resp.status === 404) return { notes: "", url: releasesPage };
  if (!resp.ok) throw new Error(`GitHub API error: ${resp.status}`);

  const data = (await resp.json()) as { body?: string; html_url?: string };
  return {
    notes: (data.body ?? "").trim(),
    url: data.html_url || releasesPage,
  };
}

export const useWhatsNewStore = create<WhatsNewState>((set, get) => ({
  visible: false,
  version: "",
  notes: null,
  url: "",
  status: "loading",

  init: async () => {
    const current = __APP_VERSION__;

    const lastSeen = readLastSeen();
    // First launch ever (or storage was cleared): nothing to announce. Record
    // the version so the *next* update is what triggers the tab.
    if (lastSeen === null) {
      writeLastSeen(current);
      return;
    }
    if (lastSeen === current) return; // Same version — no update happened.

    // We were just updated. Record the new version up front so the tab shows
    // exactly once (even if the user leaves without reading it or the fetch
    // below fails), then reveal it and load the notes.
    writeLastSeen(current);
    set({ visible: true, version: current, notes: null, url: "", status: "loading" });
    useEditorStore.getState().setActiveTab("whatsnew");
    await get().retry();
  },

  retry: async () => {
    const version = get().version;
    if (!version) return;
    set({ status: "loading" });
    try {
      const res = await fetchReleaseNotes(version);
      set({
        notes: res.notes,
        url: res.url,
        status: "ready",
      });
    } catch (err) {
      console.warn("[whatsnew] failed to fetch release notes:", err);
      set({
        url: `https://github.com/${RELEASES_REPO}/releases/tag/v${version}`,
        status: "error",
      });
    }
  },

  dismiss: () => set({ visible: false }),
}));
