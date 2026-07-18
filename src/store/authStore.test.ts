import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authRefresh, authLogout } = vi.hoisted(() => ({
  authRefresh: vi.fn(),
  authLogout: vi.fn(async () => undefined),
}));

vi.mock("@/utils/authTransport", () => ({
  AUTH_CANCELLED: "cancelled",
  authCancel: vi.fn(async () => undefined),
  authLogin: vi.fn(),
  authLogout,
  authRefresh,
  isAuthAvailable: () => true,
}));

import { useAuthStore } from "./authStore";

const user = {
  id: "user_123",
  email: "engineer@example.com",
  first_name: "Example",
  last_name: "Engineer",
  profile_picture_url: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("authStore refresh", () => {
  beforeEach(() => {
    authRefresh.mockReset();
    authLogout.mockClear();
    useAuthStore.setState({
      status: "signedOut",
      user: null,
      accessToken: null,
      error: null,
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it("single-flights concurrent forced refreshes", async () => {
    const pending = deferred<{
      user: typeof user;
      accessToken: string;
      expiresAtMs: number;
    }>();
    authRefresh.mockReturnValue(pending.promise);

    const first = useAuthStore.getState().refresh();
    const second = useAuthStore.getState().refresh();

    expect(authRefresh).toHaveBeenCalledTimes(1);
    pending.resolve({
      user,
      accessToken: "fresh-token",
      expiresAtMs: Date.now() + 300_000,
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ accessToken: "fresh-token" }),
      expect.objectContaining({ accessToken: "fresh-token" }),
    ]);
    expect(useAuthStore.getState()).toMatchObject({
      status: "signedIn",
      user,
      accessToken: "fresh-token",
    });
  });

  it("preserves an existing session when a forced refresh fails transiently", async () => {
    useAuthStore.setState({
      status: "signedIn",
      user,
      accessToken: "still-valid",
    });
    authRefresh.mockRejectedValue(new Error("offline"));

    await expect(useAuthStore.getState().refresh()).rejects.toThrow("offline");

    expect(useAuthStore.getState()).toMatchObject({
      status: "signedIn",
      user,
      accessToken: "still-valid",
    });
  });

  it("waits for an in-flight rotation before removing the stored session", async () => {
    const pending = deferred<{
      user: typeof user;
      accessToken: string;
      expiresAtMs: number;
    }>();
    authRefresh.mockReturnValue(pending.promise);
    useAuthStore.setState({
      status: "signedIn",
      user,
      accessToken: "old-token",
    });

    const refreshing = useAuthStore.getState().refresh();
    const signingOut = useAuthStore.getState().signOut();
    expect(useAuthStore.getState().status).toBe("signedOut");
    expect(authLogout).not.toHaveBeenCalled();

    pending.resolve({
      user,
      accessToken: "late-token",
      expiresAtMs: Date.now() + 300_000,
    });
    await Promise.all([refreshing, signingOut]);

    expect(useAuthStore.getState()).toMatchObject({
      status: "signedOut",
      user: null,
      accessToken: null,
    });
    expect(authLogout).toHaveBeenCalledTimes(1);
  });

  it("moves to signed out when WorkOS rejects the refresh token", async () => {
    useAuthStore.setState({
      status: "signedIn",
      user,
      accessToken: "expired-token",
    });
    authRefresh.mockResolvedValue(null);

    await expect(useAuthStore.getState().refresh()).resolves.toBeNull();
    expect(useAuthStore.getState()).toMatchObject({
      status: "signedOut",
      user: null,
      accessToken: null,
    });
  });
});
