import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useSettingsStore } from "./settingsStore";

function reset() {
  try {
    localStorage.removeItem("cherryblossom:showCodeTab");
  } catch {
    // ignore — jsdom always provides localStorage
  }
  useSettingsStore.setState({ open: false, activeTab: "advanced", showCodeTab: true });
}

describe("settingsStore", () => {
  beforeEach(reset);

  it("starts closed on the Advanced tab", () => {
    const s = useSettingsStore.getState();
    expect(s.open).toBe(false);
    expect(s.activeTab).toBe("advanced");
  });

  it("openSettings() opens to the Advanced tab by default", () => {
    useSettingsStore.getState().openSettings();
    const s = useSettingsStore.getState();
    expect(s.open).toBe(true);
    expect(s.activeTab).toBe("advanced");
  });

  it("openSettings(tab) opens directly to the requested tab", () => {
    useSettingsStore.getState().openSettings("advanced");
    expect(useSettingsStore.getState()).toMatchObject({ open: true, activeTab: "advanced" });
  });

  it("closeSettings() closes without changing the active tab", () => {
    useSettingsStore.getState().openSettings("advanced");
    useSettingsStore.getState().closeSettings();
    const s = useSettingsStore.getState();
    expect(s.open).toBe(false);
    expect(s.activeTab).toBe("advanced");
  });

  it("setActiveTab() switches sections while open", () => {
    useSettingsStore.getState().openSettings();
    useSettingsStore.getState().setActiveTab("advanced");
    expect(useSettingsStore.getState().activeTab).toBe("advanced");
    expect(useSettingsStore.getState().open).toBe(true);
  });

  it("the Code tab is shown by default", () => {
    expect(useSettingsStore.getState().showCodeTab).toBe(true);
  });

  it("setShowCodeTab() toggles the preference and persists it", () => {
    useSettingsStore.getState().setShowCodeTab(false);
    expect(useSettingsStore.getState().showCodeTab).toBe(false);
    expect(localStorage.getItem("cherryblossom:showCodeTab")).toBe("0");

    useSettingsStore.getState().setShowCodeTab(true);
    expect(useSettingsStore.getState().showCodeTab).toBe(true);
    expect(localStorage.getItem("cherryblossom:showCodeTab")).toBe("1");
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

  it("initializes showCodeTab=true when the key is absent", async () => {
    const { useSettingsStore: fresh } = await import("./settingsStore");
    expect(fresh.getState().showCodeTab).toBe(true);
  });

  it("initializes showCodeTab=false only when localStorage holds '0'", async () => {
    localStorage.setItem("cherryblossom:showCodeTab", "0");
    const { useSettingsStore: fresh } = await import("./settingsStore");
    expect(fresh.getState().showCodeTab).toBe(false);
  });

  it("falls back to true when localStorage.getItem throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const { useSettingsStore: fresh } = await import("./settingsStore");
    expect(fresh.getState().showCodeTab).toBe(true);
  });
});
