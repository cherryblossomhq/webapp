import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MeResponse } from "@/utils/accountApi";
import { useAccountStore } from "@/store/accountStore";
import { useAuthStore } from "@/store/authStore";
import { useChatStore } from "@/store/chatStore";
import { ManagedModelSelector } from "./ManagedModelSelector";

const user = {
  id: "user_123",
  email: "engineer@example.com",
  first_name: null,
  last_name: null,
  profile_picture_url: null,
};
const sonnet = "anthropic/claude-sonnet-5";
const opus = "anthropic/claude-opus-4.8";

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

describe("ManagedModelSelector", () => {
  const refresh = vi.fn(async () => undefined);

  beforeEach(() => {
    refresh.mockClear();
    useChatStore.setState({ isStreaming: false });
    useAuthStore.setState({
      status: "signedIn",
      user,
      accessToken: "token",
      error: null,
    });
    useAccountStore.setState({
      account: null,
      accountUserId: null,
      status: "loading",
      error: null,
      selectedModel: null,
      refresh,
    });
  });

  it("shows a compact loading trigger before the first response", () => {
    render(<ManagedModelSelector />);

    expect(
      screen.getByRole("button", { name: /managed model: loading/i }),
    ).toBeInTheDocument();
  });

  it("shows loading while account data still belongs to the previous user", () => {
    useAccountStore.setState({
      account: account([opus]),
      accountUserId: "previous_user",
      status: "ready",
      selectedModel: opus,
    });

    render(<ManagedModelSelector />);

    expect(
      screen.getByRole("button", { name: /managed model: loading/i }),
    ).toBeInTheDocument();
  });

  it("renders allowed models, refreshes on open, and switches selection", async () => {
    useAccountStore.setState({
      account: account([sonnet, opus]),
      accountUserId: user.id,
      status: "ready",
      selectedModel: opus,
    });
    const userEventApi = userEvent.setup();
    render(<ManagedModelSelector />);

    await userEventApi.click(
      screen.getByRole("button", { name: /managed model: claude opus 4\.8/i }),
    );

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("menuitemradio", { name: "Claude Opus 4.8" }),
    ).toHaveAttribute("aria-checked", "true");
    await userEventApi.click(
      screen.getByRole("menuitemradio", { name: "Claude Sonnet 5" }),
    );
    expect(useAccountStore.getState().selectedModel).toBe(sonnet);
  });

  it("offers only the free anonymous model plus a sign-in entry when signed out", async () => {
    const signIn = vi.fn(async () => undefined);
    useAuthStore.setState({
      status: "signedOut",
      user: null,
      accessToken: null,
      signIn,
    });
    useAccountStore.setState({ status: "idle" });
    const userEventApi = userEvent.setup();
    render(<ManagedModelSelector />);

    await userEventApi.click(
      screen.getByRole("button", { name: /managed model: hy 3 free/i }),
    );

    // No account fetch for anonymous visitors — /me requires auth.
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(1);
    expect(
      screen.getByRole("menuitemradio", { name: "HY 3 Free" }),
    ).toHaveAttribute("aria-checked", "true");

    await userEventApi.click(
      screen.getByRole("menuitem", { name: /sign in for more models/i }),
    );
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it("falls back to the canonical ID for unknown future models", () => {
    const future = "provider/future-model";
    useAccountStore.setState({
      account: account([future]),
      accountUserId: user.id,
      status: "ready",
      selectedModel: future,
    });

    render(<ManagedModelSelector />);

    expect(screen.getByText(future)).toBeInTheDocument();
  });

  it("disables the selector while chat is streaming", async () => {
    useChatStore.setState({ isStreaming: true });
    useAccountStore.setState({
      account: account([opus]),
      accountUserId: user.id,
      status: "ready",
      selectedModel: opus,
    });
    const userEventApi = userEvent.setup();
    render(<ManagedModelSelector />);

    const trigger = screen.getByRole("button", { name: /managed model/i });
    expect(trigger).toBeDisabled();
    await userEventApi.click(trigger);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("keeps cached choices usable and offers retry after a refresh error", async () => {
    useAccountStore.setState({
      account: account([sonnet, opus]),
      accountUserId: user.id,
      status: "error",
      error: "Account lookup failed.",
      selectedModel: opus,
    });
    const userEventApi = userEvent.setup();
    render(<ManagedModelSelector />);

    await userEventApi.click(
      screen.getByRole("button", { name: /managed model: claude opus/i }),
    );

    expect(
      screen.getByRole("menuitemradio", { name: "Claude Sonnet 5" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Account lookup failed.")).toBeInTheDocument();
    await userEventApi.click(screen.getByRole("menuitem", { name: /retry/i }));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("shows retry when the first account load fails", async () => {
    useAccountStore.setState({
      status: "error",
      error: "Account lookup failed.",
    });
    const userEventApi = userEvent.setup();
    render(<ManagedModelSelector />);

    await userEventApi.click(
      screen.getByRole("button", { name: /managed model: models unavailable/i }),
    );

    expect(screen.getByText("Account lookup failed.")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /retry/i })).toBeInTheDocument();
  });

  it("shows an unavailable state for a plan without managed models", async () => {
    useAccountStore.setState({
      account: account([], false),
      accountUserId: user.id,
      status: "ready",
      selectedModel: null,
    });
    const userEventApi = userEvent.setup();
    render(<ManagedModelSelector />);

    await userEventApi.click(
      screen.getByRole("button", { name: /managed model: no managed models/i }),
    );

    expect(screen.getByText("No managed models on this plan.")).toBeInTheDocument();
  });
});
