import { afterEach, describe, expect, it, vi } from "vitest";

const CLIENT_ID = "client_test_123";
const REFRESH_KEY = `cherryblossom:workos-refresh-token/${CLIENT_ID}`;
const PKCE_KEY = "cherryblossom:workos-pkce";

const user = {
  id: "user_1",
  email: "person@example.test",
  first_name: "Test",
  last_name: "Person",
  profile_picture_url: null,
};

function jwt(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `header.${payload}.signature`;
}

function tokenResponse(options?: {
  accessToken?: string;
  refreshToken?: string;
  includeUser?: boolean;
}): Response {
  return Response.json({
    access_token: options?.accessToken ?? jwt({ exp: 2_000_000_000 }),
    refresh_token: options?.refreshToken ?? "refresh_next",
    ...(options?.includeUser === false ? {} : { user }),
  });
}

async function loadTransport(clientId = CLIENT_ID) {
  vi.resetModules();
  vi.stubEnv("VITE_WORKOS_CLIENT_ID", clientId);
  return import("./authTransport");
}

function fetchPayload(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  const [, init] = fetchMock.mock.calls[call] as [string, RequestInit];
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

afterEach(() => {
  window.history.replaceState(null, "", "/");
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WorkOS auth transport", () => {
  it("is inert when no public client id is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const auth = await loadTransport("");

    expect(auth.isAuthAvailable()).toBe(false);
    await expect(auth.authRefresh()).resolves.toBeNull();
    await expect(auth.authLogout("token")).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exchanges a state-matched callback with its PKCE verifier", async () => {
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse());
    vi.stubGlobal("fetch", fetchMock);
    sessionStorage.setItem(
      PKCE_KEY,
      JSON.stringify({ verifier: "verifier_123", state: "state_123" })
    );
    window.history.replaceState(
      null,
      "",
      "/callback?code=code_123&state=state_123"
    );
    const auth = await loadTransport();

    const session = await auth.authRefresh();

    expect(session).toEqual({
      user,
      accessToken: expect.any(String),
      expiresAtMs: 2_000_000_000_000,
    });
    expect(fetchPayload(fetchMock)).toEqual({
      client_id: CLIENT_ID,
      grant_type: "authorization_code",
      code: "code_123",
      code_verifier: "verifier_123",
    });
    expect(localStorage.getItem(REFRESH_KEY)).toBe("refresh_next");
    expect(sessionStorage.getItem(PKCE_KEY)).toBeNull();
    expect(window.location.pathname).toBe("/");
  });

  it("ignores a callback with a mismatched CSRF state", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    sessionStorage.setItem(
      PKCE_KEY,
      JSON.stringify({ verifier: "verifier_123", state: "expected" })
    );
    window.history.replaceState(
      null,
      "",
      "/callback?code=attacker_code&state=wrong"
    );
    const auth = await loadTransport();

    await expect(auth.authRefresh()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/");
  });

  it("restores a session and persists the rotated refresh token", async () => {
    const accessToken = jwt({ exp: 2_100_000_000 });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(tokenResponse({ accessToken, refreshToken: "rotated" }));
    vi.stubGlobal("fetch", fetchMock);
    localStorage.setItem(REFRESH_KEY, "refresh_old");
    const auth = await loadTransport();

    await expect(auth.authRefresh()).resolves.toMatchObject({
      user,
      accessToken,
      expiresAtMs: 2_100_000_000_000,
    });
    expect(fetchPayload(fetchMock)).toEqual({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: "refresh_old",
    });
    expect(localStorage.getItem(REFRESH_KEY)).toBe("rotated");
  });

  it.each([400, 401, 403])(
    "purges a refresh token rejected with HTTP %s",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          Response.json({ error: "invalid_grant" }, { status })
        )
      );
      localStorage.setItem(REFRESH_KEY, "rejected");
      const auth = await loadTransport();

      await expect(auth.authRefresh()).resolves.toBeNull();
      expect(localStorage.getItem(REFRESH_KEY)).toBeNull();
    }
  );

  it("preserves the refresh token on transient failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({ message: "slow down" }, { status: 429 })
      )
    );
    localStorage.setItem(REFRESH_KEY, "still_valid");
    const auth = await loadTransport();

    await expect(auth.authRefresh()).rejects.toThrow("refresh failed: slow down");
    expect(localStorage.getItem(REFRESH_KEY)).toBe("still_valid");
  });

  it("does not delete a token another tab rotated during a rejected refresh", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    localStorage.setItem(REFRESH_KEY, "refresh_old");
    const auth = await loadTransport();

    const pending = auth.authRefresh();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    localStorage.setItem(REFRESH_KEY, "rotated_by_other_tab");
    resolveFetch(Response.json({ error: "invalid_grant" }, { status: 401 }));

    await expect(pending).rejects.toThrow("refresh failed: invalid_grant");
    expect(localStorage.getItem(REFRESH_KEY)).toBe("rotated_by_other_tab");
  });

  it("rejects a malformed success response without a user", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(tokenResponse({ includeUser: false }))
    );
    localStorage.setItem(REFRESH_KEY, "refresh_old");
    const auth = await loadTransport();

    await expect(auth.authRefresh()).rejects.toThrow(
      "refresh failed: response missing tokens or user"
    );
    expect(localStorage.getItem(REFRESH_KEY)).toBe("refresh_old");
  });

  it("revokes the JWT session best-effort and always removes local state", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    localStorage.setItem(REFRESH_KEY, "refresh_old");
    const auth = await loadTransport();

    await auth.authLogout(jwt({ sid: "session/with spaces" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.workos.com/user_management/sessions/logout?session_id=session%2Fwith%20spaces",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(localStorage.getItem(REFRESH_KEY)).toBeNull();
  });
});
