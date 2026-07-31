import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom doesn't implement matchMedia at all — it's `undefined`, not a stub that
// returns false. Anything reaching for it throws a TypeError, which is a
// confusing way to discover that your component transitively renders a
// responsive one. `hooks/useViewport.ts` (useIsCompact / useIsTouch) and
// `hooks/useTheme.tsx` both depend on it, so that's most of the app's chrome.
//
// Every query reports `false`, which puts tests on the regular (desktop,
// fine-pointer, light-scheme) branch. A test that needs the compact or touch
// branch should override this per-test rather than change the default — the
// desktop layout is what the existing suite asserts.
// `typeof window` guard, not just `!window.matchMedia`: this setup file is
// shared with node-environment suites (server/proxy.test.mjs), where `window`
// is not merely empty but undefined.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    // Deprecated pre-EventTarget API; Radix and some deps still feature-detect it.
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  cleanup();
});
