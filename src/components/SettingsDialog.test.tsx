import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { MeResponse } from "@/utils/accountApi";
import { useAccountStore } from "@/store/accountStore";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { SettingsDialog } from "./SettingsDialog";

const user = {
  id: "user_123",
  email: "engineer@example.com",
  first_name: null,
  last_name: null,
  profile_picture_url: null,
};

function account(allowedModels: string[], managedAi = true): MeResponse {
  return {
    user: { id: user.id, email: user.email, name: null },
    plan: {
      tier: "free",
      name: "Free",
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

describe("SettingsDialog AI status", () => {
  beforeEach(() => {
    useSettingsStore.setState({ open: true, activeTab: "ai" });
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
    });
  });

  it("does not report an account without managed models as ready", () => {
    useAccountStore.setState({
      account: account([], false),
      accountUserId: user.id,
      status: "ready",
    });

    render(<SettingsDialog />);

    expect(
      screen.getByText(/account plan doesn't include a managed AI model/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/assistant is ready to use/i)).not.toBeInTheDocument();
  });
});
