import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isTypingTarget, registerShortcuts } from "./keyboard";

describe("isTypingTarget", () => {
  it("returns true for INPUT, TEXTAREA, SELECT", () => {
    const i = document.createElement("input");
    const ta = document.createElement("textarea");
    const sel = document.createElement("select");
    expect(isTypingTarget(i)).toBe(true);
    expect(isTypingTarget(ta)).toBe(true);
    expect(isTypingTarget(sel)).toBe(true);
  });

  it("returns true for contenteditable=true and any descendant", () => {
    const root = document.createElement("div");
    // setAttribute is portable across jsdom + browser; the `contentEditable`
    // property setter doesn't always reflect to the attribute in jsdom.
    root.setAttribute("contenteditable", "true");
    const child = document.createElement("span");
    root.appendChild(child);
    expect(isTypingTarget(root)).toBe(true);
    expect(isTypingTarget(child)).toBe(true);
  });

  it("returns true when role=textbox / combobox / searchbox", () => {
    const tb = document.createElement("div");
    tb.setAttribute("role", "textbox");
    expect(isTypingTarget(tb)).toBe(true);
    const cb = document.createElement("div");
    cb.setAttribute("role", "combobox");
    expect(isTypingTarget(cb)).toBe(true);
  });

  it("returns false for plain div, button, svg", () => {
    expect(isTypingTarget(document.createElement("div"))).toBe(false);
    expect(isTypingTarget(document.createElement("button"))).toBe(false);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    expect(isTypingTarget(svg)).toBe(false);
  });

  it("returns false for null / non-element targets", () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(window)).toBe(false);
  });
});

describe("registerShortcuts", () => {
  let target: HTMLDivElement;

  beforeEach(() => {
    target = document.createElement("div");
    document.body.appendChild(target);
  });
  afterEach(() => {
    target.remove();
  });

  function dispatch(key: string, opts: Partial<KeyboardEventInit & { target?: EventTarget }> = {}) {
    const ev = new KeyboardEvent("keydown", { key, ...opts, bubbles: true });
    Object.defineProperty(ev, "target", {
      value: opts.target ?? target,
    });
    target.dispatchEvent(ev);
  }

  it("fires the matching handler with no modifier", () => {
    const fn = vi.fn();
    const off = registerShortcuts([{ key: "m", handler: fn }], target);
    dispatch("m");
    expect(fn).toHaveBeenCalledTimes(1);
    off();
  });

  it("CRITICAL: does NOT fire when focus is in an input (allowInInput=false default)", () => {
    const fn = vi.fn();
    const off = registerShortcuts([{ key: "m", handler: fn }], target);
    const input = document.createElement("input");
    target.appendChild(input);
    dispatch("m", { target: input });
    expect(fn).not.toHaveBeenCalled();
    off();
  });

  it("DOES fire in input when allowInInput=true (e.g. Cmd+Z)", () => {
    const fn = vi.fn();
    const off = registerShortcuts(
      [{ key: "z", ctrlOrMeta: true, allowInInput: true, handler: fn }],
      target
    );
    const input = document.createElement("input");
    target.appendChild(input);
    dispatch("z", { ctrlKey: true, target: input });
    expect(fn).toHaveBeenCalledTimes(1);
    off();
  });

  it("requires modifiers to match exactly (shift not held)", () => {
    const fn = vi.fn();
    const off = registerShortcuts([{ key: "m", handler: fn }], target);
    dispatch("m", { shiftKey: true });
    expect(fn).not.toHaveBeenCalled();
    off();
  });

  it("ctrlOrMeta matches either Ctrl or Meta", () => {
    const fn = vi.fn();
    const off = registerShortcuts(
      [{ key: "z", ctrlOrMeta: true, handler: fn }],
      target
    );
    dispatch("z", { ctrlKey: true });
    dispatch("z", { metaKey: true });
    expect(fn).toHaveBeenCalledTimes(2);
    off();
  });

  it("only fires the FIRST matching shortcut (single-shot)", () => {
    const a = vi.fn();
    const b = vi.fn();
    const off = registerShortcuts(
      [
        { key: "x", handler: a },
        { key: "x", handler: b },
      ],
      target
    );
    dispatch("x");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    off();
  });

  it("unsubscribes cleanly", () => {
    const fn = vi.fn();
    const off = registerShortcuts([{ key: "m", handler: fn }], target);
    off();
    dispatch("m");
    expect(fn).not.toHaveBeenCalled();
  });
});
