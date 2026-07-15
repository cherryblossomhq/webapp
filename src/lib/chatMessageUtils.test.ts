import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { toast } from "sonner";
import { copyText, buildSuggestions } from "./chatMessageUtils";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

describe("buildSuggestions", () => {
  it("returns component-aware suggestions when something is selected", () => {
    const s = buildSuggestions({ isEmptyBoard: false, selectedName: "U1" });
    expect(s.every((x) => x.includes("U1"))).toBe(true);
  });

  it("selection takes precedence over board emptiness", () => {
    const s = buildSuggestions({ isEmptyBoard: true, selectedName: "R3" });
    expect(s[0]).toContain("R3");
  });

  it("returns starter prompts for an empty board", () => {
    const s = buildSuggestions({ isEmptyBoard: true, selectedName: null });
    expect(s.join(" ")).toMatch(/555|ESP32|power supply/i);
  });

  it("returns iterate-on-existing prompts for a populated board", () => {
    const s = buildSuggestions({ isEmptyBoard: false, selectedName: null });
    expect(s.join(" ")).toMatch(/pullup|grounds|power section/i);
  });
});

describe("copyText", () => {
  // Capture and restore the original clipboard descriptor so the stubbed
  // (sometimes rejecting) clipboard never leaks to other tests in this worker.
  const originalClipboard = Object.getOwnPropertyDescriptor(
    navigator,
    "clipboard"
  );

  function stubClipboard(writeText: () => Promise<void>) {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalClipboard) {
      Object.defineProperty(navigator, "clipboard", originalClipboard);
    } else {
      // jsdom had no clipboard to begin with — remove our stub entirely.
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });

  it("returns true and shows no error on success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const ok = await copyText("hello");
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("returns false and toasts on clipboard rejection (non-secure context)", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    stubClipboard(writeText);
    const ok = await copyText("hello");
    expect(ok).toBe(false);
    expect(toast.error).toHaveBeenCalledOnce();
  });
});
