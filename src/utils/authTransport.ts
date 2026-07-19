// ─── Auth transport ──────────────────────────────────────────────────────────
//
// WorkOS AuthKit sign-in for a browser SPA: PKCE authorization-code flow with
// a full-page redirect. `authLogin` stashes the PKCE verifier + CSRF state in
// sessionStorage and navigates to the AuthKit authorize URL; WorkOS redirects
// back to `{origin}/callback?code=…`, and `authRefresh` (called from the auth
// store's `init` on every launch) detects that callback, exchanges the code as
// a *public client* (PKCE `code_verifier`, no client secret), and cleans the
// URL. Between launches the session is restored with the rotating refresh
// token, kept in localStorage (scoped per client id).
//
// Register `{origin}/callback` (dev: http://localhost:5173/callback) on the
// WorkOS environment's Redirects page.

const WORKOS_API = "https://api.workos.com";
const HTTP_TIMEOUT_MS = 20_000;
/** sessionStorage slot for the in-flight PKCE verifier + CSRF state. */
const PKCE_KEY = "cherryblossom:workos-pkce";
const CALLBACK_PATH = "/callback";

/** WorkOS user profile, passed through verbatim (snake_case per their API). */
export interface AuthUser {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  profile_picture_url: string | null;
}

export interface AuthSession {
  user: AuthUser;
  accessToken: string;
  /** Unix ms when the access token expires — refresh before this. */
  expiresAtMs: number;
}

/**
 * `authLogin` never rejects with this on the web (the redirect leaves the
 * page), but the constant stays so authStore's cancel handling keeps compiling
 * and behaving.
 */
export const AUTH_CANCELLED = "cancelled";

/** Public WorkOS client id, baked in at build time. No id → auth UI hidden. */
export const WORKOS_CLIENT_ID: string | undefined =
  import.meta.env.VITE_WORKOS_CLIENT_ID;

export function isAuthAvailable(): boolean {
  return !!WORKOS_CLIENT_ID;
}

// Scoped per client id so switching WorkOS environments (staging ↔ prod)
// can't replay a token across them.
function refreshTokenKey(clientId: string): string {
  return `cherryblossom:workos-refresh-token/${clientId}`;
}

// ─── PKCE / token helpers ────────────────────────────────────────────────────

function randomUrlsafe(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );
  return base64UrlEncode(new Uint8Array(digest));
}

/** Best-effort read of one claim from a JWT payload. No signature check — the
 *  value is only used for refresh scheduling and logout, never authorization. */
function jwtClaim(token: string, claim: string): unknown {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(b64)) as Record<string, unknown>;
    return json[claim];
  } catch {
    return undefined;
  }
}

function tokenExpiryMs(accessToken: string): number {
  const exp = jwtClaim(accessToken, "exp");
  if (typeof exp === "number") return exp * 1000;
  // WorkOS access tokens default to ~5 min; if the claim is unreadable,
  // schedule as if slightly shorter so we still refresh in time.
  return Date.now() + 4 * 60 * 1000;
}

// ─── WorkOS token endpoint ───────────────────────────────────────────────────

interface TokenResponse {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
}

class AuthRejectedError extends Error {}

async function authenticate(payload: Record<string, unknown>): Promise<TokenResponse> {
  let resp: Response;
  try {
    resp = await fetch(`${WORKOS_API}/user_management/authenticate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`network: ${e instanceof Error ? e.message : String(e)}`, {
      cause: e,
    });
  }

  const body = await resp.text();
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      for (const key of ["error_description", "message", "error"]) {
        if (typeof parsed[key] === "string") {
          msg = parsed[key] as string;
          break;
        }
      }
    } catch {
      /* non-JSON body — keep the HTTP status message */
    }
    // Only statuses that speak to the grant itself count as a refusal
    // (bad/expired code or refresh token). Other 4xx — notably 429 (WorkOS
    // rate-limits this API) and 408 — say nothing about the grant and must
    // stay transient, or a rate-limited refresh would destroy a valid session.
    // 5xx / network = transient, worth retrying.
    if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
      throw new AuthRejectedError(msg);
    }
    throw new Error(msg);
  }

  const json = JSON.parse(body) as {
    access_token?: string;
    refresh_token?: string;
    user?: AuthUser;
  };
  if (
    !json.access_token ||
    !json.refresh_token ||
    !json.user ||
    typeof json.user !== "object"
  ) {
    throw new Error("response missing tokens or user");
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    user: json.user as AuthUser,
  };
}

function sessionFrom(tokens: TokenResponse): AuthSession {
  return {
    user: tokens.user,
    accessToken: tokens.accessToken,
    expiresAtMs: tokenExpiryMs(tokens.accessToken),
  };
}

// ─── Redirect callback handling ──────────────────────────────────────────────

interface PendingCallback {
  code: string | null;
  error: string | null;
}

/** Detect (and consume from the URL) an AuthKit redirect back to the app. */
function takePendingCallback(): PendingCallback | null {
  if (window.location.pathname !== CALLBACK_PATH) return null;
  const params = new URLSearchParams(window.location.search);
  const result: PendingCallback = {
    code: params.get("code"),
    error: params.get("error_description") ?? params.get("error"),
  };
  const expectedState = readPkce()?.state;
  // Clean the URL either way — a stale /callback must not re-trigger.
  window.history.replaceState(null, "", "/");
  // A callback that can't prove it belongs to the flow we started gets no say
  // in its outcome.
  if (!expectedState || params.get("state") !== expectedState) return null;
  return result;
}

interface PkceRecord {
  verifier: string;
  state: string;
}

function readPkce(): PkceRecord | null {
  try {
    const raw = sessionStorage.getItem(PKCE_KEY);
    return raw ? (JSON.parse(raw) as PkceRecord) : null;
  } catch {
    return null;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Kick off the sign-in flow: stash PKCE state and navigate this page to the
 * AuthKit authorize URL. The returned promise never settles — the redirect
 * unloads the app, and the post-sign-in state is picked up by `authRefresh`
 * when WorkOS sends the user back to `/callback`.
 */
export async function authLogin(): Promise<AuthSession> {
  if (!WORKOS_CLIENT_ID) throw new Error("auth unavailable: no client id");
  const verifier = randomUrlsafe();
  const state = randomUrlsafe();
  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state }));

  const url = new URL(`${WORKOS_API}/user_management/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: WORKOS_CLIENT_ID,
    redirect_uri: `${window.location.origin}${CALLBACK_PATH}`,
    state,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
    provider: "authkit",
  }).toString();

  window.location.assign(url.toString());
  return new Promise<AuthSession>(() => {
    /* page is navigating away */
  });
}

/** No-op on the web — closing/leaving the AuthKit page is the cancel. */
export async function authCancel(): Promise<void> {}

/**
 * Restore/refresh the session. Order of precedence:
 *  1. an AuthKit redirect callback pending in the URL (code exchange),
 *  2. the stored rotating refresh token.
 * `null` means signed out; a rejection means a transient failure (offline) —
 * the stored session may still be valid, so don't treat it as a sign-out.
 */
export async function authRefresh(): Promise<AuthSession | null> {
  if (!WORKOS_CLIENT_ID) return null;

  const callback = takePendingCallback();
  if (callback) {
    const pkce = readPkce();
    sessionStorage.removeItem(PKCE_KEY);
    if (callback.error) {
      console.warn("[auth] sign-in redirect returned an error:", callback.error);
      return null;
    }
    if (callback.code && pkce) {
      try {
        const tokens = await authenticate({
          client_id: WORKOS_CLIENT_ID,
          grant_type: "authorization_code",
          code: callback.code,
          code_verifier: pkce.verifier,
        });
        localStorage.setItem(refreshTokenKey(WORKOS_CLIENT_ID), tokens.refreshToken);
        return sessionFrom(tokens);
      } catch (e) {
        console.warn("[auth] code exchange failed:", e);
        // Fall through to the refresh-token path — a previous session may
        // still be restorable.
      }
    }
  }

  const refreshToken = localStorage.getItem(refreshTokenKey(WORKOS_CLIENT_ID));
  if (!refreshToken) return null;

  try {
    const tokens = await authenticate({
      client_id: WORKOS_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    // WorkOS rotates the refresh token on every use.
    localStorage.setItem(refreshTokenKey(WORKOS_CLIENT_ID), tokens.refreshToken);
    return sessionFrom(tokens);
  } catch (e) {
    if (e instanceof AuthRejectedError) {
      // WorkOS rejected the refresh token. Only purge storage if it still
      // holds the exact token that was rejected — WorkOS rotates the token on
      // every use, so when two tabs refresh concurrently the loser's
      // rejection must not delete the winner's freshly rotated token.
      if (localStorage.getItem(refreshTokenKey(WORKOS_CLIENT_ID)) === refreshToken) {
        localStorage.removeItem(refreshTokenKey(WORKOS_CLIENT_ID));
        return null;
      }
      // Another tab already rotated the token — transient from this tab's
      // perspective; the caller's retry path picks up the new token.
    }
    throw new Error(
      `refresh failed: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e }
    );
  }
}

/** Revoke the WorkOS session (best-effort) and purge the stored token. */
export async function authLogout(accessToken?: string): Promise<void> {
  if (!WORKOS_CLIENT_ID) return;
  const sid = accessToken ? jwtClaim(accessToken, "sid") : undefined;
  if (typeof sid === "string" && sid !== "") {
    try {
      await fetch(
        `${WORKOS_API}/user_management/sessions/logout?session_id=${encodeURIComponent(sid)}`,
        { signal: AbortSignal.timeout(5_000) }
      );
    } catch {
      /* best-effort */
    }
  }
  localStorage.removeItem(refreshTokenKey(WORKOS_CLIENT_ID));
}
