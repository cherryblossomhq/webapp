/**
 * Open a URL in a new browser tab. `noopener,noreferrer` keeps the new tab
 * from scripting back into the app.
 */
export function openExternal(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}
