// Tiny logger so prod builds can mute non-actionable console output without
// rewriting every call site. import.meta.env.DEV is true in `vite dev` and
// false in production builds.

const isDev = typeof import.meta !== "undefined" && import.meta.env?.DEV;

export const log = {
  debug(...args: unknown[]): void {
    if (isDev) console.debug(...args);
  },
  info(...args: unknown[]): void {
    if (isDev) console.info(...args);
  },
  warn(...args: unknown[]): void {
    console.warn(...args);
  },
  error(...args: unknown[]): void {
    console.error(...args);
  },
};
