// Pure geometry for the resizable chat rail. Kept dependency-free so it can be
// unit-tested in isolation and reused by every caller that touches chat width:
// the drag handle, the double-click reset, the CP1 wide toggle, and the
// reclamp that fires when the window or the component sidebar changes size.
//
// Layout the numbers assume (left → right):
//   [ component sidebar ][ main canvas ][ chat rail ]
// `sidebarWidth` is excluded from the resizable region; the canvas + chat share
// `rowWidth - sidebarWidth`. The canvas is never allowed below CANVAS_FLOOR, so
// that ceiling, plus a fraction cap, plus a hard min, bound the chat width.

export const CHAT_MIN_WIDTH = 320;
export const CHAT_DEFAULT_WIDTH = 440;
/** Chat may not exceed this fraction of the resizable region (canvas + chat). */
export const CHAT_MAX_FRACTION = 0.7;
/** The main canvas never shrinks below this — resizing chat stops here. */
export const CANVAS_FLOOR = 480;
/** CP1 "wide / focus" snap target, as a fraction of the resizable region. */
export const CHAT_WIDE_FRACTION = 0.58;

/** Snap targets the drag handle settles onto when released nearby (CP4). */
export const CHAT_SNAP_THRESHOLD = 18;

/**
 * The widest chat may be given the current geometry: the smaller of the
 * fraction cap and the canvas-floor cap, but never below the hard minimum
 * (on a very narrow window chat collapses toward its min and the canvas is
 * allowed to dip below its floor — chat yields first, per the overflow rule).
 */
export function maxChatWidth(rowWidth: number, sidebarWidth: number): number {
  const available = Math.max(0, rowWidth - sidebarWidth);
  const byFraction = available * CHAT_MAX_FRACTION;
  const byFloor = available - CANVAS_FLOOR;
  return Math.max(CHAT_MIN_WIDTH, Math.min(byFraction, byFloor));
}

/** Clamp a desired chat width into the valid range for the current geometry. */
export function clampChatWidth(
  desired: number,
  rowWidth: number,
  sidebarWidth: number
): number {
  const upper = maxChatWidth(rowWidth, sidebarWidth);
  const clamped = Math.min(Math.max(desired, CHAT_MIN_WIDTH), upper);
  return Math.round(clamped);
}

/** The CP1 wide-mode width for the current geometry (clamped like any other). */
export function wideChatWidth(rowWidth: number, sidebarWidth: number): number {
  const available = Math.max(0, rowWidth - sidebarWidth);
  return clampChatWidth(available * CHAT_WIDE_FRACTION, rowWidth, sidebarWidth);
}

/**
 * If `width` lands within CHAT_SNAP_THRESHOLD of a preset (min, default, or the
 * geometry's wide width), return the preset; otherwise return `width` unchanged.
 * Presets are themselves clamped so we never snap to an out-of-range value.
 */
export function snapChatWidth(
  width: number,
  rowWidth: number,
  sidebarWidth: number
): number {
  const presets = [
    CHAT_MIN_WIDTH,
    clampChatWidth(CHAT_DEFAULT_WIDTH, rowWidth, sidebarWidth),
    wideChatWidth(rowWidth, sidebarWidth),
  ];
  for (const preset of presets) {
    if (Math.abs(width - preset) <= CHAT_SNAP_THRESHOLD) return preset;
  }
  return width;
}
