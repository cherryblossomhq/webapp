import { create } from "zustand";
import {
  AUTH_CANCELLED,
  authCancel,
  authLogin,
  authLogout,
  authRefresh,
  isAuthAvailable,
  type AuthSession,
  type AuthUser,
} from "@/utils/authTransport";

// ─── Auth store ──────────────────────────────────────────────────────────────
//
// Session state for WorkOS sign-in. Deliberately NOT persisted: the access
// token is short-lived and memory-only; durable state (the rotating refresh
// token) lives in localStorage, owned by authTransport. On launch, `init`
// restores the session from it, then a timer keeps the access token fresh
// ahead of its expiry.

/** Refresh this far before the token's `exp` so we never hold a stale token. */
const REFRESH_MARGIN_MS = 60_000;
/** Floor for the refresh delay, in case `exp` is already (nearly) past. */
const MIN_REFRESH_DELAY_MS = 5_000;
/** Retry cadence when a scheduled refresh fails transiently (offline). */
const RETRY_DELAY_MS = 30_000;

export type AuthStatus = "unknown" | "signedOut" | "signingIn" | "signedIn";

interface AuthState {
  /** `unknown` until `init` resolves the stored session one way or the other. */
  status: AuthStatus;
  user: AuthUser | null;
  /** Short-lived WorkOS access token — memory only, never persisted. */
  accessToken: string | null;
  /** Human-readable failure from the last sign-in attempt (cancel excluded). */
  error: string | null;

  /** Restore the session on app launch. Call once from App. */
  init: () => Promise<void>;
  /** Open the system browser and run the sign-in flow to completion. */
  signIn: () => Promise<void>;
  /** Abort an in-flight sign-in (the pending `signIn` settles it). */
  cancelSignIn: () => void;
  /** Force a WorkOS token refresh, shared with startup and scheduled refreshes. */
  refresh: () => Promise<AuthSession | null>;
  signOut: () => Promise<void>;
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
/** Bumped on sign-out so a refresh that was already in flight when the user
 *  signed out can't apply its result and resurrect the session. */
let sessionEpoch = 0;
/** Shared in-flight init, so a double-invoked launch effect (React StrictMode)
 *  can't fire two concurrent refreshes racing to rotate the same token. */
let initPromise: Promise<void> | null = null;
/** One rotating-refresh-token exchange at a time. Every caller shares it. */
let refreshPromise: Promise<AuthSession | null> | null = null;

function clearRefreshTimer() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

function scheduleRefresh(expiresAtMs: number) {
  clearRefreshTimer();
  const delay = Math.max(expiresAtMs - Date.now() - REFRESH_MARGIN_MS, MIN_REFRESH_DELAY_MS);
  refreshTimer = setTimeout(() => void runScheduledRefresh(), delay);
}

function refreshSession(): Promise<AuthSession | null> {
  if (refreshPromise) return refreshPromise;
  const epoch = sessionEpoch;
  refreshPromise = authRefresh()
    .then((session) => {
      if (epoch !== sessionEpoch) return session;
      if (session) {
        applySession(session);
      } else {
        // WorkOS rejected the refresh token — genuinely signed out.
        clearRefreshTimer();
        useAuthStore.setState({
          status: "signedOut",
          user: null,
          accessToken: null,
        });
      }
      return session;
    })
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

async function runScheduledRefresh() {
  const epoch = sessionEpoch;
  try {
    await refreshSession();
  } catch (err) {
    if (epoch !== sessionEpoch) return;
    // Transient (likely offline): the stored refresh token is still good, so keep
    // the session visible and retry rather than bouncing the user out.
    console.warn("[auth] refresh failed, retrying:", err);
    clearRefreshTimer();
    refreshTimer = setTimeout(() => void runScheduledRefresh(), RETRY_DELAY_MS);
  }
}

function applySession(session: AuthSession) {
  useAuthStore.setState({
    status: "signedIn",
    user: session.user,
    accessToken: session.accessToken,
    error: null,
  });
  scheduleRefresh(session.expiresAtMs);
}

export const useAuthStore = create<AuthState>((set, get) => ({
  status: "unknown",
  user: null,
  accessToken: null,
  error: null,

  init: async () => {
    if (!isAuthAvailable()) {
      set({ status: "signedOut" });
      return;
    }
    initPromise ??= (async () => {
      try {
        await refreshSession();
      } catch (err) {
        // Offline at launch — can't prove the session either way. Show signed
        // out; the stored refresh token survives, so the next launch (or a
        // manual sign-in) recovers it.
        console.warn("[auth] startup session restore failed:", err);
        set({ status: "signedOut" });
      }
    })();
    return initPromise;
  },

  signIn: async () => {
    if (!isAuthAvailable() || get().status === "signingIn") return;
    set({ status: "signingIn", error: null });
    try {
      applySession(await authLogin());
    } catch (err) {
      const message = String(err);
      set({
        status: "signedOut",
        error: message === AUTH_CANCELLED ? null : message,
      });
    }
  },

  cancelSignIn: () => {
    // The pending signIn promise rejects with AUTH_CANCELLED and resets state.
    void authCancel().catch((err) => {
      console.error("[auth] cancel failed:", err);
    });
  },

  refresh: refreshSession,

  signOut: async () => {
    const token = get().accessToken;
    const pendingRefresh = refreshPromise;
    sessionEpoch++;
    clearRefreshTimer();
    set({ status: "signedOut", user: null, accessToken: null, error: null });
    try {
      // A refresh already in flight may rotate and persist a new refresh token.
      // Let it settle first, then remove the current token so sign-out stays
      // durable across reloads. The epoch guard above prevents UI resurrection.
      await pendingRefresh?.catch(() => null);
      await authLogout(token ?? undefined);
    } catch (err) {
      // Token cleanup failed — worst case the next launch restores the
      // session and the user signs out again. Not worth blocking the UI.
      console.error("[auth] sign-out cleanup failed:", err);
    }
  },
}));
