import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChatTransportError,
  MANAGED_CHAT_COMPLETIONS_URL,
  completeText,
  managedModelId,
  streamTurn,
  toOpenRouterMessages,
  toOpenRouterTools,
} from "./chatTransport";

const managedAuth = {
  kind: "managed" as const,
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
});

describe("managed OpenRouter mapping", () => {
  it("targets the current managed Chat Completions endpoint", () => {
    expect(MANAGED_CHAT_COMPLETIONS_URL).toBe(
      "https://www.trycherryblossom.com/api/v1/chat/completions"
    );
  });

  it("maps only managed model IDs to canonical OpenRouter IDs", () => {
    expect(managedModelId("claude-haiku-4-5-20251001")).toBe(
      "anthropic/claude-haiku-4.5"
    );
    expect(managedModelId("claude-opus-4-8")).toBe(
      "tencent/hy3:free"
    );
    expect(managedModelId("unmapped-model")).toBe("unmapped-model");
  });

  it("maps system, tools, tool calls, results, and PDFs", () => {
    const messages = toOpenRouterMessages(
      [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
      [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: "YWJj",
              },
            },
            { type: "text", text: "read this" },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "checking" },
            {
              type: "tool_use",
              id: "call_1",
              name: "lookup",
              input: { id: 7 },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: { ok: true },
            },
          ],
        },
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
    expect(messages[2]).toMatchObject({
      role: "assistant",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "lookup", arguments: '{"id":7}' },
        },
      ],
    });
    expect(messages[3]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: '{"ok":true}',
    });

    expect(
      toOpenRouterTools([
        {
          name: "lookup",
          description: "Look it up",
          input_schema: { type: "object", required: ["id"] },
          cache_control: { type: "ephemeral" },
        },
      ])
    ).toEqual([
      {
        type: "function",
        function: {
          name: "lookup",
          description: "Look it up",
          parameters: { type: "object", required: ["id"] },
        },
      },
    ]);
  });
});

describe("managed OpenRouter streaming", () => {
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
      model: "claude-opus-4-8",
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
        model: "claude-opus-4-8",
        system: [{ type: "text", text: "system" }],
        messages: [{ role: "user", content: "go" }],
        tools: [
          { name: "first", input_schema: { type: "object" } },
          { name: "second", input_schema: { type: "object" } },
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
      model: "tencent/hy3:free",
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
        content: [
          ...turn.reasoning.replay,
          { type: "text", text: turn.text },
          ...turn.toolCalls.map((call) => ({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: call.input,
          })),
        ],
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
        model: "claude-opus-4-8",
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
        model: "claude-opus-4-8",
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
});

describe("native Anthropic BYOK", () => {
  it("keeps the native endpoint, headers, model, request body, and parser", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse([
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"text":"native"}}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
        "data: [DONE]\n\n",
      ])
    );

    const turn = await streamTurn({
      auth: { kind: "apiKey", key: "sk-user" },
      model: "claude-opus-4-8",
      system: [{ type: "text", text: "system" }],
      messages: [{ role: "user", content: "go" }],
      sessionId: "not-sent-to-anthropic",
    });

    expect(turn).toMatchObject({ text: "native", finishReason: "stop" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-api-key": "sk-user",
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        }),
      })
    );
    expect(fetchBody()).toEqual({
      model: "claude-opus-4-8",
      max_tokens: 8192,
      system: [{ type: "text", text: "system" }],
      messages: [{ role: "user", content: "go" }],
      stream: true,
    });
  });
});

describe("non-streaming completions", () => {
  it("reads managed Chat Completions text", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        choices: [{ message: { role: "assistant", content: '{"ok":true}' } }],
      })
    );
    await expect(
      completeText({
        auth: managedAuth,
        model: "claude-haiku-4-5-20251001",
        maxTokens: 1024,
        messages: [{ role: "user", content: "extract" }],
      })
    ).resolves.toBe('{"ok":true}');
    expect(fetchBody()).toMatchObject({
      model: "anthropic/claude-haiku-4.5",
      max_tokens: 1024,
      stream: false,
    });
  });

  it("reads native Anthropic text without changing its model", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ content: [{ type: "text", text: "native result" }] })
    );
    await expect(
      completeText({
        auth: { kind: "apiKey", key: "sk-user" },
        model: "claude-haiku-4-5-20251001",
        maxTokens: 1024,
        messages: [{ role: "user", content: "extract" }],
      })
    ).resolves.toBe("native result");
    expect(fetchBody()).toMatchObject({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
    });
  });
});
