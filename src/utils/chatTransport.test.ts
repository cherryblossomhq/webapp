import { afterEach, describe, expect, it, vi } from "vitest";

const datasheetMocks = vi.hoisted(() => ({
  fetchAndSummarize: vi.fn(),
  renderForModel: vi.fn((summary: { lcsc_id: string }) => `rendered:${summary.lcsc_id}`),
}));

vi.mock("./datasheets", () => datasheetMocks);

// PostHog is unavailable by default (mirrors a blocked/uninitialized SDK);
// individual tests override the return value to assert the header.
const analyticsMocks = vi.hoisted(() => ({
  getPostHogDistinctId: vi.fn((): string | undefined => undefined),
}));

vi.mock("./analytics", () => analyticsMocks);

import {
  CHAT_TOOLS,
  ChatTransportError,
  OPENROUTER_CHAT_COMPLETIONS_URL,
  completeText,
  fetchDatasheet,
  lookupFootprint,
  normalizePackageToCatalog,
  searchJlcpcb,
  streamTurn,
  toOpenRouterMessages,
} from "./chatTransport";

const managedAuth = {
  token: "workos-token",
  url: "https://example.test/api/v1/chat/completions",
};

function sseResponse(chunks: string[], headers?: Record<string, string>): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream", ...headers },
    }
  );
}

function fetchBody(call = 0): Record<string, unknown> {
  const [, init] = vi.mocked(fetch).mock.calls[call];
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
  datasheetMocks.fetchAndSummarize.mockReset();
  datasheetMocks.renderForModel.mockClear();
});

describe("OpenRouter mapping", () => {
  it("targets the current Chat Completions endpoint", () => {
    expect(OPENROUTER_CHAT_COMPLETIONS_URL).toBe(
      "https://www.trycherryblossom.com/api/v1/chat/completions"
    );
  });

  it("preserves native OpenRouter system, tool-call, result, and file messages", () => {
    const assistant = {
      role: "assistant",
      content: null,
      reasoning_details: [{ type: "reasoning.summary", summary: "checking" }],
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "lookup", arguments: '{"id":7}' },
        },
      ],
    };
    const toolResult = {
      role: "tool",
      tool_call_id: "call_1",
      content: '{"ok":true}',
    };
    const messages = toOpenRouterMessages(
      [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
      [
        {
          role: "user",
          content: [
            {
              type: "file",
              file: {
                filename: "datasheet.pdf",
                file_data: "data:application/pdf;base64,YWJj",
              },
            },
            { type: "text", text: "read this" },
          ],
        },
        assistant,
        toolResult,
      ]
    ) as Array<Record<string, unknown>>;

    expect(messages[0]).toEqual({
      role: "system",
      content: [
        { type: "text", text: "system", cache_control: { type: "ephemeral" } },
      ],
    });
    expect(messages[1]).toEqual({
      role: "user",
      content: [
        {
          type: "file",
          file: {
            filename: "datasheet.pdf",
            file_data: "data:application/pdf;base64,YWJj",
          },
        },
        { type: "text", text: "read this" },
      ],
    });
    expect(messages[2]).toBe(assistant);
    expect(messages[3]).toBe(toolResult);
  });

  it("defines every chat tool with the OpenRouter function schema", () => {
    expect(CHAT_TOOLS).toHaveLength(6);
    expect(CHAT_TOOLS.map((tool) => tool.function.name)).toEqual([
      "edit_tsx",
      "write_tsx",
      "search_jlcpcb",
      "import_component",
      "lookup_footprint",
      "fetch_datasheet",
    ]);
    for (const tool of CHAT_TOOLS) {
      expect(tool).toMatchObject({
        type: "function",
        function: {
          name: expect.any(String),
          description: expect.any(String),
          parameters: { type: "object" },
        },
      });
      expect(tool).not.toHaveProperty("input_schema");
    }
  });
});

describe("OpenRouter streaming", () => {
  it.each([
    ["stop", "stop"],
    ["length", "length"],
  ])("preserves the %s finish reason as %s", async (finishReason, expected) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse([
        `data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"${finishReason}"}]}\n\n`,
        "data: [DONE]\n\n",
      ])
    );

    const turn = await streamTurn({
      auth: managedAuth,
      model: "anthropic/claude-opus-4.8",
      system: [],
      messages: [{ role: "user", content: "go" }],
    });
    expect(turn.finishReason).toBe(expected);
  });

  it("handles arbitrary boundaries, comments, usage-only chunks, parallel tools, and reasoning replay", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse([
        ": OPENROUTER PRO",
        "CESSING\r\n\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"\",\"reasoning\":\"Plan\",\"reasoning_details\":[{\"type\":\"reasoning.summary\",\"summary\":\"Plan\",\"id\":\"r1\"}]}}]}\r\n",
        "\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"Done\",\"tool_calls\":[{\"index\":1,\"id\":\"call_b\",\"function\":{\"name\":\"second\",\"arguments\":\"{\\\"b\\\":\"}},{\"index\":0,\"id\":\"call_a\",\"function\":{\"name\":\"first\",\"arguments\":\"{\\\"a\\\":\"}}]}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"1}\"}},{\"index\":1,\"function\":{\"arguments\":\"2}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":2}}\n\n",
        "data: [DONE]\n\n",
      ])
    );
    const textDeltas: string[] = [];
    const thinkingDeltas: string[] = [];

    const turn = await streamTurn(
      {
        auth: managedAuth,
        model: "anthropic/claude-opus-4.8",
        system: [{ type: "text", text: "system" }],
        messages: [{ role: "user", content: "go" }],
        tools: [
          {
            type: "function",
            function: {
              name: "first",
              description: "First tool",
              parameters: { type: "object" },
            },
          },
          {
            type: "function",
            function: {
              name: "second",
              description: "Second tool",
              parameters: { type: "object" },
            },
          },
        ],
        thinkingEffort: "high",
        sessionId: "session-123",
      },
      {
        onText: (delta) => textDeltas.push(delta),
        onThinking: (delta) => thinkingDeltas.push(delta),
      }
    );

    expect(turn).toMatchObject({
      text: "Done",
      finishReason: "tool_calls",
      toolCalls: [
        { id: "call_a", name: "first", input: { a: 1 } },
        { id: "call_b", name: "second", input: { b: 2 } },
      ],
    });
    expect(textDeltas).toEqual(["Done"]);
    expect(thinkingDeltas).toEqual(["Plan"]);
    expect(turn.reasoning.text).toBe("Plan");
    expect(turn.reasoning.details).toEqual([
      {
        type: "reasoning.summary",
        summary: "Plan",
        id: "r1",
      },
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      managedAuth.url,
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer workos-token",
        },
      })
    );
    const body = fetchBody();
    expect(body).toMatchObject({
      model: "anthropic/claude-opus-4.8",
      max_tokens: 64000,
      stream: true,
      tool_choice: "auto",
      reasoning: { effort: "high" },
      cache_control: { type: "ephemeral" },
      session_id: "session-123",
    });
    expect(JSON.stringify(body)).not.toContain("anthropic-version");

    const replayMessages = toOpenRouterMessages([], [
      {
        role: "assistant",
        content: turn.text,
        reasoning_details: turn.reasoning.details,
        tool_calls: turn.toolCalls.map((call) => ({
            type: "function",
            id: call.id,
            function: {
              name: call.name,
              arguments: JSON.stringify(call.input),
            },
          })),
      },
    ]) as Array<Record<string, unknown>>;
    expect(replayMessages[0].reasoning_details).toEqual([
      {
        type: "reasoning.summary",
        summary: "Plan",
        id: "r1",
      },
    ]);
    expect(replayMessages[0]).not.toHaveProperty("reasoning");
  });

  it("sends the conversation trace id as X-Trace-Id and omits the header when absent", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ])
    );
    const base = {
      auth: managedAuth,
      model: "anthropic/claude-opus-4.8",
      system: [],
      messages: [{ role: "user", content: "go" }],
    };

    await streamTurn({ ...base, traceId: "3e9f2b1c-8a4d-4f6e-9b0a-1c2d3e4f5a6b" });
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      "x-trace-id": "3e9f2b1c-8a4d-4f6e-9b0a-1c2d3e4f5a6b",
    });

    await streamTurn(base);
    expect(fetchMock.mock.calls[1][1]?.headers).not.toHaveProperty("x-trace-id");
  });

  it("omits the Authorization header entirely on anonymous (token-less) auth", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ])
    );
    const base = {
      model: "tencent/hy3:free",
      system: [],
      messages: [{ role: "user", content: "go" }],
    };

    await streamTurn({ ...base, auth: { token: null, url: managedAuth.url } });
    expect(fetchMock.mock.calls[0][1]?.headers).not.toHaveProperty("authorization");

    await streamTurn({ ...base, auth: managedAuth });
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({
      authorization: "Bearer workos-token",
    });
  });

  it("sends the PostHog distinct id header only when PostHog has one", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ])
    );
    const base = {
      auth: managedAuth,
      model: "anthropic/claude-opus-4.8",
      system: [],
      messages: [{ role: "user", content: "go" }],
    };

    analyticsMocks.getPostHogDistinctId.mockReturnValueOnce("ph-distinct-1");
    await streamTurn(base);
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      "x-posthog-distinct-id": "ph-distinct-1",
    });

    await streamTurn(base);
    expect(fetchMock.mock.calls[1][1]?.headers).not.toHaveProperty(
      "x-posthog-distinct-id"
    );
  });

  it("surfaces mid-stream OpenRouter errors and keeps generation diagnostics", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse(
        [
          'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
          'data: {"error":{"code":502,"message":"provider failed"}}\n\n',
        ],
        { "x-generation-id": "gen_123" }
      )
    );

    await expect(
      streamTurn({
        auth: managedAuth,
        model: "anthropic/claude-opus-4.8",
        system: [],
        messages: [{ role: "user", content: "go" }],
      })
    ).rejects.toMatchObject({
      message: "api_error:provider failed",
      generationId: "gen_123",
    });
  });

  it("keeps Retry-After and OpenRouter error messages on HTTP failures", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: 429, message: "slow down" } }),
        { status: 429, headers: { "retry-after": "12" } }
      )
    );

    try {
      await streamTurn({
        auth: managedAuth,
        model: "anthropic/claude-opus-4.8",
        system: [],
        messages: [{ role: "user", content: "go" }],
      });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ChatTransportError);
      expect(error).toMatchObject({ retryAfter: "12" });
      expect(String(error)).toContain("slow down");
    }
  });

  it("rejects malformed SSE and a response with no body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      sseResponse(["data: {not-json}\n\n"])
    );
    await expect(
      streamTurn({
        auth: managedAuth,
        model: "model",
        system: [],
        messages: [],
      })
    ).rejects.toThrow("api_error:Invalid SSE payload");

    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(
      streamTurn({
        auth: managedAuth,
        model: "model",
        system: [],
        messages: [],
      })
    ).rejects.toThrow("api_error:Response had no body");
  });
});

describe("non-streaming completions", () => {
  it("reads OpenRouter Chat Completions text", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        choices: [{ message: { role: "assistant", content: '{"ok":true}' } }],
      })
    );
    await expect(
      completeText({
        auth: managedAuth,
        model: "anthropic/claude-haiku-4.5",
        maxTokens: 1024,
        messages: [{ role: "user", content: "extract" }],
        traceId: "3e9f2b1c-8a4d-4f6e-9b0a-1c2d3e4f5a6b",
      })
    ).resolves.toBe('{"ok":true}');
    expect(fetchBody()).toMatchObject({
      model: "anthropic/claude-haiku-4.5",
      max_tokens: 1024,
      stream: false,
    });
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      "x-trace-id": "3e9f2b1c-8a4d-4f6e-9b0a-1c2d3e4f5a6b",
    });
  });

  it("joins text blocks and preserves diagnostics on HTTP errors", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          choices: [
            {
              message: {
                content: [{ type: "text", text: " first " }, { text: "second" }],
              },
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        new Response("upstream broke", {
          status: 502,
          headers: { "x-generation-id": "gen_failure" },
        })
      );

    const args = {
      auth: managedAuth,
      model: "helper",
      maxTokens: 50,
      messages: [],
    };
    await expect(completeText(args)).resolves.toBe("first second");
    await expect(completeText(args)).rejects.toMatchObject({
      message: "502:upstream broke",
      generationId: "gen_failure",
    });
  });
});

describe("catalog and datasheet tool backends", () => {
  it("normalizes common JLCPCB package spellings", () => {
    expect(normalizePackageToCatalog("SOT-23-5")).toBe("sot23_5");
    expect(normalizePackageToCatalog("SOIC-8")).toBe("soic8");
    expect(normalizePackageToCatalog("0402_1005Metric")).toBe("0402");
    expect(normalizePackageToCatalog("unknown-package")).toBeNull();
  });

  it("caps search results and formats catalog metadata for the model", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        components: [
          {
            lcsc: 123,
            mfr: "REG123",
            description: "3.3V regulator",
            package: "SOT-23-5",
            stock: 42,
            is_basic: true,
            price: 0.0123,
          },
        ],
      })
    );

    const result = await searchJlcpcb(" 3.3V regulator ", 99);

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://jlcsearch.tscircuit.com/api/search?q=3.3V%20regulator&limit=8"
    );
    expect(result).toContain("C123 | REG123 | 3.3V regulator");
    expect(result).toContain("[JLCPCB Basic]");
    await expect(searchJlcpcb("   ")).resolves.toBe(
      "Error: search query is required"
    );
  });

  it("returns canonical footprint matches and graceful lookup errors", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          components: [{ lcsc: 123, mfr: "REG123", package: "SOT-23-5" }],
        })
      )
      .mockResolvedValueOnce(new Response("", { status: 503 }));

    await expect(lookupFootprint("C123")).resolves.toContain(
      "Canonical footprint: sot23_5"
    );
    await expect(lookupFootprint(undefined, "REG123")).resolves.toBe(
      "Footprint lookup error: Search API error: 503"
    );
    await expect(lookupFootprint()).resolves.toBe(
      "Error: lookup_footprint requires lcsc_id or mpn"
    );
  });

  it("delegates datasheet extraction and converts failures into tool results", async () => {
    datasheetMocks.fetchAndSummarize
      .mockResolvedValueOnce({ lcsc_id: "C123" })
      .mockRejectedValueOnce(new Error("helper unavailable"));

    await expect(
      fetchDatasheet(managedAuth, "helper", " C123 ", " REG123 ", "trace-uuid")
    ).resolves.toBe("rendered:C123");
    expect(datasheetMocks.fetchAndSummarize).toHaveBeenCalledWith(
      managedAuth,
      "helper",
      "C123",
      "REG123",
      "trace-uuid"
    );
    await expect(
      fetchDatasheet(managedAuth, "helper", "C456")
    ).resolves.toBe("Datasheet fetch failed: helper unavailable");
    await expect(fetchDatasheet(managedAuth, "helper", " ")).resolves.toBe(
      "Error: fetch_datasheet requires lcsc_id"
    );
  });
});
