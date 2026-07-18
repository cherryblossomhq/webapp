import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAccountStore } from "@/store/accountStore";
import { useAuthStore } from "@/store/authStore";
import { useManagedAccountLifecycle } from "./useManagedAccountLifecycle";

const user = {
  id: "user_123",
  email: "engineer@example.com",
  first_name: null,
  last_name: null,
  profile_picture_url: null,
};

describe("useManagedAccountLifecycle", () => {
  const load = vi.fn(async () => undefined);
  const clear = vi.fn();

  beforeEach(() => {
    load.mockClear();
    clear.mockClear();
    useAccountStore.setState({
      account: null,
      accountUserId: null,
      status: "idle",
      error: null,
      selectedModel: null,
      load,
      clear,
    });
    useAuthStore.setState({
      status: "signedOut",
      user: null,
      accessToken: null,
      error: null,
    });
  });

  it("clears memory-only account state while signed out", () => {
    renderHook(() => useManagedAccountLifecycle());

    expect(clear).toHaveBeenCalledTimes(1);
    expect(load).not.toHaveBeenCalled();
  });

  it("loads account state after a signed-in session is restored", () => {
    useAuthStore.setState({
      status: "signedIn",
      user,
      accessToken: "token",
    });

    renderHook(() => useManagedAccountLifecycle());

    expect(load).toHaveBeenCalledTimes(1);
    expect(clear).not.toHaveBeenCalled();
  });

  it("clears stale account memory before loading a replacement user", () => {
    useAuthStore.setState({
      status: "signedIn",
      user,
      accessToken: "token",
    });
    useAccountStore.setState({ accountUserId: "previous_user" });

    renderHook(() => useManagedAccountLifecycle());

    expect(clear).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
