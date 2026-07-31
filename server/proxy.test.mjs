// @vitest-environment node

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import handleProxyRequest from "./proxy.mjs";

class MockRequest extends EventEmitter {
  constructor({ url, method = "GET", headers = {}, body, readableEnded = true }) {
    super();
    this.url = url;
    this.method = method;
    this.headers = headers;
    this.body = body;
    this.readableEnded = readableEnded;
  }
}

class MockResponse {
  statusCode = 200;
  headers = new Map();
  chunks = [];
  ended = false;
  destroyedWith = null;

  setHeader(name, value) {
    this.headers.set(name.toLowerCase(), String(value));
  }

  write(chunk) {
    this.chunks.push(Buffer.from(chunk));
    return true;
  }

  end(chunk) {
    if (chunk !== undefined) this.write(chunk);
    this.ended = true;
  }

  destroy(error) {
    this.destroyedWith = error;
    this.ended = true;
  }

  text() {
    return Buffer.concat(this.chunks).toString();
  }
}

function requestUrl(target) {
  return `/?url=${encodeURIComponent(target)}`;
}

async function invoke(options) {
  const req = new MockRequest(options);
  const res = new MockResponse();
  await handleProxyRequest(req, res);
  return res;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("proxy allowlist", () => {
  it.each([
    "not a URL",
    "http://easyeda.com/api/components",
    "https://easyeda.com.evil.test/steal",
    "https://evil-lcsc.com/file.pdf",
  ])("rejects %s", async (target) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await invoke({ url: requestUrl(target) });

    expect(res.statusCode).toBe(403);
    expect(res.text()).toContain("URL not in proxy allowlist");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows exact hosts and subdomains while stripping identity headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("ok", {
        status: 201,
        headers: {
          "content-type": "text/plain",
          "content-disposition": "inline",
          "set-cookie": "secret=1",
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await invoke({
      url: requestUrl("https://parts.easyeda.com/component/1"),
      headers: {
        authorization: "Bearer secret",
        cookie: "session=secret",
        accept: "application/json",
        "x-custom": "kept",
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://parts.easyeda.com/component/1",
      expect.objectContaining({
        method: "GET",
        headers: { accept: "application/json", "x-custom": "kept" },
        body: undefined,
        redirect: "manual",
      })
    );
    expect(res.statusCode).toBe(201);
    expect(res.text()).toBe("ok");
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(res.headers.has("set-cookie")).toBe(false);
  });

  it("serializes a host's pre-read form body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await invoke({
      url: requestUrl("https://easyeda.com/api/components/search"),
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: { wd: "C123", type: "3" },
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(Buffer.isBuffer(init.body)).toBe(true);
    expect(init.body.toString()).toBe("wd=C123&type=3");
    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
  });

  it("reads an untouched Vite request stream", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const req = new MockRequest({
      url: requestUrl("https://easyeda.com/api/components/search"),
      method: "POST",
      headers: { "content-type": "application/json" },
      readableEnded: false,
    });
    const res = new MockResponse();

    const pending = handleProxyRequest(req, res);
    req.emit("data", Buffer.from('{"query":'));
    req.emit("data", Buffer.from('"C123"}'));
    req.emit("end");
    await pending;

    const [, init] = fetchMock.mock.calls[0];
    expect(init.body.toString()).toBe('{"query":"C123"}');
    expect(res.text()).toBe("ok");
  });

  it("revalidates redirect targets and blocks hops outside the allowlist", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://attacker.test/secret" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await invoke({ url: requestUrl("https://easyeda.com/redirect") });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(502);
    expect(res.text()).toContain("Proxy redirect left allowlist");
  });

  it.each([300, 304, 305, 306])(
    "forwards non-redirect HTTP %s responses even when Location is present",
    async (status) => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(null, {
          status,
          headers: { location: "https://easyeda.com/not-a-redirect" },
        })
      );
      vi.stubGlobal("fetch", fetchMock);

      const res = await invoke({ url: requestUrl("https://easyeda.com/result") });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(status);
    }
  );

  it("follows a same-allowlist redirect and applies POST-to-GET semantics", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "/final" },
        })
      )
      .mockResolvedValueOnce(new Response("done"));
    vi.stubGlobal("fetch", fetchMock);

    const res = await invoke({
      url: requestUrl("https://easyeda.com/start"),
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { value: 1 },
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://easyeda.com/final",
      expect.objectContaining({
        method: "GET",
        headers: {},
        body: undefined,
        redirect: "manual",
      })
    );
    expect(res.text()).toBe("done");
  });

  it("maps upstream failures to a safe 502 response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    const res = await invoke({ url: requestUrl("https://lcsc.com/file.pdf") });

    expect(res.statusCode).toBe(502);
    expect(res.text()).toBe("Proxy request failed: offline");
  });

  it("destroys the response when the upstream exceeds the byte cap", async () => {
    const oversized = new Uint8Array(16 * 1024 * 1024 + 1);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(oversized, { status: 200 }))
    );

    const res = await invoke({ url: requestUrl("https://lcsc.com/file.pdf") });

    expect(res.destroyedWith).toBeInstanceOf(Error);
    expect(res.destroyedWith.message).toContain("Response exceeded");
    expect(res.ended).toBe(true);
  });
});
