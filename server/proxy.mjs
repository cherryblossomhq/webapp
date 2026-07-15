// Same-origin CORS proxy for the handful of upstream hosts that don't send
// permissive CORS headers (EasyEDA's component API, the tscircuit model CDN,
// and the LCSC/JLCPCB datasheet CDNs). The browser calls
// `/api/proxy?url=<https url>` and this handler replays the request
// server-side, where CORS doesn't apply.
//
// One implementation, two mounts:
//  - dev/preview: wired into Vite as a middleware (see vite.config.ts)
//  - production:  re-exported as the Vercel function `api/proxy.mjs`
//
// Plain Node (req, res) style + .mjs so both runtimes load it without a
// build step.

const ALLOWED_PROXY_DOMAINS = [
  // EasyEDA component search / detail API (component import, datasheet URLs).
  "easyeda.com",
  // 3D model CDN used by the tscircuit 3D viewer.
  "modelcdn.tscircuit.com",
  // Datasheet PDFs discovered via EasyEDA metadata. Almost all JLCPCB parts
  // host theirs on these LCSC domains; anything else fails the allowlist and
  // the caller falls back to a metadata-only summary.
  "lcsc.com",
  "szlcsc.com",
  "jlcpcb.com",
];

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024; // datasheet PDFs cap at 12 MiB
const PROXY_TIMEOUT_MS = 30_000;

// Request headers never forwarded upstream — identity/security-sensitive, or
// hop-by-hop headers the fetch layer manages itself.
const BLOCKED_REQUEST_HEADERS = new Set([
  "host",
  "authorization",
  "cookie",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-vercel-forwarded-for",
  "x-real-ip",
  "connection",
  "content-length",
  "accept-encoding",
  "origin",
  "referer",
]);

// Response headers passed back to the browser. Everything else (set-cookie,
// hsts, upstream CORS noise) is dropped.
const FORWARDED_RESPONSE_HEADERS = ["content-type", "content-disposition"];

function isUrlAllowed(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname;
  return ALLOWED_PROXY_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default async function handleProxyRequest(req, res) {
  const query = new URL(req.url ?? "/", "http://localhost").searchParams;
  const target = query.get("url") ?? "";

  if (!isUrlAllowed(target)) {
    res.statusCode = 403;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end(`URL not in proxy allowlist: ${target}`);
    return;
  }

  const method = (req.method ?? "GET").toUpperCase();
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (BLOCKED_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    if (typeof value === "string") headers[key] = value;
  }

  const body =
    method === "GET" || method === "HEAD" ? undefined : await readBody(req);

  let upstream;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      body,
      redirect: "follow",
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });
  } catch (err) {
    res.statusCode = 502;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end(`Proxy request failed: ${err instanceof Error ? err.message : err}`);
    return;
  }

  res.statusCode = upstream.status;
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }

  if (!upstream.body) {
    res.end();
    return;
  }

  // Stream with a hard byte cap so a runaway upstream can't buffer forever.
  const reader = upstream.body.getReader();
  let sent = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sent += value.byteLength;
      if (sent > MAX_RESPONSE_BYTES) {
        void reader.cancel();
        res.destroy(new Error(`Response exceeded ${MAX_RESPONSE_BYTES} bytes`));
        return;
      }
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    res.destroy(err instanceof Error ? err : new Error(String(err)));
  }
}
