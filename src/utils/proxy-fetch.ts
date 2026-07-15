// easyeda.com (and the EasyEDA model CDN) don't return permissive CORS headers,
// so any `fetch()` from the browser gets blocked by the CORS check. We install
// a shim on globalThis.fetch that routes those hosts through the same-origin
// `/api/proxy` endpoint (server-side fetch, where CORS doesn't apply — a Vite
// middleware in dev, a serverless function in production; both wrap
// server/proxy.mjs). Anything else passes through to native fetch unchanged.
//
// The primary consumer is the @tscircuit/eval Web Worker — when RunFrame is
// configured with `enableFetchProxy`, the worker forwards every fetch back to
// this main-thread shim via postMessage.

const PROXIED_HOSTS = ["easyeda.com", "modelcdn.tscircuit.com"];

const PROXY_ENDPOINT = "/api/proxy";

function shouldProxy(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname;
  return PROXIED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

function extractUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * Fetch `url` through the same-origin proxy endpoint regardless of host
 * (the server enforces its own allowlist). Used directly for datasheet PDFs,
 * whose LCSC-hosted URLs aren't in the shim's host list.
 */
export function proxyFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(`${PROXY_ENDPOINT}?url=${encodeURIComponent(url)}`, init);
}

// Module-level guard against double-install across HMR. Idempotent.
let installed = false;

export function installProxyFetch(): void {
  if (installed) return;
  installed = true;
  const nativeFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url = extractUrl(input);
    if (!shouldProxy(url)) return nativeFetch(input, init);
    // Re-target to the proxy endpoint; method/headers/body/signal carry over.
    // When `input` is a Request object its properties don't transfer to a new
    // URL automatically, so flatten the common ones explicitly.
    if (typeof input !== "string" && !(input instanceof URL)) {
      const req = input;
      return nativeFetch(`${PROXY_ENDPOINT}?url=${encodeURIComponent(url)}`, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: req.signal,
        ...init,
      } as RequestInit);
    }
    return nativeFetch(`${PROXY_ENDPOINT}?url=${encodeURIComponent(url)}`, init);
  };

  console.info("[proxy-fetch] installed for", PROXIED_HOSTS.join(", "));
}
