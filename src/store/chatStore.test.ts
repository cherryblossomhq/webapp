import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { MeResponse } from "@/utils/accountApi";

// Mock the chat transport before chatStore is imported. Test calls use a single
// dispatcher-style spy: streamTurn maps to "chat_stream_turn", and tool
// backends map to their command names. Live deltas flow through callbacks from
// the most recent streamTurn call (emitStream below).
const mockInvoke = vi.fn();
const candidateValidationHarness = vi.hoisted(() => ({
  validate: vi.fn(),
}));
const VALIDATED_CIRCUIT_JSON = [
  { type: "schematic_component", schematic_component_id: "schematic_R1" },
  { type: "source_component", name: "R1" },
];

interface CapturedCallbacks {
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
}
let currentCallbacks: CapturedCallbacks | null = null;

vi.mock("../utils/chatTransport", () => ({
  OPENROUTER_CHAT_COMPLETIONS_URL:
    "https://www.trycherryblossom.com/api/v1/chat/completions",
  // The loop only reads tool names out of the catalog; a name-only stub keeps
  // the mock decoupled from the real schemas.
  CHAT_TOOLS: [
    { type: "function", function: { name: "edit_tsx" } },
    { type: "function", function: { name: "write_tsx" } },
    { type: "function", function: { name: "search_jlcpcb" } },
    { type: "function", function: { name: "import_component" } },
    { type: "function", function: { name: "lookup_footprint" } },
    { type: "function", function: { name: "fetch_datasheet" } },
    { type: "function", function: { name: "finish_circuit_edit" } },
  ],
  streamTurn: (args: unknown, callbacks?: CapturedCallbacks) => {
    currentCallbacks = callbacks ?? null;
    return mockInvoke("chat_stream_turn", args);
  },
  searchJlcpcb: (query: string, limit?: number) =>
    mockInvoke("search_jlcpcb", { query, limit }),
  lookupFootprint: (lcscId?: string, mpn?: string) =>
    mockInvoke("lookup_footprint", { lcscId, mpn }),
  fetchDatasheet: (
    auth: unknown,
    model: string,
    lcscId: string,
    mpn?: string,
    traceId?: string,
  ) => mockInvoke("fetch_datasheet", { auth, model, lcscId, mpn, traceId }),
}));

// Datasheet summaries live in localStorage; no cache entries in tests.
vi.mock("../utils/datasheets", () => ({
  listCachedDatasheets: vi.fn(() => []),
}));

vi.mock("../ai/candidateValidation", () => ({
  validateCandidateTsx: candidateValidationHarness.validate,
  buildCandidateRepairPrompt: (result: { candidateTsx: string }) =>
    `VALIDATION_REPAIR\n${result.candidateTsx}`,
}));

// Sonner toast — silence in tests
vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}));

// Stub out circuit checks so validation pipeline stays deterministic.
vi.mock("@tscircuit/checks", () => ({
  runAllChecks: vi.fn(async () => []),
}));

// import_component resolves through this inline (no network in tests).
vi.mock("../utils/easyedaImport", () => ({
  fetchComponentDef: vi.fn(),
}));

import {
  useChatStore,
  applyTsxStringEdit,
  capSnapshots,
  clearLegacyByokStorage,
  ensureTraceId,
  isAiSetupError,
  PREFERRED_HELPER_MODEL,
  resolveHelperModel,
} from "./chatStore";
import { useCircuitStore } from "./circuitStore";
import { useAuthStore } from "./authStore";
import { useAccountStore } from "./accountStore";
import { fetchComponentDef } from "../utils/easyedaImport";

const mockFetchDef = vi.mocked(fetchComponentDef);

describe("isAiSetupError", () => {
  it("recognizes every composer setup sentinel", () => {
    expect(isAiSetupError("no_account")).toBe(true);
    expect(isAiSetupError("no_managed_model")).toBe(true);
    expect(isAiSetupError("Connection error")).toBe(false);
    expect(isAiSetupError(null)).toBe(false);
  });
});

describe("helper model routing", () => {
  it("prefers Haiku when the plan allows it", () => {
    expect(
      resolveHelperModel(
        ["anthropic/claude-opus-4.8", PREFERRED_HELPER_MODEL],
        "anthropic/claude-opus-4.8",
      ),
    ).toBe(PREFERRED_HELPER_MODEL);
  });

  it("falls back to the selected model when Haiku is unavailable", () => {
    expect(
      resolveHelperModel(
        ["anthropic/claude-sonnet-5", "anthropic/claude-opus-4.8"],
        "anthropic/claude-opus-4.8",
      ),
    ).toBe("anthropic/claude-opus-4.8");
  });
});

describe("legacy BYOK cleanup", () => {
  it("removes stored API keys and provider choices", () => {
    localStorage.setItem("cherryblossom_api_key", "sk-old");
    localStorage.setItem("cherryblossom_ai_provider", "apiKey");

    clearLegacyByokStorage(localStorage);

    expect(localStorage.getItem("cherryblossom_api_key")).toBeNull();
    expect(localStorage.getItem("cherryblossom_ai_provider")).toBeNull();
  });
});

// A turn that finishes on tool_calls with the given tool calls.
function toolUseTurn(
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>
) {
  return {
    text: "",
    toolCalls,
    reasoning: { text: "", details: [] },
    finishReason: "tool_calls",
  };
}

function emitStream(text: string) {
  currentCallbacks?.onText?.(text);
}

function emitThinking(text: string) {
  currentCallbacks?.onThinking?.(text);
}

// A single-turn `chat_stream_turn` result: no tool calls, model is done. The
// live answer text streams via the onText callback (emitStream); `text` here
// is just what the resolved turn carries.
function turnResult(text = "") {
  return {
    text,
    toolCalls: [],
    reasoning: { text: "", details: [] },
    finishReason: "stop",
  };
}

// Read a message's text whether it's a plain string or a cache-marked content
// block array (the loop wraps the last assistant turn for prompt caching).
function msgText(m: { content: unknown }): string {
  if (typeof m.content === "string") return m.content;
  const blocks = m.content as Array<{ text?: string }>;
  return blocks.map((b) => b.text ?? "").join("");
}

// Concatenated text of the system blocks (static prompt + dynamic context).
function systemText(args: { system: Array<{ text?: string }> }): string {
  return args.system.map((b) => b.text ?? "").join("\n");
}

function toolResultText(messages: Array<{ role: string; content: unknown }>): string {
  return messages
    .filter((message) => message.role === "tool")
    .map((message) => String(message.content ?? ""))
    .join("\n");
}

// Alternating user/assistant turns (even = user, starting with user) so the
// resulting tail always begins with a user message.
function seedMessages(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `seed-${i}`,
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `msg ${i}`,
    timestamp: 1000 + i,
  }));
}

function setManagedAccount(
  selectedModel = "anthropic/claude-opus-4.8",
  allowedModels = [
    "anthropic/claude-sonnet-5",
    "anthropic/claude-opus-4.8",
  ],
) {
  const account: MeResponse = {
    user: { id: "u1", email: "a@b.c", name: null },
    plan: {
      tier: "pro",
      name: "Pro",
      managedAi: true,
      allowedModels,
    },
    limits: {
      maxTokensPerRequest: 64_000,
      requestsPerMinute: 10,
      requestsPerDay: 200,
      monthlyTokens: 2_000_000,
    },
    usage: {
      requestsThisMinute: 0,
      minuteResetsAt: null,
      requestsThisDay: 0,
      dayResetsAt: null,
      monthlyTokens: 0,
      monthResetsAt: null,
    },
    unlimitedCredits: false,
  };
  useAccountStore.setState({
    account,
    accountUserId: "u1",
    status: "ready",
    error: null,
    selectedModel,
  });
}

// The design/chat turn sends the tool catalog; the background fold sends no
// tools. Used to tell the two `chat_stream_turn` calls apart in assertions.
function lastDesignCall() {
  return [...mockInvoke.mock.calls]
    .reverse()
    .find(
      (c) =>
        c[0] === "chat_stream_turn" &&
        Array.isArray((c[1] as { tools?: unknown[] }).tools) &&
        ((c[1] as { tools: unknown[] }).tools.length ?? 0) > 0
    )?.[1] as
    | {
        messages: { role: string; content: unknown }[];
        system: Array<{ text?: string }>;
      }
    | undefined;
}

describe("applyTsxStringEdit", () => {
  const TSX = `<board>
  <resistor name="R1" resistance="10k" key="r1_aaa111" />
  <resistor name="R2" resistance="10k" key="r2_bbb222" />
</board>`;

  it("replaces a unique occurrence", () => {
    const r = applyTsxStringEdit(TSX, 'resistance="10k" key="r1_aaa111"', 'resistance="4.7k" key="r1_aaa111"', false);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tsx).toContain('resistance="4.7k"');
      expect(r.replacements).toBe(1);
    }
  });

  it("errors when old_string is not found", () => {
    const r = applyTsxStringEdit(TSX, 'resistance="100k"', "x", false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not found/i);
  });

  it("errors on an ambiguous (non-unique) match without replace_all", () => {
    const r = applyTsxStringEdit(TSX, 'resistance="10k"', 'resistance="1k"', false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/appears 2 times/i);
  });

  it("replaces every occurrence with replace_all", () => {
    const r = applyTsxStringEdit(TSX, 'resistance="10k"', 'resistance="1k"', true);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.replacements).toBe(2);
      expect(r.tsx).not.toContain('resistance="10k"');
    }
  });

  it("deletes when new_string is empty", () => {
    const r = applyTsxStringEdit(TSX, '\n  <resistor name="R2" resistance="10k" key="r2_bbb222" />', "", false);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tsx).not.toContain("R2");
  });

  it("rejects an identical no-op edit", () => {
    const r = applyTsxStringEdit(TSX, 'name="R1"', 'name="R1"', false);
    expect(r.ok).toBe(false);
  });

  it("treats new_string literally (no $-pattern expansion)", () => {
    const r = applyTsxStringEdit('a name="R1" b', 'name="R1"', 'name="$&LED"', false);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tsx).toBe('a name="$&LED" b');
  });

  it("rejects an empty old_string", () => {
    const r = applyTsxStringEdit(TSX, "", "x", false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/empty/i);
  });

  it("reports a single replacement when replace_all matches one occurrence", () => {
    const r = applyTsxStringEdit(TSX, 'name="R1"', 'name="R9"', true);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.replacements).toBe(1);
  });

  it("still errors as not-found when replace_all is set but old_string is absent", () => {
    const r = applyTsxStringEdit(TSX, "does-not-exist", "x", true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not found/i);
  });
});

describe("capSnapshots", () => {
  const mk = (
    id: string,
    role: "user" | "assistant" | "system",
    snap?: string
  ) => ({
    id,
    role,
    content: id,
    timestamp: 0,
    ...(snap !== undefined ? { tsxSnapshot: snap } : {}),
  });

  it("returns the same array reference when within the cap", () => {
    const msgs = [mk("a", "assistant", "x"), mk("b", "assistant", "y")];
    expect(capSnapshots(msgs, 5)).toBe(msgs);
  });

  it("strips snapshots from all but the most recent `max` assistant turns", () => {
    const msgs = [
      mk("a0", "assistant", "s0"),
      mk("u", "user"),
      mk("a1", "assistant", "s1"),
      mk("a2", "assistant", "s2"),
    ];
    const out = capSnapshots(msgs, 2);
    // Newest two (a1, a2) keep their snapshot; the oldest (a0) loses it.
    expect(out.find((m) => m.id === "a0")?.tsxSnapshot).toBeUndefined();
    expect(out.find((m) => m.id === "a1")?.tsxSnapshot).toBe("s1");
    expect(out.find((m) => m.id === "a2")?.tsxSnapshot).toBe("s2");
    // Non-snapshot rows are left untouched.
    expect(out.find((m) => m.id === "u")?.role).toBe("user");
  });

  it("does not count user/system rows toward the cap", () => {
    const msgs = [
      mk("a0", "assistant", "s0"),
      mk("s", "system"),
      mk("u", "user"),
      mk("a1", "assistant", "s1"),
    ];
    // Two assistant snapshots under a cap of 2 → nothing stripped.
    expect(capSnapshots(msgs, 2)).toBe(msgs);
  });

  it("caps toolTranscript on the same window as tsxSnapshot", () => {
    const transcript = [{ role: "tool", tool_call_id: "t1", content: "r" }];
    const msgs = [
      { ...mk("a0", "assistant", "s0"), toolTranscript: transcript },
      mk("u", "user"),
      { ...mk("a1", "assistant", "s1"), toolTranscript: transcript },
      { ...mk("a2", "assistant", "s2"), toolTranscript: transcript },
    ];
    const out = capSnapshots(msgs, 2);
    expect(out.find((m) => m.id === "a0")?.toolTranscript).toBeUndefined();
    expect(out.find((m) => m.id === "a1")?.toolTranscript).toBe(transcript);
    expect(out.find((m) => m.id === "a2")?.toolTranscript).toBe(transcript);
  });
});

describe("chatStore", () => {
  beforeEach(() => {
    currentCallbacks = null;
    mockInvoke.mockReset();
    mockFetchDef.mockReset();
    candidateValidationHarness.validate.mockReset();
    candidateValidationHarness.validate.mockImplementation(
      async ({ candidateTsx }: { candidateTsx: string }) => ({
        ok: true,
        candidateTsx,
        circuitJson: VALIDATED_CIRCUIT_JSON,
        issues: [],
        newErrors: [],
        newWarnings: [],
        durationMs: 1,
      }),
    );
    useChatStore.setState({
      messages: [],
      isStreaming: false,
      streamingEvents: [],
      chatOpen: false,
      error: null,
      sessionNotes: null,
      summarizedCount: 0,
    });
    useAuthStore.setState({
      status: "signedIn",
      user: {
        id: "u1",
        email: "a@b.c",
        first_name: null,
        last_name: null,
        profile_picture_url: null,
      },
      accessToken: "workos-token",
      error: null,
    });
    setManagedAccount();
    useCircuitStore.getState().resetCircuit();
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  describe("sendMessage — happy path", () => {
    it("keeps reasoning contiguous when a provider interleaves empty text deltas", async () => {
      mockInvoke.mockImplementation(async () => {
        emitThinking("The");
        emitStream("");
        emitThinking(" user");
        emitStream("");
        emitThinking(" asks");
        emitStream("Answer");
        return turnResult("Answer");
      });

      await useChatStore.getState().sendMessage("hi");

      const assistant = useChatStore
        .getState()
        .messages.find((message) => message.role === "assistant");
      expect(assistant?.events).toEqual([
        { kind: "thinking", text: "The user asks" },
        { kind: "text", text: "Answer" },
      ]);
    });

    it("streams assistant content and stores the assistant message", async () => {
      mockInvoke.mockImplementation(async () => {
        emitStream("Hello ");
        emitStream("world");
        return turnResult("Hello world");
      });

      const promise = useChatStore.getState().sendMessage("hi");
      await promise;

      const messages = useChatStore.getState().messages;
      expect(messages.filter((m) => m.role === "user")).toHaveLength(1);
      const assistant = messages.filter((m) => m.role === "assistant");
      expect(assistant).toHaveLength(1);
      expect(assistant[0].content).toBe("Hello world");
      expect(useChatStore.getState().isStreaming).toBe(false);
    });

    it("does not start a second send while streaming", async () => {
      let resolveInvoke!: () => void;
      mockInvoke.mockImplementation(
        () =>
          new Promise((resolve) => {
            // Emit text on resolve so fullResponse is non-empty — otherwise the
            // loop would fire a (never-resolving) tool-free recovery turn.
            resolveInvoke = () => {
              emitStream("done");
              resolve(turnResult("done"));
            };
          })
      );

      const first = useChatStore.getState().sendMessage("first");
      // While the first is in flight, send a second
      const second = useChatStore.getState().sendMessage("second");
      await second;
      // Drain microtask queue so sendMessage("first") reaches invoke and sets resolveInvoke
      await new Promise<void>((r) => setTimeout(r, 0));

      // Only one user message should be queued
      expect(
        useChatStore.getState().messages.filter((m) => m.role === "user")
      ).toHaveLength(1);

      // Now let the first finish
      resolveInvoke();
      await first;
    });
  });

  describe("sendMessage — error paths", () => {
    it("surfaces 401 as an expired-session error and does not stream", async () => {
      mockInvoke.mockImplementation(async () => {
        throw "401: bad key";
      });

      await useChatStore.getState().sendMessage("hi");

      const state = useChatStore.getState();
      expect(state.isStreaming).toBe(false);
      expect(state.error).toMatch(/session has expired/i);
    });

    it("classifies 429 as a rate-limit error", async () => {
      mockInvoke.mockImplementation(async () => {
        throw "429: rate limited";
      });

      await useChatStore.getState().sendMessage("hi");
      expect(useChatStore.getState().error).toMatch(/usage limit/i);
    });

    it("preserves a partial response with an interrupted marker on failure", async () => {
      mockInvoke.mockImplementation(async () => {
        emitStream("Partial reply before error");
        throw "connection broke";
      });

      await useChatStore.getState().sendMessage("hi");

      const assistant = useChatStore
        .getState()
        .messages.filter((m) => m.role === "assistant");
      expect(assistant).toHaveLength(1);
      expect(assistant[0].content).toContain("Partial reply before error");
      expect(assistant[0].content).toMatch(/interrupted/i);
    });
  });

  describe("sendMessage — guardrails", () => {
    it("requires a signed-in session", async () => {
      useAuthStore.setState({ status: "signedOut", user: null, accessToken: null });
      await useChatStore.getState().sendMessage("hi");
      expect(useChatStore.getState().error).toBe("no_account");
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("requires an allowed account model", async () => {
      useAuthStore.setState({
        status: "signedIn",
        accessToken: "workos-token",
        user: {
          id: "u1",
          email: "a@b.c",
          first_name: null,
          last_name: null,
          profile_picture_url: null,
        },
      });
      useAccountStore.setState({ selectedModel: null });

      await useChatStore.getState().sendMessage("hi");

      expect(useChatStore.getState().error).toBe("no_managed_model");
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("does not trust a persisted model before account access is resolved", async () => {
      useAuthStore.setState({
        status: "signedIn",
        accessToken: "workos-token",
        user: {
          id: "u1",
          email: "a@b.c",
          first_name: null,
          last_name: null,
          profile_picture_url: null,
        },
      });
      useAccountStore.setState({
        account: null,
        accountUserId: null,
        status: "loading",
        selectedModel: "anthropic/claude-opus-4.8",
      });

      await useChatStore.getState().sendMessage("hi");

      expect(useChatStore.getState().error).toBe("no_managed_model");
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("truncates over-long user messages", async () => {
      mockInvoke.mockImplementation(async () => {
        emitStream("ok");
        return turnResult("ok");
      });
      const huge = "x".repeat(60_000);
      await useChatStore.getState().sendMessage(huge);
      const userMsgs = useChatStore
        .getState()
        .messages.filter((m) => m.role === "user");
      expect(userMsgs[0].content.length).toBeLessThanOrEqual(50_000);
    });
  });

  describe("OpenRouter credential", () => {
    it("sends the WorkOS access token and selected model", async () => {
      mockInvoke.mockImplementation(async () => {
        emitStream("ok");
        return turnResult("ok");
      });
      await useChatStore.getState().sendMessage("hi");
      const call = mockInvoke.mock.calls.find((c) => c[0] === "chat_stream_turn");
      const args = call![1] as {
        auth: unknown;
        sessionId: string;
        traceId: string;
      };
      expect(args.auth).toEqual({
        token: "workos-token",
        url: "https://www.trycherryblossom.com/api/v1/chat/completions",
      });
      expect(args.sessionId).toBe(useChatStore.getState().sessionId);
      expect(args.traceId).toBe(useChatStore.getState().traceId);
    });

    it("keeps one trace id across every round of a tool loop and across turns", async () => {
      let turn = 0;
      mockInvoke.mockImplementation(async (command: string) => {
        if (command === "search_jlcpcb") return "C1 | part";
        if (turn++ === 0) {
          return toolUseTurn([
            { id: "t1", name: "search_jlcpcb", input: { query: "part" } },
          ]);
        }
        emitStream("done");
        return turnResult("done");
      });

      await useChatStore.getState().sendMessage("find a part");
      await useChatStore.getState().sendMessage("thanks");

      const traceIds = mockInvoke.mock.calls
        .filter(([command]) => command === "chat_stream_turn")
        .map(([, args]) => (args as { traceId: string }).traceId);
      expect(traceIds).toHaveLength(3);
      expect(new Set(traceIds).size).toBe(1);
      expect(traceIds[0]).toBe(useChatStore.getState().traceId);
    });

    it("snapshots the selected managed model for every tool-loop round", async () => {
      useAuthStore.setState({
        status: "signedIn",
        accessToken: "workos-token",
        user: {
          id: "u1",
          email: "a@b.c",
          first_name: null,
          last_name: null,
          profile_picture_url: null,
        },
      });
      useAccountStore.setState({ selectedModel: "anthropic/claude-sonnet-5" });
      setManagedAccount("anthropic/claude-sonnet-5");
      let turn = 0;
      mockInvoke.mockImplementation(async (command: string) => {
        if (command === "search_jlcpcb") return "C1 | part";
        if (turn++ === 0) {
          useAccountStore.setState({
            selectedModel: "anthropic/claude-opus-4.8",
          });
          return toolUseTurn([
            { id: "t1", name: "search_jlcpcb", input: { query: "part" } },
          ]);
        }
        emitStream("done");
        return turnResult("done");
      });

      await useChatStore.getState().sendMessage("find a part");

      const models = mockInvoke.mock.calls
        .filter(([command]) => command === "chat_stream_turn")
        .map(([, args]) => (args as { model: string }).model);
      expect(models).toEqual([
        "anthropic/claude-sonnet-5",
        "anthropic/claude-sonnet-5",
      ]);
    });
  });

  describe("clearHistory", () => {
    it("removes all messages and clears errors", () => {
      useChatStore.setState({
        messages: [
          { id: "1", role: "user", content: "hi", timestamp: Date.now() },
        ],
        error: "boom",
      });
      useChatStore.getState().clearHistory();
      expect(useChatStore.getState().messages).toHaveLength(0);
      expect(useChatStore.getState().error).toBeNull();
    });

    it("resets the rolling-history boundary", () => {
      useChatStore.setState({ sessionNotes: "old notes", summarizedCount: 4 });
      useChatStore.getState().clearHistory();
      expect(useChatStore.getState().sessionNotes).toBeNull();
      expect(useChatStore.getState().summarizedCount).toBe(0);
    });

    it("rotates the managed routing session ID", () => {
      const previous = useChatStore.getState().sessionId;
      useChatStore.getState().clearHistory();
      expect(useChatStore.getState().sessionId).not.toBe(previous);
    });

    it("rotates the PostHog trace id so a new conversation gets a new trace", () => {
      const previous = useChatStore.getState().traceId;
      useChatStore.getState().clearHistory();
      expect(useChatStore.getState().traceId).not.toBe(previous);
    });
  });

  describe("ensureTraceId", () => {
    const UUID_SHAPE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    it("returns the stored trace id unchanged when it is a plain UUID", () => {
      const current = useChatStore.getState().traceId;
      expect(UUID_SHAPE.test(current)).toBe(true);
      expect(ensureTraceId()).toBe(current);
      expect(useChatStore.getState().traceId).toBe(current);
    });

    it("lazily mints and persists a UUID when the stored id is missing or malformed", () => {
      // A conversation persisted before trace grouping existed has no traceId.
      useChatStore.setState({ traceId: undefined as unknown as string });
      const minted = ensureTraceId();
      expect(minted).toMatch(UUID_SHAPE);
      expect(useChatStore.getState().traceId).toBe(minted);
      // Stable on subsequent requests.
      expect(ensureTraceId()).toBe(minted);

      // A corrupted value is replaced rather than sent (the proxy would ignore it).
      useChatStore.setState({ traceId: "not-a-uuid" });
      const replaced = ensureTraceId();
      expect(replaced).toMatch(UUID_SHAPE);
      expect(replaced).not.toBe("not-a-uuid");
      expect(useChatStore.getState().traceId).toBe(replaced);
    });
  });

  describe("rolling history window", () => {
    it("sends only the un-summarized tail and injects sessionNotes as context", async () => {
      useChatStore.setState({
        messages: seedMessages(6),
        summarizedCount: 2,
        sessionNotes: "prior note",
      });
      mockInvoke.mockImplementation(async () => {
        emitStream("answer");
        return turnResult("answer");
      });

      await useChatStore.getState().sendMessage("new question");

      const sent = lastDesignCall()!;
      // Tail = nonSystem.slice(2) of [m0..m5, newUser] → [m2, m3, m4, m5, newUser].
      expect(sent.messages.map(msgText)).toEqual([
        "msg 2",
        "msg 3",
        "msg 4",
        "msg 5",
        "new question",
      ]);
      // The distilled notes are surfaced to the model via the system context.
      expect(systemText(sent)).toContain("prior note");
    });

    it("drops leading non-user messages so the payload starts with a user turn", async () => {
      // Boundary at 1 leaves [a1, u2, a3] before the new user message; the
      // Messages API requires the first message to be from the user.
      useChatStore.setState({ messages: seedMessages(4), summarizedCount: 1 });
      mockInvoke.mockImplementation(async () => {
        emitStream("a");
        return turnResult("a");
      });

      await useChatStore.getState().sendMessage("q");

      const sent = lastDesignCall()!;
      expect(sent.messages[0].role).toBe("user");
      expect(sent.messages.map(msgText)).toEqual(["msg 2", "msg 3", "q"]);
    });

    it("folds the oldest turns into sessionNotes once the tail overflows", async () => {
      useChatStore.setState({ messages: seedMessages(30), summarizedCount: 0 });
      mockInvoke.mockImplementation(async (_cmd: unknown, args: { tools?: unknown[] }) => {
        if (!args.tools) return turnResult("distilled notes"); // fold call (no tools)
        emitStream("answer");
        return turnResult("answer");
      });

      await useChatStore.getState().sendMessage("latest");

      // Fold is fire-and-forget; wait for the boundary to advance.
      await vi.waitFor(() =>
        expect(useChatStore.getState().summarizedCount).toBeGreaterThan(0)
      );
      expect(useChatStore.getState().sessionNotes).toBe("distilled notes");
      const foldCall = mockInvoke.mock.calls.find(
        ([command, args]) =>
          command === "chat_stream_turn" &&
          !(args as { tools?: unknown[] }).tools,
      );
      expect((foldCall?.[1] as { model: string }).model).toBe(
        "anthropic/claude-opus-4.8",
      );
    });

    it("does not desync the boundary when history is cleared mid-fold", async () => {
      useChatStore.setState({ messages: seedMessages(30), summarizedCount: 0 });
      let resolveFold!: (notes: ReturnType<typeof turnResult>) => void;
      mockInvoke.mockImplementation(async (_cmd: unknown, args: { tools?: unknown[] }) => {
        if (!args.tools) {
          return new Promise((res) => {
            resolveFold = res;
          });
        }
        emitStream("answer");
        return turnResult("answer");
      });

      await useChatStore.getState().sendMessage("latest");
      // Fold has started and is awaiting the (controlled) summary call.
      await vi.waitFor(() =>
        expect(
          mockInvoke.mock.calls.some((c) => !(c[1] as { tools?: unknown[] }).tools)
        ).toBe(true)
      );

      // Clear while the fold is in flight, then let it resolve.
      useChatStore.getState().clearHistory();
      resolveFold(turnResult("late notes"));
      await new Promise<void>((r) => setTimeout(r, 0));

      // The guard must drop the stale advance rather than leave
      // summarizedCount > messages (which would send an empty payload).
      expect(useChatStore.getState().summarizedCount).toBe(0);
      expect(useChatStore.getState().messages).toHaveLength(0);
      expect(useChatStore.getState().sessionNotes).toBeNull();

      // The next send still produces a non-empty payload.
      mockInvoke.mockImplementation(async () => {
        emitStream("ok");
        return turnResult("ok");
      });
      await useChatStore.getState().sendMessage("after clear");
      expect(lastDesignCall()!.messages.length).toBeGreaterThan(0);
    });
  });

  describe("adaptive PCB guidance", () => {
    it("injects only the procedures selected for the current request", async () => {
      mockInvoke.mockImplementation(async () => {
        emitStream("answer");
        return turnResult("answer");
      });

      await useChatStore.getState().sendMessage(
        "Fix the broken PCB placement and DRC clearance"
      );

      const context = systemText(lastDesignCall()!);
      expect(context).toContain("## Adapted PCB Guidance");
      expect(context).toContain("### PCB layout");
      expect(context).toContain("### validation repair");
      expect(context).not.toContain("### analog signal chain");
    });
  });

  describe("agentic tool loop", () => {
    it("validates and commits a finalized mutation batch without another model turn", async () => {
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd !== "chat_stream_turn") return "";
        return toolUseTurn([
          {
            id: "s1",
            name: "add_component",
            input: {
              tag: "resistor",
              name: "R1",
              props: { resistance: "10k", footprint: "0402" },
            },
          },
          {
            id: "done1",
            name: "finish_circuit_edit",
            input: { summary: "Added a 10k resistor." },
          },
        ]);
      });

      await useChatStore.getState().sendMessage("Build a resistor divider");

      const turns = mockInvoke.mock.calls.filter(
        (call) => call[0] === "chat_stream_turn",
      );
      expect(turns).toHaveLength(1);
      expect(systemText(turns[0][1] as { system: Array<{ text?: string }> })).toContain(
        "finish_circuit_edit",
      );
      expect(candidateValidationHarness.validate).toHaveBeenCalledTimes(1);
      expect(useCircuitStore.getState().tsxCode).toContain('name="R1"');
      const assistantMessages = useChatStore
        .getState()
        .messages.filter((message) => message.role === "assistant");
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0].content).toBe("Added a 10k resistor.");
      expect(
        assistantMessages[0].events?.filter((event) => event.kind === "text"),
      ).toEqual([{ kind: "text", text: "Added a 10k resistor." }]);
      expect(assistantMessages[0].events?.at(-1)).toEqual({
        kind: "text",
        text: "Added a 10k resistor.",
      });
    });

    it("does not fast-finalize until every mutation in the finishing batch succeeds", async () => {
      let turn = 0;
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd !== "chat_stream_turn") return "";
        if (turn++ === 0) {
          return toolUseTurn([
            {
              id: "add-r1",
              name: "add_component",
              input: {
                tag: "resistor",
                name: "R1",
                props: { resistance: "10k", footprint: "0402" },
              },
            },
            {
              id: "duplicate-r1",
              name: "add_component",
              input: {
                tag: "resistor",
                name: "R1",
                props: { resistance: "20k", footprint: "0402" },
              },
            },
            {
              id: "done-early",
              name: "finish_circuit_edit",
              input: { summary: "Added both resistors." },
            },
          ]);
        }
        return toolUseTurn([
          {
            id: "add-r2",
            name: "add_component",
            input: {
              tag: "resistor",
              name: "R2",
              props: { resistance: "20k", footprint: "0402" },
            },
          },
          {
            id: "done-fixed",
            name: "finish_circuit_edit",
            input: { summary: "Added both resistors." },
          },
        ]);
      });

      await useChatStore.getState().sendMessage("Add R1 and R2");

      const turns = mockInvoke.mock.calls.filter(
        ([command]) => command === "chat_stream_turn",
      );
      expect(turns).toHaveLength(2);
      expect(
        toolResultText(
          (turns[1][1] as { messages: Array<{ role: string; content: unknown }> })
            .messages,
        ),
      ).toMatch(/R1 already exists/i);
      expect(candidateValidationHarness.validate).toHaveBeenCalledTimes(1);
      expect(useCircuitStore.getState().tsxCode).toContain('name="R1"');
      expect(useCircuitStore.getState().tsxCode).toContain('name="R2"');
    });

    it("does not overwrite a live circuit change made while the draft validates", async () => {
      const liveTsx = `export default () => (
  <board width="60mm" height="60mm">
    <capacitor name="LIVE" capacitance="1uF" footprint="0402" />
  </board>
)`;
      candidateValidationHarness.validate.mockImplementation(
        async ({ candidateTsx }: { candidateTsx: string }) => {
          useCircuitStore.getState().setTsxCode(liveTsx);
          return {
            ok: true,
            candidateTsx,
            circuitJson: VALIDATED_CIRCUIT_JSON,
            issues: [],
            newErrors: [],
            newWarnings: [],
            durationMs: 1,
          };
        },
      );
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd !== "chat_stream_turn") return "";
        return toolUseTurn([
          {
            id: "add-r1",
            name: "add_component",
            input: {
              tag: "resistor",
              name: "R1",
              props: { resistance: "10k", footprint: "0402" },
            },
          },
          {
            id: "finish",
            name: "finish_circuit_edit",
            input: { summary: "Added R1." },
          },
        ]);
      });

      await useChatStore.getState().sendMessage("Add R1");

      const live = useCircuitStore.getState().tsxCode;
      expect(live).toContain('name="LIVE"');
      expect(live).not.toContain('name="R1"');
      expect(useChatStore.getState().error).toMatch(/changed while.*working/i);
      expect(
        useChatStore.getState().messages.filter((message) => message.role === "assistant"),
      ).toHaveLength(0);
    });

    it("continues an explicit build after the model stops at a prose plan", async () => {
      let turn = 0;
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd !== "chat_stream_turn") return "";
        const current = turn++;
        if (current === 0) {
          emitStream("Plan: add the divider, wire it, then validate it.");
          return turnResult("Plan: add the divider, wire it, then validate it.");
        }
        if (current === 1) {
          return toolUseTurn([
            {
              id: "s1",
              name: "add_component",
              input: {
                tag: "resistor",
                name: "R1",
                props: { resistance: "10k", footprint: "0402" },
              },
            },
          ]);
        }
        emitStream("Built the divider.");
        return turnResult("Built the divider.");
      });

      await useChatStore.getState().sendMessage("Build a resistor divider");

      const turns = mockInvoke.mock.calls.filter(
        (call) => call[0] === "chat_stream_turn"
      );
      expect(turns).toHaveLength(3);
      expect((turns[0][1] as { toolChoice?: string }).toolChoice).toBe("required");
      expect((turns[1][1] as { toolChoice?: string }).toolChoice).toBe("required");
      expect(useCircuitStore.getState().tsxCode).toContain('name="R1"');
    });

    it("researches and imports the 555 before applying a blinker draft", async () => {
      const genericCandidate = `export default () => (
  <board width="50mm" height="50mm">
    <chip name="U1" footprint="dip8" pinLabels={{ pin1: "GND", pin2: "TRIG", pin3: "OUT", pin4: "RESET", pin5: "CTRL", pin6: "THRES", pin7: "DISCH", pin8: "VCC" }} />
  </board>
)`;
      const importedCandidate = `export default () => (
  <board width="50mm" height="50mm">
    <NE555DR name="U1" />
  </board>
)`;
      mockFetchDef.mockResolvedValue({
        componentName: "NE555DR",
        lcscId: "C7593",
        rawTsx:
          'export const NE555DR = (props: any) => (<chip {...props} footprint="soic8" />)',
      });
      let turn = 0;
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "search_jlcpcb") return "Found 1 result(s) for NE555: C7593 | NE555DR";
        if (cmd === "fetch_datasheet") return "Datasheet summary for C7593 (NE555DR)";
        if (cmd === "lookup_footprint") {
          return 'Best match: C7593 (NE555DR). Raw package: "SOIC-8". Canonical footprint: soic8';
        }
        if (cmd !== "chat_stream_turn") return "";
        const current = turn++;
        if (current === 0) {
          return toolUseTurn([
            { id: "w1", name: "write_tsx", input: { tsx: genericCandidate } },
            {
              id: "done1",
              name: "finish_circuit_edit",
              input: { summary: "Built the 555 blinker." },
            },
          ]);
        }
        if (current === 1) {
          return toolUseTurn([
            { id: "r1", name: "search_jlcpcb", input: { query: "NE555" } },
            { id: "r2", name: "fetch_datasheet", input: { lcsc_id: "C7593", mpn: "NE555DR" } },
            { id: "r3", name: "lookup_footprint", input: { lcsc_id: "C7593", mpn: "NE555DR" } },
            { id: "r4", name: "import_component", input: { lcsc_id: "C7593" } },
          ]);
        }
        if (current === 2) {
          return toolUseTurn([
            { id: "w2", name: "write_tsx", input: { tsx: importedCandidate } },
            {
              id: "done2",
              name: "finish_circuit_edit",
              input: {
                summary: "Research complete and the imported 555 blinker is built.",
              },
            },
          ]);
        }
        throw new Error("Unexpected extra design-model turn");
      });

      await useChatStore.getState().sendMessage("Design a 555 timer led blinker");

      expect(mockInvoke).toHaveBeenCalledWith("search_jlcpcb", expect.anything());
      expect(mockInvoke).toHaveBeenCalledWith("fetch_datasheet", expect.anything());
      expect(mockInvoke).toHaveBeenCalledWith("lookup_footprint", expect.anything());
      expect(mockFetchDef).toHaveBeenCalledWith("C7593");
      expect(
        mockInvoke.mock.calls.filter(([command]) => command === "chat_stream_turn"),
      ).toHaveLength(3);
      expect(useCircuitStore.getState().tsxCode).toContain("const NE555DR");
      expect(useCircuitStore.getState().tsxCode).toMatch(
        /<NE555DR\b[^>]*\bname="U1"/
      );
    });

    it("does not let one part's research chain authorize an unrelated IC", async () => {
      const original = useCircuitStore.getState().tsxCode;
      const candidate = `export default () => (
  <board width="50mm" height="50mm">
    <ICONE name="U1" />
    <ICTWO name="U2" />
  </board>
)`;
      mockFetchDef.mockResolvedValue({
        componentName: "ICONE",
        lcscId: "C111",
        rawTsx:
          'export const ICONE = (props: any) => (<chip {...props} footprint="soic8" />)',
      });
      let turn = 0;
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "search_jlcpcb") return "Found 1 result(s): C111 | ICONE";
        if (cmd === "fetch_datasheet") {
          return "Datasheet summary for C111 (ICONE):\nEvidence:\n- pinout: verified";
        }
        if (cmd === "lookup_footprint") return "Best match: C111 (ICONE)";
        if (cmd !== "chat_stream_turn") return "";
        const current = turn++;
        if (current === 0) {
          return toolUseTurn([
            { id: "search", name: "search_jlcpcb", input: { query: "ICONE" } },
            { id: "sheet", name: "fetch_datasheet", input: { lcsc_id: "C111" } },
            { id: "foot", name: "lookup_footprint", input: { lcsc_id: "C111" } },
            { id: "import", name: "import_component", input: { lcsc_id: "C111" } },
          ]);
        }
        if (current === 1) {
          return toolUseTurn([
            { id: "write", name: "write_tsx", input: { tsx: candidate } },
            {
              id: "finish",
              name: "finish_circuit_edit",
              input: { summary: "Added both ICs." },
            },
          ]);
        }
        return turnResult("Done.");
      });

      await useChatStore.getState().sendMessage("Add ICONE and ICTWO");

      expect(useCircuitStore.getState().tsxCode).toBe(original);
      expect(useChatStore.getState().error).toMatch(/component research/i);
      expect(candidateValidationHarness.validate).not.toHaveBeenCalled();
      const turns = mockInvoke.mock.calls.filter(
        ([command]) => command === "chat_stream_turn",
      );
      expect(
        (turns.at(-1)?.[1] as { messages: Array<{ content: unknown }> }).messages
          .some(
            (message) =>
              typeof message.content === "string" &&
              message.content.includes("U2 (ICTWO)"),
          ),
      ).toBe(true);
    });

    it("allows an explicitly unverified datasheet fallback after the lookup completes", async () => {
      const candidate = `export default () => (
  <board width="50mm" height="50mm">
    <ICONE name="U1" />
  </board>
)`;
      mockFetchDef.mockResolvedValue({
        componentName: "ICONE",
        lcscId: "C111",
        rawTsx:
          'export const ICONE = (props: any) => (<chip {...props} footprint="soic8" />)',
      });
      let turn = 0;
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "search_jlcpcb") return "Found 1 result(s): C111 | ICONE";
        if (cmd === "fetch_datasheet") {
          return (
            "Datasheet summary for C111 (ICONE):\n" +
            "Evidence: unavailable; do not treat unspecified limits as verified."
          );
        }
        if (cmd === "lookup_footprint") return "Best match: C111 (ICONE)";
        if (cmd !== "chat_stream_turn") return "";
        const current = turn++;
        if (current === 0) {
          return toolUseTurn([
            { id: "search", name: "search_jlcpcb", input: { query: "ICONE" } },
            { id: "sheet", name: "fetch_datasheet", input: { lcsc_id: "C111" } },
            { id: "foot", name: "lookup_footprint", input: { lcsc_id: "C111" } },
            { id: "import", name: "import_component", input: { lcsc_id: "C111" } },
          ]);
        }
        if (current === 1) {
          return toolUseTurn([
            { id: "write", name: "write_tsx", input: { tsx: candidate } },
            {
              id: "finish",
              name: "finish_circuit_edit",
              input: { summary: "Added ICONE." },
            },
          ]);
        }
        return turnResult("Done.");
      });

      await useChatStore.getState().sendMessage("Add ICONE");

      expect(candidateValidationHarness.validate).toHaveBeenCalledTimes(1);
      expect(useCircuitStore.getState().tsxCode).toContain("<ICONE");
      expect(useChatStore.getState().error).toBeNull();
      expect(
        useChatStore
          .getState()
          .messages.find((message) => message.role === "assistant")
          ?.toolTranscript?.some(
            (message) =>
              message.role === "tool" &&
              typeof message.content === "string" &&
              message.content.includes("Evidence: unavailable"),
          ),
      ).toBe(true);
    });

    it("runs a tool call, feeds the result back, then finishes", async () => {
      let turn = 0;
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "search_jlcpcb") return "C1 | TP4056 | charger";
        // chat_stream_turn: first function call, then a plain answer.
        if (turn++ === 0) {
          return toolUseTurn([
            { id: "t1", name: "search_jlcpcb", input: { query: "TP4056" } },
          ]);
        }
        emitStream("Here you go.");
        return turnResult("Here you go.");
      });

      await useChatStore.getState().sendMessage("find a charger");

      // The tool backend was invoked with the model's query.
      expect(
        mockInvoke.mock.calls.some(
          (c) => c[0] === "search_jlcpcb" && (c[1] as { query?: string }).query === "TP4056"
        )
      ).toBe(true);

      // The next turn carried the OpenRouter tool message back to the model.
      const turnCalls = mockInvoke.mock.calls.filter((c) => c[0] === "chat_stream_turn");
      const lastMessages = (turnCalls.at(-1)![1] as {
        messages: Array<{ role: string; content: unknown; tool_call_id?: string }>;
      }).messages;
      const hasToolResult = lastMessages.some(
        (message) =>
          message.role === "tool" &&
          message.tool_call_id === "t1" &&
          message.content === "C1 | TP4056 | charger"
      );
      expect(hasToolResult).toBe(true);

      // The assistant trail shows the search activity row.
      const assistant = useChatStore.getState().messages.find((m) => m.role === "assistant");
      expect(
        assistant?.events?.some(
          (e) => e.kind === "activity" && e.activity.kind === "search"
        )
      ).toBe(true);
    });

    it("persists the tool transcript and replays it to the model on later turns", async () => {
      let turn = 0;
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "search_jlcpcb") return "C1 | TP4056 | charger";
        if (turn++ === 0) {
          return toolUseTurn([
            { id: "t1", name: "search_jlcpcb", input: { query: "TP4056" } },
          ]);
        }
        emitStream("answer");
        return turnResult("answer");
      });

      await useChatStore.getState().sendMessage("find a charger");

      // The turn's tool rounds are persisted on the assistant message.
      const assistant = useChatStore
        .getState()
        .messages.find((m) => m.role === "assistant");
      expect(assistant?.toolTranscript).toEqual([
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "t1",
              type: "function",
              function: {
                name: "search_jlcpcb",
                arguments: JSON.stringify({ query: "TP4056" }),
              },
            },
          ],
        },
        { role: "tool", tool_call_id: "t1", content: "C1 | TP4056 | charger" },
      ]);

      // A later turn replays those rounds ahead of the persisted answer text,
      // so the model still sees its own past tool calls and their results.
      await useChatStore.getState().sendMessage("now add it to the board");

      const call = lastDesignCall()!;
      const roles = call.messages.map((m) => m.role);
      const toolIdx = roles.indexOf("tool");
      expect(toolIdx).toBeGreaterThan(0);
      expect(roles[toolIdx - 1]).toBe("assistant"); // the tool_calls turn
      expect(
        (call.messages[toolIdx - 1] as { tool_calls?: Array<{ id: string }> })
          .tool_calls?.[0]?.id
      ).toBe("t1");
      expect(call.messages[toolIdx].content).toBe("C1 | TP4056 | charger");
      // The final answer text follows the replayed rounds. (Skip the replayed
      // tool_calls turn — its content is null, which msgText can't read.)
      const answerIdx = call.messages.findIndex(
        (m) => m.content != null && msgText(m) === "answer"
      );
      expect(answerIdx).toBeGreaterThan(toolIdx);
    });

    it("strips reasoning from the persisted transcript but not the live loop", async () => {
      const reasoningDetails = [
        { type: "reasoning.encrypted", data: "opaque", id: "r1", index: 0 },
      ];
      let turn = 0;
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "search_jlcpcb") return "result";
        if (turn++ === 0) {
          return {
            text: "",
            toolCalls: [
              { id: "t1", name: "search_jlcpcb", input: { query: "part" } },
            ],
            reasoning: { text: "", details: reasoningDetails },
            finishReason: "tool_calls",
          };
        }
        emitStream("done");
        return turnResult("done");
      });

      await useChatStore.getState().sendMessage("find a part");

      const assistant = useChatStore
        .getState()
        .messages.find((m) => m.role === "assistant");
      const persisted = assistant?.toolTranscript?.find(
        (m) => m.role === "assistant"
      );
      expect(persisted?.tool_calls?.[0]?.id).toBe("t1");
      expect(persisted?.reasoning_details).toBeUndefined();
      expect(persisted?.reasoning).toBeUndefined();
    });

    it("does not duplicate a tool round's streamed text in the transcript", async () => {
      let turn = 0;
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "search_jlcpcb") return "result";
        if (turn++ === 0) {
          emitStream("Let me check. ");
          return {
            text: "Let me check. ",
            toolCalls: [
              { id: "t1", name: "search_jlcpcb", input: { query: "part" } },
            ],
            reasoning: { text: "", details: [] },
            finishReason: "tool_calls",
          };
        }
        emitStream("Done.");
        return turnResult("Done.");
      });

      await useChatStore.getState().sendMessage("find a part");

      const assistant = useChatStore
        .getState()
        .messages.find((m) => m.role === "assistant");
      // The streamed text lives once, in the final content…
      expect(assistant?.content).toBe("Let me check. Done.");
      // …so the transcript's tool_calls entry must not carry it again.
      const toolCallEntry = assistant?.toolTranscript?.find(
        (m) => m.role === "assistant"
      );
      expect(toolCallEntry?.tool_calls?.[0]?.id).toBe("t1");
      expect(toolCallEntry?.content).toBeNull();
    });

    it("drops a reasoning-only nudge turn from the transcript instead of persisting an empty assistant message", async () => {
      let turn = 0;
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd !== "chat_stream_turn") return "unused";
        if (turn++ === 0) {
          // Reasoning-only stop: no text, no tool calls → triggers the nudge,
          // which pushes this turn (reasoning and all) plus the recovery prompt.
          return {
            text: "",
            toolCalls: [],
            reasoning: {
              text: "",
              details: [{ type: "reasoning.encrypted", data: "opaque" }],
            },
            finishReason: "stop",
          };
        }
        emitStream("recovered");
        return turnResult("recovered");
      });

      await useChatStore.getState().sendMessage("do something");

      const assistant = useChatStore
        .getState()
        .messages.find((m) => m.role === "assistant");
      expect(assistant?.content).toBe("recovered");
      // Stripped of its reasoning the nudged turn is empty — it must be dropped,
      // leaving only the recovery prompt; replaying `content: null` would 400.
      expect(
        assistant?.toolTranscript?.some((m) => m.role === "assistant")
      ).toBe(false);
      expect(assistant?.toolTranscript).toHaveLength(1);
      expect(assistant?.toolTranscript?.[0]?.role).toBe("user");
    });

    it("dispatches parallel catalog tools and returns one OpenRouter result per call", async () => {
      let turn = 0;
      mockInvoke.mockImplementation(async (command: string) => {
        if (command === "search_jlcpcb") return "search result";
        if (command === "lookup_footprint") return "footprint result";
        if (command === "fetch_datasheet") return "datasheet result";
        if (turn++ === 0) {
          return toolUseTurn([
            {
              id: "search-1",
              name: "search_jlcpcb",
              input: { query: "TP4056", limit: 3 },
            },
            {
              id: "footprint-1",
              name: "lookup_footprint",
              input: { lcsc_id: "C16581" },
            },
            {
              id: "datasheet-1",
              name: "fetch_datasheet",
              input: { lcsc_id: "C16581", mpn: "TP4056" },
            },
          ]);
        }
        emitStream("done");
        return turnResult("done");
      });

      await useChatStore.getState().sendMessage("research a charger");

      expect(mockInvoke).toHaveBeenCalledWith("search_jlcpcb", {
        query: "TP4056",
        limit: 3,
      });
      expect(mockInvoke).toHaveBeenCalledWith("lookup_footprint", {
        lcscId: "C16581",
        mpn: undefined,
      });
      expect(mockInvoke).toHaveBeenCalledWith("fetch_datasheet", {
        auth: {
          token: "workos-token",
          url: "https://www.trycherryblossom.com/api/v1/chat/completions",
        },
        model: "anthropic/claude-opus-4.8",
        lcscId: "C16581",
        mpn: "TP4056",
        traceId: useChatStore.getState().traceId,
      });

      const turnCalls = mockInvoke.mock.calls.filter(
        ([command]) => command === "chat_stream_turn"
      );
      for (const [, args] of turnCalls) {
        expect(
          (args as {
            tools: Array<{ function: { name: string } }>;
          }).tools.map((tool) => tool.function.name)
        ).toEqual([
          "edit_tsx",
          "write_tsx",
          "search_jlcpcb",
          "import_component",
          "lookup_footprint",
          "fetch_datasheet",
          "finish_circuit_edit",
        ]);
      }
      const messages = (turnCalls.at(-1)![1] as {
        messages: Array<{
          role: string;
          content: unknown;
          tool_call_id?: string;
          tool_calls?: unknown[];
        }>;
      }).messages;
      expect(messages.find((message) => message.role === "assistant")?.tool_calls)
        .toHaveLength(3);
      expect(
        messages
          .filter((message) => message.role === "tool")
          .map((message) => [message.tool_call_id, message.content])
      ).toEqual([
        ["search-1", "search result"],
        ["footprint-1", "footprint result"],
        ["datasheet-1", "datasheet result"],
      ]);
    });

    it("uses Haiku for datasheet extraction when the plan allows it", async () => {
      setManagedAccount("anthropic/claude-opus-4.8", [
        "anthropic/claude-opus-4.8",
        PREFERRED_HELPER_MODEL,
      ]);
      let turn = 0;
      mockInvoke.mockImplementation(async (command: string) => {
        if (command === "fetch_datasheet") return "datasheet result";
        if (turn++ === 0) {
          return toolUseTurn([
            {
              id: "datasheet-1",
              name: "fetch_datasheet",
              input: { lcsc_id: "C16581" },
            },
          ]);
        }
        emitStream("done");
        return turnResult("done");
      });

      await useChatStore.getState().sendMessage("research a charger");

      expect(mockInvoke).toHaveBeenCalledWith(
        "fetch_datasheet",
        expect.objectContaining({ model: PREFERRED_HELPER_MODEL }),
      );
    });

    it("replays OpenRouter reasoning details unchanged with assistant tool calls", async () => {
      const reasoningDetails = [
        {
          type: "reasoning.encrypted",
          data: "opaque-provider-payload",
          id: "reasoning-1",
          format: "anthropic-claude-v1",
          index: 0,
        },
      ];
      let turn = 0;
      mockInvoke.mockImplementation(async (command: string) => {
        if (command === "search_jlcpcb") return "result";
        if (turn++ === 0) {
          return {
            text: "",
            toolCalls: [
              { id: "call-1", name: "search_jlcpcb", input: { query: "part" } },
            ],
            reasoning: { text: "", details: reasoningDetails },
            finishReason: "tool_calls",
          };
        }
        emitStream("done");
        return turnResult("done");
      });

      await useChatStore.getState().sendMessage("find a part");

      const turnCalls = mockInvoke.mock.calls.filter(
        ([command]) => command === "chat_stream_turn"
      );
      const messages = (turnCalls.at(-1)![1] as {
        messages: Array<{ role: string; reasoning_details?: unknown[] }>;
      }).messages;
      expect(
        messages.find((message) => message.role === "assistant")
          ?.reasoning_details
      ).toBe(reasoningDetails);
    });

    it("resolves import_component inline and prepends the real definition", async () => {
      // Seed a known circuit so the model's edit_tsx old_string matches the live TSX.
      useCircuitStore.getState().setTsxCode(
        `export default () => (\n  <board width="50mm" height="50mm">\n    <resistor name="R1" resistance="10k" footprint="0402" key="r1_aaa111" />\n  </board>\n)`
      );
      mockFetchDef.mockResolvedValue({
        componentName: "TP4056",
        lcscId: "C16581",
        rawTsx:
          'export const TP4056 = (props: any) => (<chip {...props} footprint="soic8" />)',
      });
      let turn = 0;
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "search_jlcpcb") return "Found 1 result(s) for TP4056: C16581";
        if (cmd === "fetch_datasheet") return "Datasheet summary for C16581 (TP4056)";
        if (cmd === "lookup_footprint") {
          return 'Best match: C16581 (TP4056). Raw package: "SOIC-8". Canonical footprint: soic8';
        }
        if (cmd !== "chat_stream_turn") return "";
        const t = turn++;
        if (t === 0) {
          return toolUseTurn([
            { id: "s1", name: "search_jlcpcb", input: { query: "TP4056" } },
          ]);
        }
        if (t === 1) {
          return toolUseTurn([
            { id: "d1", name: "fetch_datasheet", input: { lcsc_id: "C16581", mpn: "TP4056" } },
          ]);
        }
        if (t === 2) {
          return toolUseTurn([
            { id: "f1", name: "lookup_footprint", input: { lcsc_id: "C16581", mpn: "TP4056" } },
          ]);
        }
        if (t === 3) {
          return toolUseTurn([
            { id: "i1", name: "import_component", input: { lcsc_id: "C16581" } },
          ]);
        }
        if (t === 4) {
          // The model places the imported part with edit_tsx — its definition
          // block is prepended automatically.
          return toolUseTurn([
            {
              id: "e1",
              name: "edit_tsx",
              input: {
                old_string:
                  '<resistor name="R1" resistance="10k" footprint="0402" key="r1_aaa111" />',
                new_string:
                  '<resistor name="R1" resistance="10k" footprint="0402" key="r1_aaa111" />\n    <TP4056 name="U1" />',
              },
            },
          ]);
        }
        emitStream("Added the TP4056.");
        return turnResult("Added the TP4056.");
      });

      await useChatStore.getState().sendMessage("add a TP4056");

      // The real component name was handed back to the model, not a guess.
      expect(mockFetchDef).toHaveBeenCalledWith("C16581");
      const turnCalls = mockInvoke.mock.calls.filter((c) => c[0] === "chat_stream_turn");
      const lastMessages = (turnCalls.at(-1)![1] as {
        messages: Array<{ role: string; content: unknown }>;
      }).messages;
      expect(toolResultText(lastMessages)).toContain("<TP4056");

      // The applied circuit carries the prepended definition (no cryptic eval miss).
      const tsx = useCircuitStore.getState().tsxCode;
      expect(tsx).toContain("const TP4056");
      expect(tsx).toContain("<TP4056");

      // Drive the started validation cycle to completion so it doesn't linger.
      useCircuitStore.setState({ circuitJson: [], evalInputHash: null });
      await vi.waitFor(() =>
        expect(useCircuitStore.getState().isValidating).toBe(false)
      );
    });

    it("applies an edit_tsx string-replace to the working circuit", async () => {
      // Seed a known circuit so the model's old_string matches the live TSX.
      useCircuitStore.getState().setTsxCode(
        `export default () => (\n  <board width="50mm" height="50mm">\n    <resistor name="R1" resistance="10k" footprint="0402" key="r1_aaa111" />\n  </board>\n)`
      );

      let turn = 0;
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd !== "chat_stream_turn") return "";
        if (turn++ === 0) {
          return toolUseTurn([
            {
              id: "e1",
              name: "edit_tsx",
              input: { old_string: 'resistance="10k"', new_string: 'resistance="4.7k"' },
            },
          ]);
        }
        emitStream("Changed R1 to 4.7k.");
        return turnResult("Changed R1 to 4.7k.");
      });

      await useChatStore.getState().sendMessage("make R1 4.7k");

      // No full ```tsx block was emitted — the working copy was committed.
      const tsx = useCircuitStore.getState().tsxCode;
      expect(tsx).toContain('resistance="4.7k"');
      expect(tsx).not.toContain('resistance="10k"');
      expect(useCircuitStore.getState().circuitJson).toEqual(
        VALIDATED_CIRCUIT_JSON
      );

      // The assistant trail carries an edit activity with the exact old/new
      // strings (no inline detail) — this is what the expandable UI renders.
      const assistant = useChatStore.getState().messages.find((m) => m.role === "assistant");
      const editEvent = assistant?.events?.find(
        (e) => e.kind === "activity" && e.activity.kind === "edit"
      );
      expect(editEvent).toBeDefined();
      if (editEvent && editEvent.kind === "activity") {
        expect(editEvent.activity.detail).toBe("");
        expect(editEvent.activity.edit).toEqual({
          oldString: 'resistance="10k"',
          newString: 'resistance="4.7k"',
          replaceAll: false,
        });
      }

      // The successful pre-commit result is authoritative. Applying the exact
      // validated candidate must not start a second render-bound validation.
      expect(useCircuitStore.getState().isValidating).toBe(false);
      expect(
        useChatStore
          .getState()
          .messages.find((message) => message.role === "system")?.content
      ).toBe("__ok__");
    });

    it("summarizes candidate warnings without waiting for a background render", async () => {
      useCircuitStore.getState().setTsxCode(
        `export default () => (\n  <board width="50mm" height="50mm">\n    <resistor name="R1" resistance="10k" footprint="0402" key="r1_aaa111" />\n  </board>\n)`
      );
      const warning = {
        id: "candidate-warning",
        type: "test_warning",
        message: "Candidate warning",
        severity: "warning" as const,
      };
      candidateValidationHarness.validate.mockImplementation(
        async ({ candidateTsx }: { candidateTsx: string }) => ({
          ok: true,
          candidateTsx,
          issues: [warning],
          newErrors: [],
          newWarnings: [warning],
          durationMs: 1,
        })
      );

      let turn = 0;
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd !== "chat_stream_turn") return "";
        if (turn++ === 0) {
          return toolUseTurn([
            {
              id: "e1",
              name: "edit_tsx",
              input: {
                old_string: 'resistance="10k"',
                new_string: 'resistance="4.7k"',
              },
            },
          ]);
        }
        emitStream("Changed R1 to 4.7k.");
        return turnResult("Changed R1 to 4.7k.");
      });

      await useChatStore.getState().sendMessage("make R1 4.7k");

      expect(useCircuitStore.getState().isValidating).toBe(false);
      expect(
        useChatStore
          .getState()
          .messages.find((message) => message.role === "system")?.content
      ).toBe("__issues__:0:1");
    });

    it("applies semantic component and connectivity tools to the draft", async () => {
      useCircuitStore.getState().setTsxCode(
        `export default () => (\n  <board width="50mm" height="50mm">\n    <resistor name="R1" resistance="10k" footprint="0402" key="r1_aaa111" />\n  </board>\n)`
      );

      let turn = 0;
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd !== "chat_stream_turn") return "";
        const current = turn++;
        if (current === 0) {
          return toolUseTurn([
            {
              id: "s1",
              name: "add_component",
              input: {
                tag: "capacitor",
                name: "C1",
                props: { capacitance: "100nF", footprint: "0402" },
              },
            },
          ]);
        }
        if (current === 1) {
          return toolUseTurn([
            {
              id: "s2",
              name: "connect_pins",
              input: { owner: "C1", pin: "pin1", target: "net.VCC" },
            },
          ]);
        }
        emitStream("Added the decoupling capacitor.");
        return turnResult("Added the decoupling capacitor.");
      });

      await useChatStore.getState().sendMessage("add a decoupling capacitor");

      const tsx = useCircuitStore.getState().tsxCode;
      expect(tsx).toContain('name="C1"');
      expect(tsx).toMatch(/<capacitor\s+key="c_[a-z0-9]{6}"/);
      expect(tsx).toContain('pin1: "net.VCC"');
      const assistant = useChatStore.getState().messages.find(
        (message) => message.role === "assistant"
      );
      expect(
        assistant?.events?.filter(
          (event) => event.kind === "activity" && event.activity.kind === "semantic"
        )
      ).toHaveLength(2);

      useCircuitStore.setState({ circuitJson: [], evalInputHash: null });
      await vi.waitFor(() =>
        expect(useCircuitStore.getState().isValidating).toBe(false)
      );
    });

    it("repairs a rejected draft before committing it", async () => {
      useCircuitStore.getState().setTsxCode(
        `export default () => (\n  <board width="50mm" height="50mm">\n    <resistor name="R1" resistance="10k" footprint="0402" key="r1_aaa111" />\n  </board>\n)`
      );
      let validation = 0;
      candidateValidationHarness.validate.mockImplementation(
        async ({ candidateTsx }: { candidateTsx: string }) => {
          if (validation++ === 0) {
            return {
              ok: false,
              candidateTsx,
              issues: [],
              newErrors: [
                {
                  id: "bad-value",
                  type: "test_error",
                  message: "R1 is still invalid",
                  severity: "error",
                },
              ],
              newWarnings: [],
              durationMs: 1,
            };
          }
          return {
            ok: true,
            candidateTsx,
            issues: [],
            newErrors: [],
            newWarnings: [],
            durationMs: 1,
          };
        },
      );

      let turn = 0;
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd !== "chat_stream_turn") return "";
        const current = turn++;
        if (current === 0) {
          return toolUseTurn([
            {
              id: "e1",
              name: "edit_tsx",
              input: {
                old_string: 'resistance="10k"',
                new_string: 'resistance="4.7k"',
              },
            },
          ]);
        }
        if (current === 1) {
          emitStream("Initial draft complete.");
          return turnResult("Initial draft complete.");
        }
        if (current === 2) {
          return toolUseTurn([
            {
              id: "e2",
              name: "edit_tsx",
              input: {
                old_string: 'resistance="4.7k"',
                new_string: 'resistance="1k"',
              },
            },
          ]);
        }
        emitStream(" Repaired.");
        return turnResult("Repaired.");
      });

      await useChatStore.getState().sendMessage("set R1 correctly");

      expect(candidateValidationHarness.validate).toHaveBeenCalledTimes(2);
      expect(useCircuitStore.getState().tsxCode).toContain('resistance="1k"');
      const designCalls = mockInvoke.mock.calls.filter(
        (call) => call[0] === "chat_stream_turn",
      );
      expect(
        (designCalls.at(-2)?.[1] as { messages: Array<{ content: unknown }> })
          .messages.some(
            (message) =>
              typeof message.content === "string" &&
              message.content.includes("VALIDATION_REPAIR"),
          ),
      ).toBe(true);

      useCircuitStore.setState({ circuitJson: [], evalInputHash: null });
      await vi.waitFor(() =>
        expect(useCircuitStore.getState().isValidating).toBe(false)
      );
    });

    it("keeps a renderable DRC-imperfect draft after repair attempts are exhausted", async () => {
      useCircuitStore.getState().setTsxCode(
        `export default () => (\n  <board width="50mm" height="50mm">\n    <resistor name="R1" resistance="10k" footprint="0402" key="r1_aaa111" />\n  </board>\n)`,
      );
      const drcError = {
        id: "trace-clearance",
        type: "pcb_pad_trace_clearance_error",
        message: "Trace is too close to a pad",
        severity: "error" as const,
      };
      candidateValidationHarness.validate.mockImplementation(
        async ({ candidateTsx }: { candidateTsx: string }) => ({
          ok: false,
          candidateTsx,
          circuitJson: VALIDATED_CIRCUIT_JSON,
          issues: [drcError],
          newErrors: [drcError],
          newWarnings: [],
          durationMs: 1,
        }),
      );

      const edits = [
        ['resistance="10k"', 'resistance="4.7k"'],
        ['resistance="4.7k"', 'resistance="3.3k"'],
        ['resistance="3.3k"', 'resistance="2.2k"'],
      ] as const;
      let turn = 0;
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd !== "chat_stream_turn") return "";
        const edit = edits[turn];
        if (!edit) throw new Error("Unexpected extra repair turn");
        const [oldString, newString] = edit;
        turn += 1;
        return toolUseTurn([
          {
            id: `edit-${turn}`,
            name: "edit_tsx",
            input: { old_string: oldString, new_string: newString },
          },
          {
            id: `finish-${turn}`,
            name: "finish_circuit_edit",
            input: { summary: `Set R1 to ${newString.match(/"([^"]+)"/)?.[1]}.` },
          },
        ]);
      });

      await useChatStore.getState().sendMessage("Set R1 to a valid value");

      expect(candidateValidationHarness.validate).toHaveBeenCalledTimes(3);
      expect(useCircuitStore.getState().tsxCode).toContain('resistance="2.2k"');
      expect(useCircuitStore.getState().circuitJson).toEqual(
        VALIDATED_CIRCUIT_JSON,
      );
      expect(
        useChatStore
          .getState()
          .messages.find((message) => message.role === "system")?.content,
      ).toBe("__issues__:1:0");
      const assistant = useChatStore
        .getState()
        .messages.find((message) => message.role === "assistant");
      expect(assistant?.events?.at(-1)).toEqual({
        kind: "text",
        text: "Set R1 to 2.2k.",
      });
    });

    it("fails closed after two unsuccessful candidate repairs", async () => {
      const original =
        `export default () => (\n  <board width="50mm" height="50mm">\n    <resistor name="R1" resistance="10k" footprint="0402" key="r1_aaa111" />\n  </board>\n)`;
      useCircuitStore.getState().setTsxCode(original);
      candidateValidationHarness.validate.mockImplementation(
        async ({ candidateTsx }: { candidateTsx: string }) => ({
          ok: false,
          candidateTsx,
          issues: [],
          newErrors: [
            {
              id: "still-broken",
              type: "test_error",
              message: "Still broken",
              severity: "error",
            },
          ],
          newWarnings: [],
          durationMs: 1,
        }),
      );

      let turn = 0;
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd !== "chat_stream_turn") return "";
        if (turn++ === 0) {
          return toolUseTurn([
            {
              id: "e1",
              name: "edit_tsx",
              input: {
                old_string: 'resistance="10k"',
                new_string: 'resistance="bad"',
              },
            },
          ]);
        }
        emitStream("Done.");
        return turnResult("Done.");
      });

      await useChatStore.getState().sendMessage("break R1");

      expect(candidateValidationHarness.validate).toHaveBeenCalledTimes(3);
      expect(useCircuitStore.getState().tsxCode).toContain('resistance="10k"');
      expect(useCircuitStore.getState().tsxCode).not.toContain('resistance="bad"');
      expect(useChatStore.getState().error).toMatch(/nothing was applied/i);
    });

    it("write_tsx builds a circuit from an empty (deleted) TSX", async () => {
      // The bug this fixes: the user cleared the whole circuit, so there's no
      // string for edit_tsx to anchor an old_string onto. write_tsx overwrites
      // the entire circuit wholesale.
      useCircuitStore.getState().setTsxCode("");

      const fresh =
        `export default () => (\n  <board width="50mm" height="50mm">\n    <resistor name="R1" resistance="1k" footprint="0402" key="r1_new111" />\n  </board>\n)`;

      let turn = 0;
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd !== "chat_stream_turn") return "";
        if (turn++ === 0) {
          return toolUseTurn([
            { id: "w1", name: "write_tsx", input: { tsx: fresh } },
          ]);
        }
        emitStream("Built a 1k resistor board.");
        return turnResult("Built a 1k resistor board.");
      });

      await useChatStore.getState().sendMessage("add a 1k resistor");

      // The whole new circuit was committed even though there was nothing to edit.
      const tsx = useCircuitStore.getState().tsxCode;
      expect(tsx).toContain('name="R1"');
      expect(tsx).toContain('resistance="1k"');

      // The trail carries a `write` activity with the full written TSX (no inline
      // detail) — this is what the expandable UI renders.
      const assistant = useChatStore.getState().messages.find((m) => m.role === "assistant");
      const writeEvent = assistant?.events?.find(
        (e) => e.kind === "activity" && e.activity.kind === "write"
      );
      expect(writeEvent).toBeDefined();
      if (writeEvent && writeEvent.kind === "activity") {
        expect(writeEvent.activity.detail).toBe("");
        expect(writeEvent.activity.write).toEqual({ tsx: fresh });
      }

      useCircuitStore.setState({ circuitJson: [], evalInputHash: null });
      await vi.waitFor(() =>
        expect(useCircuitStore.getState().isValidating).toBe(false)
      );
    });

    it("feeds an empty write_tsx back so the model can retry", async () => {
      useCircuitStore.getState().setTsxCode("");
      let turn = 0;
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd !== "chat_stream_turn") return "";
        if (turn++ === 0) {
          return toolUseTurn([
            { id: "w1", name: "write_tsx", input: { tsx: "   " } },
          ]);
        }
        emitStream("Sorry, retrying.");
        return turnResult("Sorry, retrying.");
      });

      await useChatStore.getState().sendMessage("build something");

      const turnCalls = mockInvoke.mock.calls.filter((c) => c[0] === "chat_stream_turn");
      const lastMessages = (turnCalls.at(-1)![1] as {
        messages: Array<{ role: string; content: unknown }>;
      }).messages;
      expect(toolResultText(lastMessages)).toMatch(/write_tsx failed.*empty/i);
    });

    it("does not let an illustrative tsx snippet clobber the edited circuit", async () => {
      useCircuitStore.getState().setTsxCode(
        `export default () => (\n  <board width="50mm" height="50mm">\n    <resistor name="R1" resistance="10k" footprint="0402" key="r1_aaa111" />\n  </board>\n)`
      );

      let turn = 0;
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd !== "chat_stream_turn") return "";
        if (turn++ === 0) {
          return toolUseTurn([
            {
              id: "e1",
              name: "edit_tsx",
              input: { old_string: 'resistance="10k"', new_string: 'resistance="4.7k"' },
            },
          ]);
        }
        // The model did the real change via edit_tsx, then pasted an example
        // fence. A ```tsx block is never applied, so it must not touch the circuit.
        const answer =
          'Added it.\n\n```tsx\n<resistor name="R9" resistance="1k" footprint="0402" key="r_z9z9z9" />\n```';
        emitStream(answer);
        return turnResult(answer);
      });

      await useChatStore.getState().sendMessage("make R1 4.7k");

      const tsx = useCircuitStore.getState().tsxCode;
      expect(tsx).toContain("<board");
      expect(tsx).toContain('name="R1"');
      expect(tsx).toContain('resistance="4.7k"');
      expect(tsx).not.toContain('name="R9"'); // the snippet was discarded

      useCircuitStore.setState({ circuitJson: [], evalInputHash: null });
      await vi.waitFor(() =>
        expect(useCircuitStore.getState().isValidating).toBe(false)
      );
    });

    it("ignores a full <board> rewrite in the answer — only edit_tsx changes the circuit", async () => {
      useCircuitStore.getState().setTsxCode(
        `export default () => (\n  <board width="50mm" height="50mm">\n    <resistor name="R1" resistance="10k" footprint="0402" key="r1_aaa111" />\n  </board>\n)`
      );

      let turn = 0;
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd !== "chat_stream_turn") return "";
        if (turn++ === 0) {
          return toolUseTurn([
            {
              id: "e1",
              name: "edit_tsx",
              input: { old_string: 'resistance="10k"', new_string: 'resistance="4.7k"' },
            },
          ]);
        }
        // A full <board> fence in the answer text is illustrative prose — it must
        // NOT replace the circuit. Only the edit_tsx change is committed.
        const answer =
          'Here is the whole thing:\n\n```tsx\nexport default () => (\n  <board width="60mm" height="60mm">\n    <capacitor name="C9" capacitance="1uF" footprint="0402" key="c_99" />\n  </board>\n)\n```';
        emitStream(answer);
        return turnResult(answer);
      });

      await useChatStore.getState().sendMessage("change R1 and show me the rewrite");

      const tsx = useCircuitStore.getState().tsxCode;
      expect(tsx).toContain('name="R1"');
      expect(tsx).toContain('resistance="4.7k"');
      expect(tsx).not.toContain('name="C9"'); // the ```tsx board block was ignored
      expect(tsx).not.toContain('width="60mm"');

      useCircuitStore.setState({ circuitJson: [], evalInputHash: null });
      await vi.waitFor(() =>
        expect(useCircuitStore.getState().isValidating).toBe(false)
      );
    });

    it("does not apply a ```tsx block when the model made no edit_tsx call", async () => {
      useCircuitStore.getState().setTsxCode(
        `export default () => (\n  <board width="50mm" height="50mm">\n    <resistor name="R1" resistance="10k" footprint="0402" key="r1_aaa111" />\n  </board>\n)`
      );
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd !== "chat_stream_turn") return "";
        // A pure answer with a full-board fence and no edit_tsx call — the circuit
        // must be left untouched, and the raw ```tsx kept so the user can read it.
        const answer =
          'You could write it like this:\n\n```tsx\nexport default () => (\n  <board width="80mm" height="80mm">\n    <led name="LED1" color="red" footprint="0603" key="d_led111" />\n  </board>\n)\n```';
        emitStream(answer);
        return turnResult(answer);
      });

      await useChatStore.getState().sendMessage("how would I make an LED board?");

      const tsx = useCircuitStore.getState().tsxCode;
      expect(tsx).toContain('name="R1"');
      expect(tsx).not.toContain('name="LED1"');
      expect(tsx).not.toContain('width="80mm"');
      const assistant = useChatStore.getState().messages.find((m) => m.role === "assistant");
      expect(assistant?.content).toContain("```tsx");
    });

    it("persists a prose-less edit_tsx turn so its trail survives in history", async () => {
      useCircuitStore.getState().setTsxCode(
        `export default () => (\n  <board width="50mm" height="50mm">\n    <resistor name="R1" resistance="10k" footprint="0402" key="r1_aaa111" />\n  </board>\n)`
      );

      let turn = 0;
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd !== "chat_stream_turn") return "";
        if (turn++ === 0) {
          return toolUseTurn([
            {
              id: "e1",
              name: "edit_tsx",
              input: { old_string: 'resistance="10k"', new_string: 'resistance="4.7k"' },
            },
          ]);
        }
        // No answer text — the model finished on the edit alone.
        return turnResult("");
      });

      await useChatStore.getState().sendMessage("make R1 4.7k");

      // The edit applied AND an assistant message persisted with the edit trail,
      // rather than the turn vanishing from history.
      expect(useCircuitStore.getState().tsxCode).toContain('resistance="4.7k"');
      const assistant = useChatStore
        .getState()
        .messages.find((m) => m.role === "assistant");
      expect(assistant?.content).toBe("Updated the circuit.");
      const editEvent = assistant?.events?.find(
        (e) => e.kind === "activity" && e.activity.kind === "edit"
      );
      expect(editEvent).toBeDefined();

      useCircuitStore.setState({ circuitJson: [], evalInputHash: null });
      await vi.waitFor(() =>
        expect(useCircuitStore.getState().isValidating).toBe(false)
      );
    });

    it("feeds an edit_tsx failure back so the model can retry", async () => {
      let turn = 0;
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd !== "chat_stream_turn") return "";
        if (turn++ === 0) {
          return toolUseTurn([
            {
              id: "e1",
              name: "edit_tsx",
              input: { old_string: "does-not-exist-anywhere", new_string: "x" },
            },
          ]);
        }
        emitStream("Sorry, retrying.");
        return turnResult("Sorry, retrying.");
      });

      await useChatStore.getState().sendMessage("edit something");

      // The failed-edit message was returned as a tool message for the next turn.
      const turnCalls = mockInvoke.mock.calls.filter((c) => c[0] === "chat_stream_turn");
      const lastMessages = (turnCalls.at(-1)![1] as {
        messages: Array<{ role: string; content: unknown }>;
      }).messages;
      expect(toolResultText(lastMessages)).toMatch(/Edit failed.*not found/i);
    });

    it("stops with a clear error after the soft round backstop", async () => {
      // The model never stops calling tools — the soft backstop must break in.
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "search_jlcpcb") return "results";
        return toolUseTurn([
          { id: "t", name: "search_jlcpcb", input: { query: "x" } },
        ]);
      });

      await useChatStore.getState().sendMessage("loop forever");

      const s = useChatStore.getState();
      expect(s.isStreaming).toBe(false);
      expect(s.error).toMatch(/stuck|rounds/i);
      // The stuck turn produced no answer text, so no empty-content assistant
      // message may be persisted — replaying one would 400 the API and brick
      // every following message in the session.
      expect(
        s.messages.some(
          (m) => m.role === "assistant" && (m.content as string).trim() === ""
        )
      ).toBe(false);
    });

    it("never sends an empty-content turn to the API", async () => {
      // An empty assistant message left in history by an older build must not be
      // replayed verbatim — the loop filters it out of the request payload.
      useChatStore.setState({
        messages: [
          { id: "u0", role: "user", content: "hi", timestamp: 0 },
          { id: "a0", role: "assistant", content: "", timestamp: 0 },
        ],
      });
      mockInvoke.mockImplementation(async () => {
        emitStream("ok");
        return turnResult("ok");
      });

      await useChatStore.getState().sendMessage("again");

      const sent = lastDesignCall()!;
      const hasEmpty = sent.messages.some(
        (m) => typeof m.content === "string" && m.content.trim() === ""
      );
      expect(hasEmpty).toBe(false);
    });
  });

  describe("tsxSnapshot capture", () => {
    it("stamps the resulting circuit onto the assistant message", async () => {
      mockInvoke.mockImplementation(async () => {
        emitStream("Hello");
        return turnResult("Hello");
      });

      await useChatStore.getState().sendMessage("hi");

      const assistant = useChatStore
        .getState()
        .messages.find((m) => m.role === "assistant");
      // A plain Q&A turn snapshots the (unchanged) live circuit.
      expect(assistant?.tsxSnapshot).toBe(useCircuitStore.getState().tsxCode);
    });

    it("captures the post-edit circuit so a rewind restores the change", async () => {
      useCircuitStore.getState().setTsxCode(
        `export default () => (\n  <board width="50mm" height="50mm">\n    <resistor name="R1" resistance="10k" footprint="0402" key="r1_aaa111" />\n  </board>\n)`
      );
      let turn = 0;
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd !== "chat_stream_turn") return "";
        if (turn++ === 0) {
          return toolUseTurn([
            {
              id: "e1",
              name: "edit_tsx",
              input: { old_string: 'resistance="10k"', new_string: 'resistance="4.7k"' },
            },
          ]);
        }
        emitStream("Changed.");
        return turnResult("Changed.");
      });

      await useChatStore.getState().sendMessage("make R1 4.7k");

      const assistant = useChatStore
        .getState()
        .messages.find((m) => m.role === "assistant");
      expect(assistant?.tsxSnapshot).toContain('resistance="4.7k"');

      // Drive the started validation cycle to completion so it doesn't linger.
      useCircuitStore.setState({ circuitJson: [], evalInputHash: null });
      await vi.waitFor(() =>
        expect(useCircuitStore.getState().isValidating).toBe(false)
      );
    });

    it("caps retained snapshots to the recent window as new turns arrive", async () => {
      // 20 prior assistant turns, each already holding a snapshot (the cap).
      const seeded = Array.from({ length: 20 }, (_, i) => ({
        id: `a${i}`,
        role: "assistant" as const,
        content: `turn ${i}`,
        timestamp: i,
        tsxSnapshot: `tsx ${i}`,
      }));
      useChatStore.setState({ messages: seeded });

      mockInvoke.mockImplementation(async () => {
        emitStream("newest");
        return turnResult("newest");
      });

      await useChatStore.getState().sendMessage("one more");

      const withSnapshot = useChatStore
        .getState()
        .messages.filter(
          (m) => m.role === "assistant" && m.tsxSnapshot !== undefined
        );
      // Still exactly the cap; the oldest seeded turn dropped its snapshot.
      expect(withSnapshot).toHaveLength(20);
      expect(
        useChatStore.getState().messages.find((m) => m.id === "a0")?.tsxSnapshot
      ).toBeUndefined();
    });
  });

  describe("restoreToMessage", () => {
    const SNAPSHOT_TSX = `export default () => (\n  <board width="20mm" height="20mm">\n    <resistor name="R1" resistance="2k" footprint="0402" key="r1_snap01" />\n  </board>\n)`;
    const LATER_TSX = `export default () => (\n  <board width="20mm" height="20mm">\n    <resistor name="R1" resistance="9k" footprint="0402" key="r1_now999" />\n  </board>\n)`;

    function seedConversation() {
      useChatStore.setState({
        messages: [
          { id: "u1", role: "user", content: "make a resistor", timestamp: 1 },
          {
            id: "a1",
            role: "assistant",
            content: "Done.",
            timestamp: 2,
            tsxSnapshot: SNAPSHOT_TSX,
          },
          { id: "s1", role: "system", content: "__ok__", timestamp: 3 },
          { id: "u2", role: "user", content: "now change it", timestamp: 4 },
          {
            id: "a2",
            role: "assistant",
            content: "Changed.",
            timestamp: 5,
            tsxSnapshot: "later tsx",
          },
          { id: "s2", role: "system", content: "__ok__", timestamp: 6 },
        ],
      });
    }

    it("reverts the circuit to the snapshot and drops every later message", () => {
      seedConversation();
      // The live circuit has since moved on.
      useCircuitStore.getState().setTsxCode(LATER_TSX);

      useChatStore.getState().restoreToMessage("a1");

      const tsx = useCircuitStore.getState().tsxCode;
      expect(tsx).toContain('resistance="2k"');
      expect(tsx).not.toContain('resistance="9k"');

      // Keeps up to and including the target turn; trailing system row + later
      // turns are gone.
      expect(useChatStore.getState().messages.map((m) => m.id)).toEqual([
        "u1",
        "a1",
      ]);
    });

    it("is a no-op while a turn is streaming", () => {
      seedConversation();
      useChatStore.setState({ isStreaming: true });
      useCircuitStore.getState().setTsxCode(LATER_TSX);

      useChatStore.getState().restoreToMessage("a1");

      expect(useCircuitStore.getState().tsxCode).toContain('resistance="9k"');
      expect(useChatStore.getState().messages).toHaveLength(6);
    });

    it("is a no-op while the circuit is validating", () => {
      seedConversation();
      useCircuitStore.getState().setValidating(true);
      useCircuitStore.getState().setTsxCode(LATER_TSX);

      useChatStore.getState().restoreToMessage("a1");

      expect(useCircuitStore.getState().tsxCode).toContain('resistance="9k"');
      expect(useChatStore.getState().messages).toHaveLength(6);
      useCircuitStore.getState().setValidating(false);
    });

    it("ignores a user message or an assistant turn with no snapshot", () => {
      useChatStore.setState({
        messages: [
          { id: "u1", role: "user", content: "hi", timestamp: 1 },
          { id: "a1", role: "assistant", content: "no snapshot", timestamp: 2 },
        ],
      });

      useChatStore.getState().restoreToMessage("u1");
      expect(useChatStore.getState().messages).toHaveLength(2);

      useChatStore.getState().restoreToMessage("a1");
      expect(useChatStore.getState().messages).toHaveLength(2);
    });

    it("clears the rolling-notes boundary when the rewind lands before it", () => {
      useChatStore.setState({
        messages: [
          { id: "u1", role: "user", content: "1", timestamp: 1 },
          {
            id: "a1",
            role: "assistant",
            content: "2",
            timestamp: 2,
            tsxSnapshot: SNAPSHOT_TSX,
          },
          { id: "u2", role: "user", content: "3", timestamp: 3 },
          {
            id: "a2",
            role: "assistant",
            content: "4",
            timestamp: 4,
            tsxSnapshot: "x",
          },
        ],
        summarizedCount: 3,
        sessionNotes: "old notes",
      });

      useChatStore.getState().restoreToMessage("a1");

      // Only 2 non-system messages survive but the boundary was 3 → reset.
      expect(useChatStore.getState().summarizedCount).toBe(0);
      expect(useChatStore.getState().sessionNotes).toBeNull();
    });

    it("keeps the rolling-notes boundary when it still fits the rewound tail", () => {
      useChatStore.setState({
        messages: [
          { id: "u1", role: "user", content: "1", timestamp: 1 },
          {
            id: "a1",
            role: "assistant",
            content: "2",
            timestamp: 2,
            tsxSnapshot: SNAPSHOT_TSX,
          },
          { id: "u2", role: "user", content: "3", timestamp: 3 },
          {
            id: "a2",
            role: "assistant",
            content: "4",
            timestamp: 4,
            tsxSnapshot: "x",
          },
        ],
        summarizedCount: 1,
        sessionNotes: "kept notes",
      });

      useChatStore.getState().restoreToMessage("a1");

      expect(useChatStore.getState().summarizedCount).toBe(1);
      expect(useChatStore.getState().sessionNotes).toBe("kept notes");
    });
  });
});
