import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

const analytics = vi.hoisted(() => {
  const posthog = {
    get_property: vi.fn(() => undefined as string | undefined),
    identify: vi.fn(),
    reset: vi.fn(),
  };

  return {
    posthog,
    initPostHog: vi.fn((loaded: (instance: typeof posthog) => void) => loaded(posthog)),
  };
});

vi.mock("@/utils/analytics", () => ({ initPostHog: analytics.initPostHog }));

import { useAuthStore } from "@/store/authStore";
import { PostHogIdentity } from "./PostHogIdentity";

const user = {
  id: "user_123",
  email: "engineer@example.com",
  first_name: "Example",
  last_name: "Engineer",
  profile_picture_url: null,
};

describe("PostHogIdentity", () => {
  beforeEach(() => {
    const { posthog } = analytics;
    analytics.initPostHog
      .mockReset()
      .mockImplementation((loaded) => loaded(posthog));
    posthog.get_property.mockReset().mockReturnValue(undefined);
    posthog.identify.mockReset();
    posthog.reset.mockReset();
    useAuthStore.setState({
      status: "unknown",
      user: null,
      accessToken: null,
      error: null,
    });
  });

  it("identifies a restored WorkOS user with useful profile properties", () => {
    useAuthStore.setState({ status: "signedIn", user, accessToken: "token" });

    render(<PostHogIdentity />);

    expect(analytics.posthog.identify).toHaveBeenCalledWith("user_123", {
      email: "engineer@example.com",
      first_name: "Example",
      last_name: "Engineer",
    });
  });

  it("refreshes profile properties for a persisted user", () => {
    analytics.posthog.get_property.mockReturnValue("user_123");
    useAuthStore.setState({ status: "signedIn", user, accessToken: "token" });

    render(<PostHogIdentity />);

    expect(analytics.posthog.identify).toHaveBeenCalledWith("user_123", {
      email: "engineer@example.com",
      first_name: "Example",
      last_name: "Engineer",
    });
    expect(analytics.posthog.reset).not.toHaveBeenCalled();
  });

  it("resets before switching between identified users", () => {
    const { posthog } = analytics;
    posthog.get_property.mockReturnValue("previous-user");
    useAuthStore.setState({ status: "signedIn", user, accessToken: "token" });

    render(<PostHogIdentity />);

    expect(posthog.reset).toHaveBeenCalledTimes(1);
    expect(posthog.identify).toHaveBeenCalledWith("user_123", expect.any(Object));
    expect(posthog.reset.mock.invocationCallOrder[0]).toBeLessThan(
      posthog.identify.mock.invocationCallOrder[0],
    );
  });

  it("resets an identified browser after session restoration proves it is signed out", () => {
    analytics.posthog.get_property.mockReturnValue("user_123");
    useAuthStore.setState({ status: "signedOut" });

    render(<PostHogIdentity />);

    expect(analytics.posthog.reset).toHaveBeenCalledTimes(1);
  });

  it.each(["unknown", "signingIn"] as const)(
    "does not initialize analytics while auth is %s",
    (status) => {
      useAuthStore.setState({ status });

      render(<PostHogIdentity />);

      expect(analytics.initPostHog).not.toHaveBeenCalled();
      expect(analytics.posthog.identify).not.toHaveBeenCalled();
      expect(analytics.posthog.reset).not.toHaveBeenCalled();
    },
  );

  it("does nothing while analytics is disabled", () => {
    analytics.initPostHog.mockImplementation(() => undefined);
    useAuthStore.setState({ status: "signedIn", user, accessToken: "token" });

    render(<PostHogIdentity />);

    expect(analytics.posthog.identify).not.toHaveBeenCalled();
    expect(analytics.posthog.reset).not.toHaveBeenCalled();
  });
});
