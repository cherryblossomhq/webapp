import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useSettingsStore } from "./settingsStore";

function reset() {
  try {
    localStorage.removeItem("cherryblossom:showCodeTab");
  } catch {
    // ignore — jsdom always provides localStorage
  }
  useSettingsStore.setState({ open: false, activeTab: "account", showCodeTab: false });
}

describe("settingsStore", () => {
  beforeEach(reset);

  it("starts closed on the Account tab", () => {
    const s = useSettingsStore.getState();
    expect(s.open).toBe(false);
    expect(s.activeTab).toBe("account");
  });

  it("openSettings() opens to the Account tab by default", () => {
    useSettingsStore.getState().openSettings();
    const s = useSettingsStore.getState();
    expect(s.open).toBe(true);
    expect(s.activeTab).toBe("account");
  });

  it("openSettings(tab) opens directly to the requested tab", () => {
    useSettingsStore.getState().openSettings("advanced");
    expect(useSettingsStore.getState()).toMatchObject({ open: true, activeTab: "advanced" });
  });

  it("every open resets the active tab to the requested one", () => {
    // Open on Account, navigate to Advanced, close...
    useSettingsStore.getState().openSettings("account");
    useSettingsStore.getState().setActiveTab("advanced");
    useSettingsStore.getState().closeSettings();
    expect(useSettingsStore.getState().activeTab).toBe("advanced"); // retained while closed

    // ...reopening with the default lands back on Account, not the last view.
    useSettingsStore.getState().openSettings();
    expect(useSettingsStore.getState().activeTab).toBe("account");
  });

  it("closeSettings() closes without changing the active tab", () => {
    useSettingsStore.getState().openSettings("account");
    useSettingsStore.getState().closeSettings();
    const s = useSettingsStore.getState();
    expect(s.open).toBe(false);
    expect(s.activeTab).toBe("account");
  });

  it("setActiveTab() switches sections while open", () => {
    useSettingsStore.getState().openSettings();
    useSettingsStore.getState().setActiveTab("account");
    expect(useSettingsStore.getState().activeTab).toBe("account");
    expect(useSettingsStore.getState().open).toBe(true);
  });

  it("the Code tab is hidden by default", () => {
    expect(useSettingsStore.getState().showCodeTab).toBe(false);
  });

  it("setShowCodeTab() toggles the preference and persists it", () => {
    useSettingsStore.getState().setShowCodeTab(true);
    expect(useSettingsStore.getState().showCodeTab).toBe(true);
    expect(localStorage.getItem("cherryblossom:showCodeTab")).toBe("1");

    useSettingsStore.getState().setShowCodeTab(false);
    expect(useSettingsStore.getState().showCodeTab).toBe(false);
    expect(localStorage.getItem("cherryblossom:showCodeTab")).toBe("0");
  });
});

// The initial showCodeTab value is read from localStorage once at module load
// (loadShowCodeTab), so it can't be exercised by the suite above — that store is
// already constructed. Re-import a fresh module against seeded storage instead.
describe("settingsStore — showCodeTab load path", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("initializes showCodeTab=true when localStorage holds '1'", async () => {
    localStorage.setItem("cherryblossom:showCodeTab", "1");
    const { useSettingsStore: fresh } = await import("./settingsStore");
    expect(fresh.getState().showCodeTab).toBe(true);
  });

  it("initializes showCodeTab=false when the key is absent or not '1'", async () => {
    localStorage.setItem("cherryblossom:showCodeTab", "0");
    const { useSettingsStore: fresh } = await import("./settingsStore");
    expect(fresh.getState().showCodeTab).toBe(false);
  });

  it("falls back to false when localStorage.getItem throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const { useSettingsStore: fresh } = await import("./settingsStore");
    expect(fresh.getState().showCodeTab).toBe(false);
  });
});
