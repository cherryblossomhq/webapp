import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Mock the chat transport before chatStore is imported. Test calls use a single
// dispatcher-style spy: streamTurn maps to "chat_stream_turn", and tool
// backends map to their command names. Live deltas flow through callbacks from
// the most recent streamTurn call (emitStream below).
const mockInvoke = vi.fn();

interface CapturedCallbacks {
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
}
let currentCallbacks: CapturedCallbacks | null = null;

vi.mock("../utils/chatTransport", () => ({
  MANAGED_CHAT_COMPLETIONS_URL:
    "https://www.trycherryblossom.com/api/v1/chat/completions",
  // The loop only reads tool names out of the catalog; a name-only stub keeps
  // the mock decoupled from the real schemas.
  CHAT_TOOLS: [
    { name: "edit_tsx" },
    { name: "write_tsx" },
    { name: "search_jlcpcb" },
    { name: "import_component" },
    { name: "lookup_footprint" },
    { name: "fetch_datasheet" },
  ],
  streamTurn: (args: unknown, callbacks?: CapturedCallbacks) => {
    currentCallbacks = callbacks ?? null;
    return mockInvoke("chat_stream_turn", args);
  },
  searchJlcpcb: (query: string, limit?: number) =>
    mockInvoke("search_jlcpcb", { query, limit }),
  lookupFootprint: (lcscId?: string, mpn?: string) =>
    mockInvoke("lookup_footprint", { lcscId, mpn }),
  fetchDatasheet: (auth: unknown, lcscId: string, mpn?: string) =>
    mockInvoke("fetch_datasheet", { auth, lcscId, mpn }),
}));

// Datasheet summaries live in localStorage; no cache entries in tests.
vi.mock("../utils/datasheets", () => ({
  listCachedDatasheets: vi.fn(() => []),
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

import { useChatStore, applyTsxStringEdit, capSnapshots } from "./chatStore";
import { useCircuitStore } from "./circuitStore";
import { useAuthStore } from "./authStore";
import { fetchComponentDef } from "../utils/easyedaImport";

const mockFetchDef = vi.mocked(fetchComponentDef);

// A turn that stops on tool_use with the given tool calls.
function toolUseTurn(
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>
) {
  return { text: "", toolCalls, thinkingBlocks: [], stopReason: "tool_use" };
}

function emitStream(text: string) {
  currentCallbacks?.onText?.(text);
}

// A single-turn `chat_stream_turn` result: no tool calls, model is done. The
// live answer text streams via the onText callback (emitStream); `text` here
// is just what the resolved turn carries.
function turnResult(text = "") {
  return { text, toolCalls: [], thinkingBlocks: [], stopReason: "end_turn" };
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
});

describe("chatStore", () => {
  beforeEach(() => {
    currentCallbacks = null;
    mockInvoke.mockReset();
    mockFetchDef.mockReset();
    useChatStore.setState({
      messages: [],
      isStreaming: false,
      streamingEvents: [],
      apiKey: "test-key",
      aiProvider: "apiKey",
      chatOpen: false,
      error: null,
      sessionNotes: null,
      summarizedCount: 0,
    });
    useAuthStore.setState({
      status: "signedOut",
      user: null,
      accessToken: null,
      error: null,
    });
    useCircuitStore.getState().resetCircuit();
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  describe("sendMessage — happy path", () => {
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
    it("surfaces 401 as an invalid-API-key error and does not stream", async () => {
      mockInvoke.mockImplementation(async () => {
        throw "401: bad key";
      });

      await useChatStore.getState().sendMessage("hi");

      const state = useChatStore.getState();
      expect(state.isStreaming).toBe(false);
      expect(state.error).toMatch(/Invalid API key/);
    });

    it("classifies 429 as a rate-limit error", async () => {
      mockInvoke.mockImplementation(async () => {
        throw "429: rate limited";
      });

      await useChatStore.getState().sendMessage("hi");
      expect(useChatStore.getState().error).toMatch(/Rate limited/);
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
    it("requires an API key", async () => {
      useChatStore.setState({ apiKey: "" });
      await useChatStore.getState().sendMessage("hi");
      expect(useChatStore.getState().error).toBe("no_api_key");
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("requires a signed-in session in account mode", async () => {
      useChatStore.setState({ aiProvider: "account" });
      await useChatStore.getState().sendMessage("hi");
      expect(useChatStore.getState().error).toBe("no_account");
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

  describe("AI provider credential", () => {
    it("sends the user's key as apiKey auth in apiKey mode", async () => {
      mockInvoke.mockImplementation(async () => {
        emitStream("ok");
        return turnResult("ok");
      });
      await useChatStore.getState().sendMessage("hi");
      const call = mockInvoke.mock.calls.find((c) => c[0] === "chat_stream_turn");
      expect((call![1] as { auth: unknown }).auth).toEqual({
        kind: "apiKey",
        key: "test-key",
      });
    });

    it("sends the WorkOS access token as managed auth in account mode", async () => {
      useChatStore.setState({ aiProvider: "account", apiKey: "" });
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
      mockInvoke.mockImplementation(async () => {
        emitStream("ok");
        return turnResult("ok");
      });
      await useChatStore.getState().sendMessage("hi");
      const call = mockInvoke.mock.calls.find((c) => c[0] === "chat_stream_turn");
      const args = call![1] as { auth: unknown; sessionId: string };
      expect(args.auth).toEqual({
        kind: "managed",
        token: "workos-token",
        url: "https://www.trycherryblossom.com/api/v1/chat/completions",
      });
      expect(args.sessionId).toBe(useChatStore.getState().sessionId);
    });
  });

  describe("setAiProvider", () => {
    it("persists the choice and clears any error", () => {
      localStorage.removeItem("cherryblossom_ai_provider");
      useChatStore.setState({ error: "no_account" });
      useChatStore.getState().setAiProvider("account");
      expect(useChatStore.getState().aiProvider).toBe("account");
      expect(useChatStore.getState().error).toBeNull();
      // Persisted so it survives a reload (loadAiProvider reads this on init).
      expect(localStorage.getItem("cherryblossom_ai_provider")).toBe("account");
    });
  });

  describe("setApiKey", () => {
    it("stores the key, persists it, and clears any error", () => {
      localStorage.removeItem("cherryblossom_api_key");
      useChatStore.setState({ error: "no_api_key" });
      useChatStore.getState().setApiKey("new-key");
      expect(useChatStore.getState().apiKey).toBe("new-key");
      expect(useChatStore.getState().error).toBeNull();
      // Persisted so it survives a reload (loadApiKey reads this on init).
      expect(localStorage.getItem("cherryblossom_api_key")).toBe("new-key");
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

  describe("agentic tool loop", () => {
    it("runs a tool call, feeds the result back, then finishes", async () => {
      let turn = 0;
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "search_jlcpcb") return "C1 | TP4056 | charger";
        // chat_stream_turn: first tool_use, then a plain answer.
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

      // The next turn carried the tool_result back to the model.
      const turnCalls = mockInvoke.mock.calls.filter((c) => c[0] === "chat_stream_turn");
      const lastMessages = (turnCalls.at(-1)![1] as { messages: Array<{ content: unknown }> })
        .messages;
      const hasToolResult = lastMessages.some(
        (m) =>
          Array.isArray(m.content) &&
          (m.content as Array<{ type?: string }>).some((b) => b.type === "tool_result")
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
        if (cmd !== "chat_stream_turn") return "";
        const t = turn++;
        if (t === 0) {
          return toolUseTurn([
            { id: "i1", name: "import_component", input: { lcsc_id: "C16581" } },
          ]);
        }
        if (t === 1) {
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
      const lastMessages = (turnCalls.at(-1)![1] as { messages: Array<{ content: unknown }> })
        .messages;
      const toolResultText = lastMessages
        .flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ content?: string }>) : []))
        .map((b) => b.content ?? "")
        .join("");
      expect(toolResultText).toContain("<TP4056");

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

      // Drive the validation cycle to completion so it doesn't linger.
      useCircuitStore.setState({ circuitJson: [], evalInputHash: null });
      await vi.waitFor(() =>
        expect(useCircuitStore.getState().isValidating).toBe(false)
      );
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
      const lastMessages = (turnCalls.at(-1)![1] as { messages: Array<{ content: unknown }> })
        .messages;
      const toolResultText = lastMessages
        .flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ content?: string }>) : []))
        .map((b) => b.content ?? "")
        .join("");
      expect(toolResultText).toMatch(/write_tsx failed.*empty/i);
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

      // The failed-edit message was returned as a tool_result for the next turn.
      const turnCalls = mockInvoke.mock.calls.filter((c) => c[0] === "chat_stream_turn");
      const lastMessages = (turnCalls.at(-1)![1] as { messages: Array<{ content: unknown }> })
        .messages;
      const toolResultText = lastMessages
        .flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ content?: string }>) : []))
        .map((b) => b.content ?? "")
        .join("");
      expect(toolResultText).toMatch(/Edit failed.*not found/i);
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
