import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let nativeFetch: ReturnType<typeof vi.fn>;

async function loadProxyFetch() {
  vi.resetModules();
  return import("./proxy-fetch");
}

beforeEach(() => {
  nativeFetch = vi.fn().mockResolvedValue(new Response("ok"));
  vi.stubGlobal("fetch", nativeFetch);
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("proxyFetch", () => {
  it("encodes an arbitrary target for the server-enforced proxy allowlist", async () => {
    const { proxyFetch } = await loadProxyFetch();
    const signal = new AbortController().signal;

    await proxyFetch("https://datasheet.lcsc.com/a file.pdf?x=1", {
      headers: { accept: "application/pdf" },
      signal,
    });

    expect(nativeFetch).toHaveBeenCalledWith(
      "/api/proxy?url=https%3A%2F%2Fdatasheet.lcsc.com%2Fa%20file.pdf%3Fx%3D1",
      { headers: { accept: "application/pdf" }, signal }
    );
  });
});

describe("installProxyFetch", () => {
  it.each([
    "https://easyeda.com/api/components",
    "https://parts.easyeda.com/component/1",
    "https://modelcdn.tscircuit.com/model.glb",
  ])("routes %s through the same-origin proxy", async (target) => {
    const { installProxyFetch } = await loadProxyFetch();
    installProxyFetch();

    await globalThis.fetch(target, { headers: { accept: "x/test" } });

    expect(nativeFetch).toHaveBeenCalledWith(
      `/api/proxy?url=${encodeURIComponent(target)}`,
      { headers: { accept: "x/test" } }
    );
  });

  it.each([
    "http://easyeda.com/api/components",
    "https://easyeda.com.evil.test/steal",
    "https://example.test/data",
    "/relative/path",
  ])("leaves %s on native fetch", async (target) => {
    const { installProxyFetch } = await loadProxyFetch();
    installProxyFetch();

    await globalThis.fetch(target);

    expect(nativeFetch).toHaveBeenCalledWith(target, undefined);
  });

  it("preserves Request method, headers, body, and signal", async () => {
    const { installProxyFetch } = await loadProxyFetch();
    installProxyFetch();
    const controller = new AbortController();
    const request = new Request("https://easyeda.com/api/components/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "C123" }),
      signal: controller.signal,
    });

    await globalThis.fetch(request);

    expect(nativeFetch).toHaveBeenCalledWith(
      `/api/proxy?url=${encodeURIComponent(request.url)}`,
      expect.objectContaining({
        method: "POST",
        headers: request.headers,
        body: request.body,
        signal: request.signal,
      })
    );
  });

  it("is idempotent and never wraps an already wrapped fetch", async () => {
    const { installProxyFetch } = await loadProxyFetch();
    installProxyFetch();
    installProxyFetch();

    await globalThis.fetch("https://easyeda.com/one");

    expect(nativeFetch).toHaveBeenCalledTimes(1);
    expect(nativeFetch.mock.calls[0][0]).toBe(
      "/api/proxy?url=https%3A%2F%2Feasyeda.com%2Fone"
    );
  });
});
