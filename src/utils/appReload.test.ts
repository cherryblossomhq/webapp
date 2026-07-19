import { afterEach, describe, expect, it, vi } from "vitest";
import { onBeforeAppReload, reloadApp } from "./appReload";

const cleanups: Array<() => void> = [];

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
});

describe("app reload preservation", () => {
  it("lets mounted work veto a reload", () => {
    cleanups.push(onBeforeAppReload((event) => event.preventDefault()));

    expect(reloadApp()).toBe(false);
  });

  it("removes preservation listeners on cleanup", () => {
    const listener = vi.fn();
    onBeforeAppReload(listener)();
    cleanups.push(onBeforeAppReload((event) => event.preventDefault()));

    expect(reloadApp()).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });
});
