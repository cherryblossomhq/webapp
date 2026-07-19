export const BEFORE_APP_RELOAD_EVENT = "cherryblossom:beforeAppReload";

export function onBeforeAppReload(listener: (event: Event) => void): () => void {
  window.addEventListener(BEFORE_APP_RELOAD_EVENT, listener);
  return () => window.removeEventListener(BEFORE_APP_RELOAD_EVENT, listener);
}

// Gives mounted editors one synchronous chance to persist or veto in-memory
// work before a recovery reload tears down the page.
export function reloadApp(): boolean {
  if (typeof window === "undefined") return false;
  const event = new Event(BEFORE_APP_RELOAD_EVENT, { cancelable: true });
  if (!window.dispatchEvent(event)) return false;
  window.location.reload();
  return true;
}
