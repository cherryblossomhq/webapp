import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MeResponse } from "@/utils/accountApi";
import { useAccountStore } from "@/store/accountStore";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { SettingsDialog } from "./SettingsDialog";

vi.mock("@/utils/authTransport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/authTransport")>();
  return { ...actual, isAuthAvailable: () => true };
});

const user = {
  id: "user_123",
  email: "engineer@example.com",
  first_name: null,
  last_name: null,
  profile_picture_url: null,
};

function account(allowedModels: string[]): MeResponse {
  return {
    user: { id: user.id, email: user.email, name: null },
    plan: {
      tier: "free",
      name: "Free",
      managedAi: true,
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

describe("SettingsDialog account usage", () => {
  let refreshAccount: () => Promise<void>;

  beforeEach(() => {
    refreshAccount = vi.fn().mockResolvedValue(undefined);
    useSettingsStore.setState({ open: true, activeTab: "account" });
    useAuthStore.setState({
      status: "signedIn",
      user,
      accessToken: "token",
      error: null,
    });
    useAccountStore.setState({
      account: null,
      accountUserId: null,
      status: "idle",
      error: null,
      selectedModel: null,
      refresh: refreshAccount,
    });
  });

  it("shows monthly token usage from the current account response", () => {
    const currentAccount = account(["anthropic/claude-opus-4.8"]);
    currentAccount.usage.monthlyTokens = 124_500;
    currentAccount.usage.monthResetsAt = 1_786_982_400_000;
    useAccountStore.setState({
      account: currentAccount,
      accountUserId: user.id,
      status: "ready",
    });

    render(<SettingsDialog />);

    expect(screen.getByText("Monthly usage")).toBeInTheDocument();
    expect(screen.getByText("6.2% used")).toBeInTheDocument();
    expect(screen.getByText("124,500 of 2,000,000 tokens")).toBeInTheDocument();
    expect(screen.getByText(/^Resets /)).toBeInTheDocument();
    expect(screen.getAllByText(user.email)).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "AI" })).not.toBeInTheDocument();
    expect(screen.queryByText("Managed AI")).not.toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Monthly token usage" })).toHaveAttribute(
      "aria-valuenow",
      "124500",
    );
    expect(screen.getByRole("progressbar", { name: "Monthly token usage" })).toHaveAttribute(
      "aria-valuemax",
      "2000000",
    );
  });

  it("shows unlimited usage without a bounded progress bar", () => {
    const currentAccount = account(["anthropic/claude-opus-4.8"]);
    currentAccount.unlimitedCredits = true;
    currentAccount.usage.monthlyTokens = 131_513;
    useAccountStore.setState({
      account: currentAccount,
      accountUserId: user.id,
      status: "ready",
    });

    render(<SettingsDialog />);

    expect(screen.getByText("Unlimited")).toBeInTheDocument();
    expect(screen.getByText("131,513 tokens used")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("shows plans without a monthly allowance", () => {
    const currentAccount = account([]);
    currentAccount.limits.monthlyTokens = 0;
    useAccountStore.setState({
      account: currentAccount,
      accountUserId: user.id,
      status: "ready",
    });

    render(<SettingsDialog />);

    expect(screen.getByText("No allowance")).toBeInTheDocument();
    expect(screen.getByText("No monthly tokens included")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("clamps an over-limit progress bar while reporting actual usage", () => {
    const currentAccount = account(["anthropic/claude-opus-4.8"]);
    currentAccount.usage.monthlyTokens = 2_500_000;
    useAccountStore.setState({
      account: currentAccount,
      accountUserId: user.id,
      status: "ready",
    });

    render(<SettingsDialog />);

    const progress = screen.getByRole("progressbar", {
      name: "Monthly token usage",
    });
    expect(progress).toHaveAttribute("aria-valuenow", "2000000");
    expect(progress).toHaveAttribute(
      "aria-valuetext",
      "2,500,000 of 2,000,000 tokens used",
    );
    expect(progress.firstElementChild).toHaveStyle({ width: "100%" });
  });

  it("does not expose usage cached for a different signed-in user", () => {
    const previousAccount = account(["anthropic/claude-opus-4.8"]);
    previousAccount.usage.monthlyTokens = 900_000;
    useAccountStore.setState({
      account: previousAccount,
      accountUserId: "previous_user",
      status: "loading",
    });

    render(<SettingsDialog />);

    expect(screen.getByText("Loading current usage…")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByText(/900,000/)).not.toBeInTheDocument();
  });

  it("refreshes usage when opened and on demand", async () => {
    useAccountStore.setState({
      account: account(["anthropic/claude-opus-4.8"]),
      accountUserId: user.id,
      status: "ready",
    });

    render(<SettingsDialog />);
    expect(refreshAccount).toHaveBeenCalledOnce();

    await userEvent.click(screen.getByRole("button", { name: "Refresh usage" }));

    expect(refreshAccount).toHaveBeenCalledTimes(2);
  });

  it("warns when cached usage could not be refreshed", () => {
    useAccountStore.setState({
      account: account(["anthropic/claude-opus-4.8"]),
      accountUserId: user.id,
      status: "error",
      error: "Account request failed.",
    });

    render(<SettingsDialog />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Usage may be out of date. Account request failed.",
    );
  });

  it("shows a retryable error when usage has not loaded", async () => {
    useAccountStore.setState({
      status: "error",
      error: "Account request failed.",
    });

    render(<SettingsDialog />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Account request failed.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refreshAccount).toHaveBeenCalledTimes(2);
  });
});
