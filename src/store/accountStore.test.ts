import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@/utils/authTransport";
import { AccountApiError, type MeResponse } from "@/utils/accountApi";

const { fetchMe } = vi.hoisted(() => ({ fetchMe: vi.fn() }));

vi.mock("@/utils/accountApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/accountApi")>();
  return { ...actual, fetchMe };
});

import {
  DEFAULT_MANAGED_MODEL,
  MANAGED_MODEL_STORAGE_KEY,
  useAccountStore,
} from "./accountStore";
import { useAuthStore } from "./authStore";

const authUser = {
  id: "user_123",
  email: "engineer@example.com",
  first_name: "Example",
  last_name: "Engineer",
  profile_picture_url: null,
};

const sonnet = "anthropic/claude-sonnet-5";
const opus = "anthropic/claude-opus-4.8";
const free = "tencent/hy3:free";

function account(
  allowedModels: string[] = [sonnet, opus],
  overrides?: Partial<MeResponse["plan"]>,
  userId = authUser.id,
): MeResponse {
  return {
    user: { id: userId, email: authUser.email, name: "Example Engineer" },
    plan: {
      tier: "pro",
      name: "Pro",
      managedAi: true,
      allowedModels,
      ...overrides,
    },
    limits: {
      maxTokensPerRequest: 64_000,
      requestsPerMinute: 10,
      requestsPerDay: 200,
      monthlyTokens: 2_000_000,
    },
    usage: {
      requestsThisMinute: 0,
      minuteResetsAt: null,
      requestsThisDay: 0,
      dayResetsAt: null,
      monthlyTokens: 0,
      monthResetsAt: null,
    },
    unlimitedCredits: false,
  };
}

function signedIn(user = authUser, accessToken = "token-1") {
  useAuthStore.setState({
    status: "signedIn",
    user,
    accessToken,
    error: null,
    refresh: vi.fn(async () => null),
    signOut: vi.fn(async () => undefined),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("accountStore", () => {
  beforeEach(() => {
    fetchMe.mockReset();
    localStorage.removeItem(MANAGED_MODEL_STORAGE_KEY);
    useAccountStore.getState().clear();
    useAccountStore.setState({ selectedModel: null });
    signedIn();
  });

  it("single-flights concurrent loads", async () => {
    const pending = deferred<MeResponse>();
    fetchMe.mockReturnValue(pending.promise);

    const first = useAccountStore.getState().load();
    const second = useAccountStore.getState().load();

    expect(fetchMe).toHaveBeenCalledTimes(1);
    pending.resolve(account());
    await Promise.all([first, second]);
    expect(useAccountStore.getState().status).toBe("ready");
  });

  it("retains a selected model that remains allowed", async () => {
    useAccountStore.setState({ selectedModel: sonnet });
    fetchMe.mockResolvedValue(account([sonnet, opus]));

    await useAccountStore.getState().load();

    expect(useAccountStore.getState().selectedModel).toBe(sonnet);
  });

  it("prefers Opus when a stale selection is no longer allowed", async () => {
    useAccountStore.setState({ selectedModel: "removed/model" });
    fetchMe.mockResolvedValue(account([sonnet, opus]));

    await useAccountStore.getState().load();

    expect(DEFAULT_MANAGED_MODEL).toBe(opus);
    expect(useAccountStore.getState().selectedModel).toBe(opus);
    expect(localStorage.getItem(MANAGED_MODEL_STORAGE_KEY)).toBe(opus);
  });

  it("falls back to the first server model when Opus is unavailable", async () => {
    fetchMe.mockResolvedValue(account([free, sonnet]));

    await useAccountStore.getState().load();

    expect(useAccountStore.getState().selectedModel).toBe(free);
  });

  it("uses no model for an empty or disabled managed plan", async () => {
    fetchMe.mockResolvedValue(
      account([opus], { managedAi: false, allowedModels: [opus] }),
    );

    await useAccountStore.getState().load();

    expect(useAccountStore.getState().selectedModel).toBeNull();
  });

  it("persists only valid user selections", async () => {
    fetchMe.mockResolvedValue(account([sonnet, opus]));
    await useAccountStore.getState().load();

    useAccountStore.getState().setSelectedModel(sonnet);
    expect(useAccountStore.getState().selectedModel).toBe(sonnet);
    expect(localStorage.getItem(MANAGED_MODEL_STORAGE_KEY)).toBe(sonnet);

    useAccountStore.getState().setSelectedModel("unavailable/model");
    expect(useAccountStore.getState().selectedModel).toBe(sonnet);
  });

  it("retains the last successful account when refresh fails", async () => {
    fetchMe.mockResolvedValueOnce(account([sonnet]));
    await useAccountStore.getState().load();
    fetchMe.mockRejectedValueOnce(
      new AccountApiError(502, "upstream_error", "Account lookup failed."),
    );

    await expect(useAccountStore.getState().refresh()).rejects.toThrow(
      "Account lookup failed.",
    );

    expect(useAccountStore.getState()).toMatchObject({
      status: "error",
      account: account([sonnet]),
      selectedModel: sonnet,
      error: "Account lookup failed.",
    });
  });

  it("ignores a stale response after clear and user replacement", async () => {
    const first = deferred<MeResponse>();
    fetchMe.mockReturnValueOnce(first.promise);
    const oldLoad = useAccountStore.getState().load();

    useAccountStore.getState().clear();
    const nextUser = { ...authUser, id: "user_456", email: "next@example.com" };
    signedIn(nextUser, "token-2");
    fetchMe.mockResolvedValueOnce(account([free], undefined, nextUser.id));
    await useAccountStore.getState().load();

    first.resolve(account([opus]));
    await oldLoad;
    expect(useAccountStore.getState()).toMatchObject({
      accountUserId: nextUser.id,
      selectedModel: free,
    });
  });

  it("refreshes the WorkOS token once and retries a 401", async () => {
    const session: AuthSession = {
      user: authUser,
      accessToken: "token-2",
      expiresAtMs: Date.now() + 300_000,
    };
    const refresh = vi.fn(async () => {
      useAuthStore.setState({ accessToken: session.accessToken });
      return session;
    });
    useAuthStore.setState({ refresh });
    fetchMe
      .mockRejectedValueOnce(
        new AccountApiError(401, "not_authenticated", "Expired"),
      )
      .mockResolvedValueOnce(account([opus]));

    await useAccountStore.getState().load();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchMe).toHaveBeenNthCalledWith(1, "token-1");
    expect(fetchMe).toHaveBeenNthCalledWith(2, "token-2");
  });

  it("signs out after the retried account request also returns 401", async () => {
    const refresh = vi.fn(async () => {
      useAuthStore.setState({ accessToken: "token-2" });
      return {
        user: authUser,
        accessToken: "token-2",
        expiresAtMs: Date.now() + 300_000,
      };
    });
    const signOut = vi.fn(async () => {
      useAuthStore.setState({
        status: "signedOut",
        user: null,
        accessToken: null,
      });
    });
    useAuthStore.setState({ refresh, signOut });
    fetchMe.mockRejectedValue(
      new AccountApiError(401, "not_authenticated", "Expired"),
    );

    await expect(useAccountStore.getState().load()).rejects.toThrow("Expired");

    expect(fetchMe).toHaveBeenCalledTimes(2);
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(useAccountStore.getState().error).toBeNull();
  });

  it("clears account data without deleting the model preference", async () => {
    fetchMe.mockResolvedValue(account([sonnet]));
    await useAccountStore.getState().load();
    useAccountStore.getState().setSelectedModel(sonnet);

    useAccountStore.getState().clear();

    expect(useAccountStore.getState()).toMatchObject({
      status: "idle",
      account: null,
      accountUserId: null,
      selectedModel: sonnet,
    });
    expect(localStorage.getItem(MANAGED_MODEL_STORAGE_KEY)).toBe(sonnet);
  });
});
