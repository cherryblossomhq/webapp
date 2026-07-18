import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { MeResponse } from "@/utils/accountApi";
import { useAccountStore } from "@/store/accountStore";
import { useAuthStore } from "@/store/authStore";
import { useChatStore } from "@/store/chatStore";
import { useAiReady } from "./useAiReady";

const user = {
  id: "user_123",
  email: "engineer@example.com",
  first_name: null,
  last_name: null,
  profile_picture_url: null,
};

function account(
  allowedModels: string[],
  managedAi = true,
): MeResponse {
  return {
    user: { id: user.id, email: user.email, name: null },
    plan: {
      tier: "pro",
      name: "Pro",
      managedAi,
      allowedModels,
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

describe("useAiReady", () => {
  beforeEach(() => {
    useChatStore.setState({ aiProvider: "account", apiKey: "" });
    useAuthStore.setState({
      status: "unknown",
      user: null,
      accessToken: null,
      error: null,
    });
    useAccountStore.setState({
      account: null,
      accountUserId: null,
      status: "idle",
      error: null,
      selectedModel: null,
    });
  });

  it("stays pending during auth restoration and the first account load", () => {
    const { result } = renderHook(() => useAiReady());
    expect(result.current).toMatchObject({ ready: false, pending: true });

    act(() => {
      useAuthStore.setState({
        status: "signedIn",
        user,
        accessToken: "token",
      });
      useAccountStore.setState({ status: "loading" });
    });

    expect(result.current).toMatchObject({ ready: false, pending: true });
  });

  it("is ready only when the selected model is in the cached allowed list", () => {
    const models = ["anthropic/claude-sonnet-5"];
    useAuthStore.setState({
      status: "signedIn",
      user,
      accessToken: "token",
    });
    useAccountStore.setState({
      account: account(models),
      accountUserId: user.id,
      status: "ready",
      selectedModel: models[0],
    });

    const { result } = renderHook(() => useAiReady());

    expect(result.current).toMatchObject({ ready: true, pending: false });
  });

  it("keeps cached allowed models ready after a transient refresh error", () => {
    const models = ["anthropic/claude-sonnet-5"];
    useAuthStore.setState({
      status: "signedIn",
      user,
      accessToken: "token",
    });
    useAccountStore.setState({
      account: account(models),
      accountUserId: user.id,
      status: "error",
      error: "Account lookup failed.",
      selectedModel: models[0],
    });

    const { result } = renderHook(() => useAiReady());

    expect(result.current).toMatchObject({ ready: true, pending: false });
  });

  it("reports an unavailable plan when no managed model is allowed", () => {
    useAuthStore.setState({
      status: "signedIn",
      user,
      accessToken: "token",
    });
    useAccountStore.setState({
      account: account([], false),
      accountUserId: user.id,
      status: "ready",
      selectedModel: null,
    });

    const { result } = renderHook(() => useAiReady());

    expect(result.current).toMatchObject({
      ready: false,
      pending: false,
      settingsTab: "account",
    });
    expect(result.current.ctaMessage).toMatch(/plan.*managed AI model/i);
  });

  it("reports a retry state when the first account load fails", () => {
    useAuthStore.setState({
      status: "signedIn",
      user,
      accessToken: "token",
    });
    useAccountStore.setState({
      status: "error",
      error: "Account lookup failed.",
    });

    const { result } = renderHook(() => useAiReady());

    expect(result.current).toMatchObject({ ready: false, pending: false });
    expect(result.current.ctaMessage).toMatch(/managed AI.*unavailable/i);
  });

  it("preserves API-key readiness behavior", () => {
    useChatStore.setState({ aiProvider: "apiKey", apiKey: " sk-user " });

    const { result } = renderHook(() => useAiReady());

    expect(result.current).toMatchObject({
      ready: true,
      pending: false,
      provider: "apiKey",
      settingsTab: "ai",
    });
  });
});
