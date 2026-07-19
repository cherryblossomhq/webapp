import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

const posthog = vi.hoisted(() => ({
  __loaded: true,
  get_distinct_id: vi.fn(() => "anonymous-id"),
  identify: vi.fn(),
  _isIdentified: vi.fn(() => false),
  reset: vi.fn(),
}));

vi.mock("posthog-js", () => ({ default: posthog }));

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
    posthog.__loaded = true;
    posthog.get_distinct_id.mockReset().mockReturnValue("anonymous-id");
    posthog.identify.mockReset();
    posthog._isIdentified.mockReset().mockReturnValue(false);
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

    expect(posthog.identify).toHaveBeenCalledWith("user_123", {
      email: "engineer@example.com",
      first_name: "Example",
      last_name: "Engineer",
    });
  });

  it("does not identify a user that already owns the persisted identity", () => {
    posthog.get_distinct_id.mockReturnValue("user_123");
    useAuthStore.setState({ status: "signedIn", user, accessToken: "token" });

    render(<PostHogIdentity />);

    expect(posthog.identify).not.toHaveBeenCalled();
  });

  it("resets an identified browser after session restoration proves it is signed out", () => {
    posthog._isIdentified.mockReturnValue(true);
    useAuthStore.setState({ status: "signedOut" });

    render(<PostHogIdentity />);

    expect(posthog.reset).toHaveBeenCalledTimes(1);
  });

  it("does nothing while analytics is disabled", () => {
    posthog.__loaded = false;
    useAuthStore.setState({ status: "signedIn", user, accessToken: "token" });

    render(<PostHogIdentity />);

    expect(posthog.identify).not.toHaveBeenCalled();
    expect(posthog.reset).not.toHaveBeenCalled();
  });
});
