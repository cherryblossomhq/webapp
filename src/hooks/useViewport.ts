import { useCallback, useSyncExternalStore } from "react";

/**
 * Below this width the shell switches to its compact layout: the toolbar
 * collapses into an overflow menu and the properties drawer goes full-width.
 * It's the narrowest row that can still seat the canvas at a usable size
 * alongside the panels that overlay it.
 */
export const COMPACT_BREAKPOINT = 800;

function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onStoreChange);
      return () => mql.removeEventListener("change", onStoreChange);
    },
    [query],
  );
  // useSyncExternalStore reads the live value during the first render, so the
  // shell never paints a desktop frame and then snap to compact — a useState +
  // useEffect hook would.
  return useSyncExternalStore(
    subscribe,
    useCallback(() => window.matchMedia(query).matches, [query]),
  );
}

/**
 * True when the viewport is too narrow to host the canvas at full chrome. This
 * is a *layout capacity* question, not a device question — a half-width desktop
 * window is compact too, and gets the same treatment.
 */
export function useIsCompact(): boolean {
  return useMediaQuery(`(max-width: ${COMPACT_BREAKPOINT - 1}px)`);
}

/**
 * True on touch-primary devices — an imprecise pointer with no hover state.
 * Drives hit tolerances and forces hover-revealed controls visible; keep it out
 * of layout decisions, which should key off `useIsCompact` instead so that
 * resizing a desktop window behaves the same as a phone.
 */
export function useIsTouch(): boolean {
  return useMediaQuery("(pointer: coarse)");
}
