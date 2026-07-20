import { create } from "zustand";
import { persist } from "zustand/middleware";
import { toast } from "sonner";
import { useCircuitStore, cleanImportedTsx } from "./circuitStore";
import { useEditorStore } from "../editor/state/editorStore";
import { hashInput } from "../editor/services/CircuitEvaluator";
import { summarizeManualEdits } from "../editor/services/ProjectStore";
import {
  buildSystemPrompt,
  buildDynamicContext,
  type ActiveView,
  type ViewSelection,
  type DatasheetSummary,
} from "../utils/chatSystemPrompt";
import { extractComponents } from "../utils/tsxTransform";
import { CHAT_DEFAULT_WIDTH } from "../lib/clampChatWidth";
import { fetchComponentDef } from "../utils/easyedaImport";
import {
  streamTurn,
  searchJlcpcb,
  lookupFootprint,
  fetchDatasheet,
  CHAT_TOOLS,
  OPENROUTER_CHAT_COMPLETIONS_URL,
  type OpenRouterAuth,
  type ChatTurnResult,
  type ChatToolCall,
} from "../utils/chatTransport";
import { useAuthStore } from "./authStore";
import { ANONYMOUS_MODEL, useAccountStore } from "./accountStore";
import { listCachedDatasheets } from "../utils/datasheets";

// Resolve current selection (single component) and active view for the AI.
// We snapshot from the editor + circuit stores so the AI sees the same context
// the user is looking at.
function resolveActiveView(): ActiveView {
  const tab = useEditorStore.getState().activeTab;
  if (
    tab === "schematic" ||
    tab === "pcb" ||
    tab === "cad" ||
    tab === "bom" ||
    tab === "code"
  ) {
    return tab;
  }
  return "schematic";
}

function resolveSelection(): ViewSelection | null {
  const tsx = useCircuitStore.getState().tsxCode;
  const selectedKeys = useEditorStore.getState().selectedKeys;
  if (selectedKeys.size === 1) {
    const targetKey = Array.from(selectedKeys)[0];
    for (const c of extractComponents(tsx)) {
      if (c.props.key === targetKey) {
        return { name: c.name, kind: c.elementTag };
      }
    }
  }
  // Fall back to legacy name selection if no key selection.
  const legacyName = useCircuitStore.getState().selectedComponentName;
  if (legacyName) {
    const found = extractComponents(tsx).find((c) => c.name === legacyName);
    if (found) return { name: found.name, kind: found.elementTag };
  }
  return null;
}

async function fetchDatasheetSummariesForCircuit(
  tsx: string
): Promise<DatasheetSummary[]> {
  // Read JLCPCB-imported component names from the TSX and look up any cached
  // datasheet summaries. Misses (no cache) are silently skipped — the AI can
  // still call fetch_datasheet on demand.
  const names = extractComponents(tsx)
    .map((c) => c.name)
    .filter((n, i, a) => a.indexOf(n) === i);
  if (names.length === 0) return [];
  try {
    return listCachedDatasheets(names);
  } catch {
    return [];
  }
}

const MAX_USER_MESSAGE_LENGTH = 50_000;
// Prefer Haiku for cheap helper work when the account permits it. Plans that do
// not include Haiku fall back to the already-authorized selected design model.
export const PREFERRED_HELPER_MODEL = "anthropic/claude-haiku-4.5";

export function resolveHelperModel(
  allowedModels: string[],
  selectedModel: string,
): string {
  return allowedModels.includes(PREFERRED_HELPER_MODEL)
    ? PREFERRED_HELPER_MODEL
    : selectedModel;
}

// History = a "breathing" raw tail + a rolling notes summary of everything older.
// The non-system messages are [ summarized prefix ][ raw tail ]: the tail is sent
// verbatim, the prefix is distilled into `sessionNotes` and injected via
// buildDynamicContext. The tail grows from HISTORY_WINDOW up to
// HISTORY_WINDOW + SUMMARY_BATCH, then the oldest SUMMARY_BATCH turns fold into
// the notes and drop out, back to HISTORY_WINDOW. So `notes(prefix) + raw(tail)`
// always covers 100% of the conversation — never a gap. Nothing folds until a
// session exceeds HISTORY_WINDOW + SUMMARY_BATCH messages, so short sessions make
// zero summary calls. Truncating raw turns is safe because the *current* circuit
// TSX is always re-injected fresh — only older back-and-forth gets distilled.
const HISTORY_WINDOW = 16; // floor of raw user/assistant messages always sent
const SUMMARY_BATCH = 8; // fold this many oldest turns once the tail overflows

// How many recent assistant turns keep a restorable circuit snapshot. Older
// turns drop their `tsxSnapshot` (in memory AND in persistence) — bounding both
// heap and localStorage growth at ~MAX × circuit-size regardless of how long the
// session runs. Beyond this window a turn is no longer a checkpoint, so its
// "restore" affordance renders disabled. See capSnapshots / restoreToMessage.
// Independent of the circuit's own MAX_HISTORY=50 undo ring — a restore feeds
// that ring via setTsxCode, so a rewind is itself Cmd+Z-undoable.
const MAX_SNAPSHOTS = 20;

// A single tool action the model took this turn (search / footprint lookup /
// datasheet read / part import), surfaced as an icon+label row in the chat.
export interface ChatActivity {
  id: string;
  kind: "search" | "footprint" | "datasheet" | "import" | "edit" | "write";
  detail: string;
  // `edit` actions carry the exact string-replace tool call. The chat trail
  // shows these in a click-to-expand panel (like the Thinking trace) rather than
  // an inline muted detail — see ActivityRow.
  edit?: { oldString: string; newString: string; replaceAll: boolean };
  // `write` actions carry the full circuit written by `write_tsx` (a wholesale
  // overwrite). Shown in the same click-to-expand style as `edit`, revealing the
  // complete new TSX.
  write?: { tsx: string };
}

// One entry in an assistant turn's chronological trail. A turn interleaves
// reasoning, tool actions, and answer text in the exact order they streamed —
// e.g. think → search → think → import → text → think → text. Consecutive text
// (or thinking) deltas coalesce into one segment; a tool call, or a switch
// between thinking and text, opens a new entry. Rendered top-to-bottom as the trail.
export type ChatEvent =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "activity"; activity: ChatActivity };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  /**
   * Chronological trail of this assistant turn (assistant only): reasoning, tool
   * actions, and answer text interleaved in stream order. `content` stays the full
   * concatenated answer text — the source of truth for history, TSX extraction, copy.
   */
  events?: ChatEvent[];
  /**
   * Circuit TSX as it stood right after this assistant turn applied (assistant
   * turns only). Lets the user rewind the conversation to this message and get
   * the circuit back exactly as it was then — see `restoreToMessage`. Absent on
   * user/system rows and on assistant messages persisted before this existed.
   */
  tsxSnapshot?: string;
  /**
   * The OpenRouter messages this turn's tool loop appended — assistant
   * `tool_calls` turns, their `role: "tool"` results, and any recovery nudge —
   * in stream order, reduced to their replayable core: reasoning and per-round
   * streamed text are stripped (reasoning is intra-turn only; the text is
   * already concatenated into `content`) — see `toPersistedTranscript`.
   * Replayed verbatim ahead of `content` when history is rebuilt, so on later
   * turns the model still sees its own past tool calls and their results
   * instead of just the answer prose. Capped alongside `tsxSnapshot` (see
   * `capSnapshots`); absent on turns that ran no tools.
   */
  toolTranscript?: OpenRouterMessage[];
}

interface ChatStore {
  messages: ChatMessage[];
  isStreaming: boolean;
  // Live chronological trail for the in-flight turn — fed by the `chat-stream-chunk`
  // and `chat-stream-thinking` events plus the tool-action rows the JS loop pushes
  // as it dispatches each tool, so the UI shows reasoning, tool actions, and answer
  // text interleaved roughly as they happen.
  streamingEvents: ChatEvent[];
  chatOpen: boolean;
  error: string | null;
  // True when `error` came from an anonymous (token-less) request hitting a
  // server limit (429 rate_limited / 403 model_not_allowed). The chat panel
  // then renders a "sign in for higher limits" prompt instead of the plain
  // error banner. Always false while `error` is null.
  errorSignInCta: boolean;
  // Rolling distillation of older turns (decisions/preferences/constraints) that
  // have scrolled out of the raw window, plus a count of how many non-system
  // messages it already covers. Together they form the "summarized prefix".
  sessionNotes: string | null;
  summarizedCount: number;
  // Stable, random routing key for OpenRouter provider/cache affinity.
  // It contains no user data and rotates whenever chat history is cleared.
  sessionId: string;
  // Per-conversation PostHog trace id, sent as `X-Trace-Id` on every managed
  // completions request so the whole conversation (tool rounds, history folds,
  // datasheet helper calls) groups into one trace. Persisted with the history
  // and rotated on clearHistory, same lifecycle as sessionId — but kept
  // separate so observability grouping never couples to provider routing.
  traceId: string;

  // ─── Resizable chat rail ─────────────────────────────────────────────────
  // Chat replaces the right rail while open (to see Properties, close chat).
  // `chatWidth` is the persisted drag width; `chatResizing` is a transient flag
  // the drag handle raises so the message list can suppress its autoscroll lock
  // while the panel reflows.
  chatWidth: number;
  chatResizing: boolean;

  sendMessage: (content: string) => Promise<void>;
  // Rewind the conversation to a previous assistant turn: restore the circuit to
  // that turn's `tsxSnapshot` and drop every later message. No-op while streaming
  // or validating — those mutate circuit + chat state asynchronously and would
  // race the rewind.
  restoreToMessage: (messageId: string) => void;
  toggleChat: () => void;
  setChatOpen: (open: boolean) => void;
  setChatWidth: (width: number) => void;
  setChatResizing: (resizing: boolean) => void;
  clearHistory: () => void;
  clearError: () => void;
}

// Remove secrets and provider choices left by builds that supported direct
// browser-to-Anthropic BYOK. These values are intentionally not migrated.
export function clearLegacyByokStorage(storage: Pick<Storage, "removeItem">): void {
  for (const key of ["cherryblossom_api_key", "cherryblossom_ai_provider"]) {
    try {
      storage.removeItem(key);
    } catch {
      // Storage can be unavailable in privacy-restricted browser contexts.
    }
  }
}
try {
  clearLegacyByokStorage(localStorage);
} catch {
  // The app can still load when the storage API itself is unavailable.
}

// Backstop for how long the chat waits on the post-edit render before giving up.
// The evaluator has its own (shorter) internal timeout that surfaces eval
// failures the validation cycle observes directly — so this only catches a
// render that neither completes nor errors. Kept generous so a heavy Opus circuit
// that legitimately takes a while to settle isn't cut off mid-render.
const VALIDATION_RENDER_TIMEOUT_MS = 120_000;
// Opus 4.8 uses adaptive thinking — the model decides how much to reason — with
// an effort level (low | medium | high | xhigh | max) controlling the depth.
// "high" is the recommended floor for intelligence-sensitive work; design turns
// run there.
const DESIGN_EFFORT = "high";

// The agentic tool loop is free-running — no hard cap that strips tools to force
// output (that mangles responses). MAX_TOOL_ROUNDS is a SOFT backstop only: if
// the model is still calling tools after this many rounds it's almost certainly
// stuck in a loop, so we break and tell the user rather than apply a
// half-finished circuit. Bump it if legitimate large designs hit the ceiling.
const MAX_TOOL_ROUNDS = 25;

// One-time nudge when a turn ends having neither edited the circuit (via edit_tsx)
// nor produced any answer text — almost always the model stopping mid-task after
// some tool calls. Re-prompted with tools still on so it can actually finish.
const RECOVERY_PROMPT =
  "You ended your turn without changing the circuit or answering. If the request needs a " +
  "circuit change, make it now with the edit_tsx tool (or write_tsx if the circuit is empty " +
  "or you're rewriting it wholesale), then add a one-line summary. " +
  "If it was a question, just answer it.";

const AI_SETUP_ERRORS = new Set(["no_account", "no_managed_model"]);

export function isAiSetupError(error: string | null): boolean {
  return error !== null && AI_SETUP_ERRORS.has(error);
}

// Plain 8-4-4-4-12 UUID — the only X-Trace-Id shape the proxy accepts. Anything
// else is silently ignored server-side, so a malformed persisted value is
// replaced rather than sent.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Resolve the conversation's trace id, lazily minting (and persisting, via the
// setState → persist write) one for conversations saved before trace grouping
// existed or whose stored value isn't a plain UUID.
export function ensureTraceId(): string {
  const { traceId } = useChatStore.getState();
  if (typeof traceId === "string" && UUID_RE.test(traceId)) return traceId;
  const fresh = crypto.randomUUID();
  useChatStore.setState({ traceId: fresh });
  return fresh;
}

// Resolve the credential for the next OpenRouter call. Read fresh at every call
// so a mid-turn token refresh (or sign-out) takes effect on the next request.
// Signed-out visitors get a token-less (anonymous) credential — the proxy
// rate-limits those per client IP and only allows ANONYMOUS_MODEL. While the
// session is still being resolved (launch restore or sign-in in flight) this
// returns null so no request is ever sent with the wrong identity.
export function resolveChatAuth(): OpenRouterAuth | null {
  const { status, accessToken } = useAuthStore.getState();
  if (status === "signedIn" && accessToken) {
    return { token: accessToken, url: OPENROUTER_CHAT_COMPLETIONS_URL };
  }
  if (status === "signedOut") {
    return { token: null, url: OPENROUTER_CHAT_COMPLETIONS_URL };
  }
  return null;
}

// Keep `tsxSnapshot` and `toolTranscript` only on the most recent `max`
// assistant turns that carry them; strip them from any older turn so memory and
// persistence stay bounded. The cap comfortably exceeds the raw history tail
// (HISTORY_WINDOW + SUMMARY_BATCH non-system messages ≈ half that in assistant
// turns), so a transcript is never stripped while the next turn would still
// replay it. Pure, and returns the SAME array reference when nothing needs
// stripping — safe to call on every snapshot write and inside the persist
// partializer.
export function capSnapshots(
  messages: ChatMessage[],
  max: number
): ChatMessage[] {
  return capExtra(capExtra(messages, max, "tsxSnapshot"), max, "toolTranscript");
}

function capExtra(
  messages: ChatMessage[],
  max: number,
  field: "tsxSnapshot" | "toolTranscript"
): ChatMessage[] {
  // Walk newest→oldest, collecting the indices that currently hold the field.
  const idxNewestFirst: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m[field] !== undefined) {
      idxNewestFirst.push(i);
    }
  }
  if (idxNewestFirst.length <= max) return messages;
  // Everything past the newest `max` is stale and loses the field.
  const stale = new Set(idxNewestFirst.slice(max));
  return messages.map((m, i) => {
    if (!stale.has(i)) return m;
    const { [field]: _drop, ...rest } = m;
    void _drop;
    return rest;
  });
}

export type TsxEditResult =
  | { ok: true; tsx: string; replacements: number }
  | { ok: false; error: string };

// Pure string-replace edit backing the `edit_tsx` tool. Mirrors Claude Code's
// file-edit semantics: `oldString` must be present, and unique unless
// `replaceAll` is set. Returns the new TSX on success or a model-facing error
// string the loop hands back as a tool result so the model can retry.
export function applyTsxStringEdit(
  tsx: string,
  oldString: string,
  newString: string,
  replaceAll: boolean
): TsxEditResult {
  if (oldString === "") {
    return { ok: false, error: "old_string must not be empty — provide the exact existing text to replace." };
  }
  if (oldString === newString) {
    return { ok: false, error: "old_string and new_string are identical — nothing would change." };
  }
  const occurrences = tsx.split(oldString).length - 1;
  if (occurrences === 0) {
    return {
      ok: false,
      error:
        "old_string was not found in the current TSX. Copy it verbatim (indentation, key= props and all) " +
        "from the '## Current Circuit' code block, adding surrounding lines until it matches exactly.",
    };
  }
  if (occurrences > 1 && !replaceAll) {
    return {
      ok: false,
      error:
        `old_string appears ${occurrences} times — it must be unique. Add surrounding lines to make it ` +
        "unambiguous, or set replace_all: true to change every occurrence.",
    };
  }
  const next = replaceAll
    ? tsx.split(oldString).join(newString)
    : tsx.replace(oldString, () => newString); // function replacer: no $-pattern expansion
  return { ok: true, tsx: next, replacements: replaceAll ? occurrences : 1 };
}

// Map a failed browser turn to a user-facing message. The transport rejects
// with "{status}:{body}" for HTTP errors and "api_error:{msg}" for mid-stream
// SSE errors. Both proxy and upstream error shapes expose `error.message`;
// proxy plan gates additionally expose `error.type`. When `signInCta` is true
// the error came from an anonymous (token-less) request hitting a server gate,
// and the UI renders it as a "sign in for higher limits" prompt instead of a
// plain error.
export function friendlyChatError(
  errorStr: string,
  anonymous: boolean,
  retryAfter?: string
): { message: string; signInCta: boolean } {
  const plain = (message: string) => ({ message, signInCta: false });
  if (errorStr.includes("auth_lost")) {
    return plain(
      "You were signed out before the response finished. Sign in again in Settings → Account."
    );
  }
  if (errorStr.includes("api_error:")) {
    return plain(errorStr.replace(/.*api_error:/, ""));
  }
  const httpMatch = errorStr.match(/(\d{3}):([\s\S]*)/);
  if (!httpMatch) {
    return plain("Connection error. Check your network and try again.");
  }
  const status = Number(httpMatch[1]);
  let type: string | undefined;
  let message: string | undefined;
  try {
    const body = JSON.parse(httpMatch[2]) as {
      error?: { type?: string; message?: string };
    };
    type = body.error?.type;
    message = body.error?.message;
  } catch {
    /* non-JSON body — fall through to the status-based messages */
  }
  if (status === 401) {
    return plain("Your session has expired. Sign in again in Settings → Account.");
  }
  // Managed-plan gates: the server's message names the plan and model — show it.
  // On a token-less request this means the anonymous tier doesn't cover the
  // model, so the fix is signing in, not switching plans.
  if (type === "plan_required" || type === "model_not_allowed") {
    if (anonymous) {
      return {
        message: message ?? "This model needs an account. Sign in to use it.",
        signInCta: true,
      };
    }
    return plain(message ?? "Your plan doesn't include this model. See Settings → Account.");
  }
  if (status === 429) {
    if (anonymous) {
      // The server's message already says to sign in for higher limits; add the
      // Retry-After hint when the header made it through.
      const seconds = Number(retryAfter);
      const waitNote =
        Number.isFinite(seconds) && seconds > 0
          ? ` Try again in ${Math.ceil(seconds)}s.`
          : "";
      return {
        message: (message ?? "You've hit the free usage limit.") + waitNote,
        signInCta: true,
      };
    }
    return plain("You've hit your plan's usage limit — wait a bit and try again.");
  }
  return plain(message ?? "Connection error. Check your network and try again.");
}

interface OpenRouterMessage {
  role: string;
  content: unknown;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  reasoning?: string;
  reasoning_details?: unknown[];
}

// One tool result message fed back to OpenRouter after local execution.
function toolResult(toolCallId: string, content: string): OpenRouterMessage {
  return { role: "tool", tool_call_id: toolCallId, content };
}

// Reassemble the exact OpenRouter assistant message needed for the next tool
// round, including ordered reasoning details and function-call arguments.
function assistantMsgFromTurn(turn: ChatTurnResult): OpenRouterMessage {
  const message: OpenRouterMessage = {
    role: "assistant",
    content: turn.text || null,
  };
  if (turn.toolCalls.length > 0) {
    message.tool_calls = turn.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: JSON.stringify(tc.input) },
    }));
  }
  if (turn.reasoning.details.length > 0) {
    message.reasoning_details = turn.reasoning.details;
  } else if (turn.reasoning.text !== "") {
    message.reasoning = turn.reasoning.text;
  }
  return message;
}

// Shape the loop-appended messages for persistence as a turn's tool transcript.
// Tool results and the recovery-nudge user prompt pass through unchanged, but
// assistant entries keep ONLY their tool_calls:
// - reasoning goes — it's only meaningful within the turn that produced it
//   (OpenRouter wants it replayed unchanged between tool rounds; providers
//   ignore it on later turns), and persisting per-round blobs is dead weight;
// - per-round streamed text goes — it's already concatenated into the final
//   persisted `content`, so carrying it here would replay it twice;
// - an entry left with nothing (e.g. a reasoning-only turn kept for the
//   recovery nudge) is dropped outright — replaying an empty assistant message
//   400s the API and would brick the session.
function toPersistedTranscript(
  loopMessages: OpenRouterMessage[]
): OpenRouterMessage[] {
  const out: OpenRouterMessage[] = [];
  for (const m of loopMessages) {
    if (m.role !== "assistant") {
      out.push(m);
      continue;
    }
    if (m.tool_calls !== undefined) {
      out.push({ role: "assistant", content: null, tool_calls: m.tool_calls });
    } else if (typeof m.content === "string" && m.content.trim() !== "") {
      // A tool-less assistant entry only reaches the loop via the nudge path,
      // where fullResponse was empty — so any real text here is NOT in the
      // final `content` and is safe (and worth) keeping.
      out.push({ role: "assistant", content: m.content });
    }
  }
  return out;
}

const asString = (v: unknown): string =>
  typeof v === "string" ? v : v == null ? "" : String(v);

// Run one tool call and return its OpenRouter tool message. `import_component`
// resolves the real component definition INLINE here (before the model's next
// turn) — so the model learns the real tag name and any failure immediately,
// instead of the old fake-synchronous predict-a-name-then-patch-after race.
async function dispatchTool(
  tc: ChatToolCall,
  importedDefs: Map<string, { rawTsx: string }>,
  auth: OpenRouterAuth,
  helperModel: string,
  traceId: string,
  pushActivity: (
    kind: ChatActivity["kind"],
    detail: string,
    edit?: ChatActivity["edit"],
    write?: ChatActivity["write"]
  ) => void,
  // Loop-local working copy of the circuit TSX. `edit_tsx` and `write_tsx` mutate
  // `.tsx` in place (each call sees the previous one's result) and flip `.edited`
  // so the caller commits the working copy when the turn ends.
  workingTsx: { tsx: string; edited: boolean }
): Promise<OpenRouterMessage> {
  const input = tc.input ?? {};
  switch (tc.name) {
    case "edit_tsx": {
      const oldString = asString(input.old_string);
      const newString = asString(input.new_string);
      const replaceAll = input.replace_all === true;
      const result = applyTsxStringEdit(workingTsx.tsx, oldString, newString, replaceAll);
      if (!result.ok) {
        // Don't surface a row for a failed edit — it goes back to the model to
        // retry and shouldn't render in the trail as if it applied.
        return toolResult(tc.id, `Edit failed: ${result.error}`);
      }
      workingTsx.tsx = result.tsx;
      workingTsx.edited = true;
      // Detail is empty — the row is expandable and shows the full old/new
      // strings on click, so there's no inline preview to truncate.
      pushActivity("edit", "", { oldString, newString, replaceAll });
      const n = result.replacements;
      return toolResult(
        tc.id,
        `Edit applied (${n} replacement${n === 1 ? "" : "s"}). The working circuit now reflects this change. ` +
          `Make further edit_tsx calls for any remaining changes, then finish your turn with a short summary.`
      );
    }
    case "write_tsx": {
      const tsx = asString(input.tsx);
      if (tsx.trim() === "") {
        return toolResult(
          tc.id,
          "write_tsx failed: `tsx` must be the complete new circuit, not empty. Provide a full module with an " +
            "`export default` component returning a `<board>…</board>`."
        );
      }
      if (tsx === workingTsx.tsx) {
        return toolResult(
          tc.id,
          "write_tsx failed: the provided TSX is identical to the current circuit — nothing would change."
        );
      }
      workingTsx.tsx = tsx;
      workingTsx.edited = true;
      // Detail is empty — the row is expandable and reveals the full written TSX
      // on click, so there's no inline preview to truncate.
      pushActivity("write", "", undefined, { tsx });
      return toolResult(
        tc.id,
        `Circuit rewritten. The working circuit is now this TSX. Make any further changes with edit_tsx, ` +
          `then finish your turn with a short summary.`
      );
    }
    case "search_jlcpcb": {
      const query = asString(input.query);
      pushActivity("search", query);
      const limit = typeof input.limit === "number" ? input.limit : undefined;
      return toolResult(tc.id, await searchJlcpcb(query, limit));
    }
    case "lookup_footprint": {
      const lcsc = asString(input.lcsc_id);
      const mpn = asString(input.mpn);
      pushActivity("footprint", lcsc || mpn);
      return toolResult(tc.id, await lookupFootprint(lcsc || undefined, mpn || undefined));
    }
    case "fetch_datasheet": {
      const lcsc = asString(input.lcsc_id);
      const mpn = asString(input.mpn);
      pushActivity("datasheet", lcsc || mpn);
      return toolResult(
        tc.id,
        await fetchDatasheet(auth, helperModel, lcsc, mpn || undefined, traceId),
      );
    }
    case "import_component": {
      const lcsc = asString(input.lcsc_id);
      pushActivity("import", lcsc);
      if (!lcsc) {
        return toolResult(tc.id, "Error: import_component requires lcsc_id (e.g. 'C16581').");
      }
      try {
        const def = await fetchComponentDef(lcsc);
        importedDefs.set(def.componentName, { rawTsx: def.rawTsx });
        // Stamp the imported part's real footprint into componentMeta keyed by
        // the tag name. The validator looks up by elementTag when no per-name
        // override exists, so every <Name /> instance inherits it.
        const footprintMatch = def.rawTsx.match(/footprint\s*=\s*"([^"]+)"/);
        if (footprintMatch?.[1]) {
          useCircuitStore
            .getState()
            .setComponentMeta(def.componentName, { expectedFootprint: footprintMatch[1] });
        }
        return toolResult(
          tc.id,
          `Imported ${lcsc}. Use the exact tag <${def.componentName} name="U1" /> in your TSX ` +
            `(choose an appropriate designator). Its definition is added to the circuit ` +
            `automatically — do NOT write the function definition yourself.`
        );
      } catch (e) {
        return toolResult(
          tc.id,
          `Import of ${lcsc} FAILED: ${String(e)}. Do NOT reference a tag for this part. ` +
            `Either retry import_component with a different LCSC id, pick another part via ` +
            `search_jlcpcb, or build it from discrete elements (a <chip> with pinLabels).`
        );
      }
    }
    default:
      return toolResult(tc.id, `Unknown tool: ${tc.name}`);
  }
}

type SetFn = (updater: ((s: ChatStore) => Partial<ChatStore>) | Partial<ChatStore>) => void;

// After an AI edit applies, watch the background evaluator for the render of the
// exact tsx we sent (matched by input hash) and surface the outcome as a compact
// system message — clean (__ok__), issue counts (__issues__:), or a stuck render
// (__timeout__). Details live in the shared Issues drawer rather than flooding
// chat. It deliberately does NOT auto-fix, so an automatic full-TSX rewrite
// never silently clobbers manual PCB routing work.
function startValidationCycle(
  checkingId: string,
  set: SetFn,
  expectedInputHash: string
): void {
  // Ref-cell pattern: ensures `done` and `unsub` are visible to both the timeout
  // and subscription callbacks, no matter which fires first.
  const ctx: { unsub?: () => void; done: boolean } = { done: false };

  const cleanup = () => {
    if (ctx.done) return;
    ctx.done = true;
    ctx.unsub?.();
    clearTimeout(timeoutId);
  };

  // Every terminal outcome clears the validating flag and rewrites the checking
  // placeholder to its final state.
  const resolve = (content: string) => {
    useCircuitStore.getState().setValidating(false);
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === checkingId ? { ...m, content } : m
      ),
    }));
  };

  const timeoutId = setTimeout(() => {
    if (ctx.done) return;
    cleanup();
    resolve("__timeout__");
    toast.error("Validation didn't finish", {
      description: "The render may be stuck.",
    });
  }, VALIDATION_RENDER_TIMEOUT_MS);

  ctx.unsub = useCircuitStore.subscribe((state) => {
    if (ctx.done) return;

    // The exact tsx we applied FAILED to evaluate (compile/runtime error, or the
    // evaluator's own internal timeout). Surface the real message as a hard render
    // failure instead of waiting out the backstop and mislabeling it as a timeout.
    if (state.evalErrorHash === expectedInputHash) {
      cleanup();
      resolve("__issues__:1:0");
      return;
    }

    if (state.circuitJson === null) return;
    // Codex finding #6: don't act on a circuitJson that was produced from a
    // tsx the chat didn't see. The evaluator stamps every output with the
    // input hash; we wait for one that matches the snapshot we just sent.
    // Older render paths (RunFrame's onRenderFinished) won't set
    // evalInputHash — those paths are still trusted, so a null hash is
    // treated as "matches by default" to preserve Phase 0 behavior.
    if (state.evalInputHash !== null && state.evalInputHash !== expectedInputHash) {
      return;
    }
    // The full check pass is asynchronous and stamped with the eval version.
    // Wait for it so the compact chat summary and Issues drawer agree.
    if (state.evalIssuesVersion !== state.evalVersion) return;
    cleanup();

    const errors = state.evalIssues.filter((issue) => issue.severity === "error").length;
    const warnings = state.evalIssues.filter((issue) => issue.severity === "warning").length;
    resolve(
      errors === 0 && warnings === 0
        ? "__ok__"
        : `__issues__:${errors}:${warnings}`,
    );
  });
}

const SUMMARY_SYSTEM_PROMPT =
  "You maintain concise running notes for an in-progress PCB design session. " +
  "Capture only durable context: user preferences, design decisions and their " +
  "rationale, constraints, and approaches tried or rejected. Do NOT describe the " +
  "current circuit's components or wiring — that is always supplied separately. " +
  "Output tight bullet points, no preamble. Drop anything later turns superseded.";

// Fenced code blocks (the model's full-TSX responses) are redundant with the
// always-fresh live circuit and would balloon the summarizer's input — strip
// them so the notes distill intent, not circuit dumps.
function stripCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "[code omitted]");
}

// Module-level guard: only one background fold in flight at a time.
let isFolding = false;

// Rolling history distillation. When the raw tail overflows
// HISTORY_WINDOW + SUMMARY_BATCH non-system messages, fold the oldest
// SUMMARY_BATCH of them into `sessionNotes` and advance `summarizedCount`, so the
// tail drops back to HISTORY_WINDOW. Incremental (old notes + new turns), never a
// full re-summary, which keeps cost flat and drift low.
async function foldHistoryIfNeeded(helperModel: string): Promise<void> {
  if (isFolding) return;
  const auth = resolveChatAuth();
  if (!auth) return;
  const { messages, sessionNotes, summarizedCount } = useChatStore.getState();
  const nonSystem = messages.filter((m) => m.role !== "system");
  if (nonSystem.length - summarizedCount < HISTORY_WINDOW + SUMMARY_BATCH) return;

  const toFold = nonSystem.slice(summarizedCount, summarizedCount + SUMMARY_BATCH);
  if (toFold.length === 0) return;

  isFolding = true;
  try {
    const MAX_FOLD_CHARS = 20_000;
    const rawTurns = toFold
      .map((m) => `${m.role}: ${stripCodeBlocks(m.content)}`)
      .join("\n");
    const cappedTurns =
      rawTurns.length > MAX_FOLD_CHARS ? rawTurns.slice(0, MAX_FOLD_CHARS) : rawTurns;

    const prompt = sessionNotes
      ? `Existing notes:\n${sessionNotes}\n\nFold these older turns into the notes, keeping it concise:\n${cappedTurns}`
      : `Distill these PCB design conversation turns into concise design notes:\n${cappedTurns}`;

    // Single-turn, no tools, no thinking — use the plan-safe helper model.
    const turn = await streamTurn({
      auth,
      model: helperModel,
      system: [{ type: "text", text: SUMMARY_SYSTEM_PROMPT }],
      messages: [{ role: "user", content: prompt }],
      sessionId: useChatStore.getState().sessionId,
      traceId: ensureTraceId(),
    });
    const notes = turn.text;

    // Advance the boundary by exactly what we folded — functional update so new
    // messages that arrived during the async call aren't clobbered. If history
    // was cleared/reset during the async summary call, the folded turns are gone;
    // drop the result rather than desync the boundary past the message count
    // (which would slice the tail to empty and send no messages to the API).
    useChatStore.setState((s) => {
      const nonSystemCount = s.messages.filter((m) => m.role !== "system").length;
      const nextCount = s.summarizedCount + toFold.length;
      if (nextCount > nonSystemCount) return {};
      return { sessionNotes: notes.trim(), summarizedCount: nextCount };
    });
  } catch {
    // A failed fold is non-fatal — the un-folded turns just stay raw in the tail.
  } finally {
    isFolding = false;
  }
}

export const useChatStore = create<ChatStore>()(
  persist(
    (set, get) => ({
  messages: [],
  isStreaming: false,
  streamingEvents: [],
  chatOpen: false,
  error: null,
  errorSignInCta: false,
  sessionNotes: null,
  summarizedCount: 0,
  sessionId: crypto.randomUUID(),
  traceId: crypto.randomUUID(),
  chatWidth: CHAT_DEFAULT_WIDTH,
  chatResizing: false,

  sendMessage: async (content: string) => {
    const state = get();
    if (state.isStreaming) return;
    // Sentinel errors render as the setup CTA in the chat panel, not as an
    // error banner — keep them in lockstep with the useAiReady composer gate.
    const initialAuth = resolveChatAuth();
    if (!initialAuth) {
      set({ error: "no_account", errorSignInCta: false });
      return;
    }
    // Anonymous (signed-out) turns skip the account/plan gates entirely: the
    // proxy only accepts the free anonymous model on token-less requests and
    // enforces its own per-IP limits.
    const anonymous = initialAuth.token === null;
    const authUserId = useAuthStore.getState().user?.id ?? null;
    const { account, accountUserId, selectedModel } =
      useAccountStore.getState();
    const designModel = anonymous
      ? ANONYMOUS_MODEL
      : authUserId &&
          accountUserId === authUserId &&
          account?.plan.managedAi &&
          selectedModel &&
          account.plan.allowedModels.includes(selectedModel)
        ? selectedModel
        : null;
    if (designModel === null) {
      set({ error: "no_managed_model", errorSignInCta: false });
      return;
    }
    const helperModel = anonymous
      ? ANONYMOUS_MODEL
      : resolveHelperModel(account?.plan.allowedModels ?? [], designModel);
    // Resolved once per send so every request this turn makes — each tool
    // round, plus any datasheet helper call — lands in the same trace, even if
    // the conversation is cleared mid-flight.
    const traceId = ensureTraceId();

    const trimmedContent =
      content.length > MAX_USER_MESSAGE_LENGTH
        ? content.slice(0, MAX_USER_MESSAGE_LENGTH)
        : content;
    if (content.length > MAX_USER_MESSAGE_LENGTH) {
      toast.warning("Message truncated", {
        description: `Capped to ${MAX_USER_MESSAGE_LENGTH.toLocaleString()} characters.`,
      });
    }

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: trimmedContent,
      timestamp: Date.now(),
    };
    set((s) => ({ messages: [...s.messages, userMessage], isStreaming: true, streamingEvents: [], error: null, errorSignInCta: false }));

    const circuitState = useCircuitStore.getState();
    const currentTsx = circuitState.tsxCode;
    const components = circuitState.getComponents();
    const board = circuitState.getBoardConfig();
    const manualEdits = useEditorStore.getState().manualEdits;

    const systemPrompt = buildSystemPrompt();
    const datasheetSummaries = await fetchDatasheetSummariesForCircuit(currentTsx);
    const dynamicContext = buildDynamicContext(
      currentTsx,
      components.length,
      board.width,
      board.height,
      summarizeManualEdits(manualEdits),
      resolveActiveView(),
      resolveSelection(),
      circuitState.footprintIssues,
      datasheetSummaries,
      get().sessionNotes
    );

    // Raw tail: the full chat stays in the store (and UI scrollback), but only the
    // un-summarized tail goes to the model verbatim — everything before
    // `summarizedCount` is already distilled into sessionNotes (injected above).
    // System rows (validation markers) are dropped first so the boundary counts
    // conversation, not noise.
    const tail = get()
      .messages.filter((m) => m.role !== "system")
      .slice(get().summarizedCount);
    // Chat Completions expects the first conversational message to be from the user; if a fold
    // boundary or an error-truncated turn left an assistant message first, drop
    // leading non-user messages (doesn't touch the persisted boundary).
    while (tail.length > 0 && tail[0].role !== "user") tail.shift();
    // apiMessages is mutated in place by the loop — each tool round appends the
    // assistant's `tool_calls`, then one `role: "tool"` result per call.
    // Content is a plain string for history turns or a content-part array for
    // the cache-marked turn below. An assistant turn that ran tools replays its
    // persisted transcript (tool_calls + role:"tool" results) ahead of its
    // answer text, so the model keeps seeing its own past tool use.
    const apiMessages: OpenRouterMessage[] = [];
    for (const m of tail) {
      // Defensively drop any empty-content turn (e.g. one persisted by an older
      // build before the stuck-path guard). Replaying an empty content block
      // 400s the API and would brick every following message in the session.
      if (typeof m.content === "string" && m.content.trim() === "") continue;
      if (m.role === "assistant" && m.toolTranscript !== undefined) {
        apiMessages.push(...m.toolTranscript);
      }
      apiMessages.push({ role: m.role, content: m.content });
    }
    // Cache the conversation-history prefix: mark the last assistant message so
    // everything up to it is served from cache next turn instead of re-tokenized.
    // (The static system prompt carries its own breakpoint below.)
    const lastAssistantIdx = apiMessages.map((m) => m.role).lastIndexOf("assistant");
    if (lastAssistantIdx >= 0 && typeof apiMessages[lastAssistantIdx].content === "string") {
      apiMessages[lastAssistantIdx] = {
        role: "assistant",
        content: [
          {
            type: "text",
            text: apiMessages[lastAssistantIdx].content,
            cache_control: { type: "ephemeral" },
          },
        ],
      };
    }

    // Everything the loop appends past this point — assistant tool_calls turns,
    // their role:"tool" results, and any recovery nudge — is this turn's tool
    // transcript, persisted below so future turns replay it.
    const historyLength = apiMessages.length;

    // System blocks: the large static prompt carries the prompt-cache breakpoint
    // (must stay ≥4096 tokens — see CLAUDE.md gotcha). The dynamic per-turn
    // context follows, uncached. Built once and reused on every loop turn.
    const systemBlocks: unknown[] = [
      { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
    ];
    if (dynamicContext) {
      systemBlocks.push({ type: "text", text: dynamicContext });
    }

    let fullResponse = "";
    // The in-flight turn's chronological trail. Stream events append here in the
    // order they arrive; consecutive text/thinking deltas coalesce into the
    // trailing segment, while a tool call (or a switch between text and thinking)
    // opens a new entry — so the rendered trail mirrors the model's real sequence.
    const events: ChatEvent[] = [];
    // Real component definitions resolved inline during the loop, keyed by the
    // exact tag name the model now uses. Prepended into the final TSX below.
    const importedDefs = new Map<string, { rawTsx: string }>();
    // Working copy of the circuit TSX for the `edit_tsx` tool — the ONLY path that
    // changes the circuit. The model edits this incrementally via string-replace; we
    // commit this copy when the turn ends. Starts as the exact TSX the model sees in
    // the dynamic context, so its old_string snippets match. A ```tsx block in the
    // answer text is illustrative prose and is never applied.
    const workingTsx = { tsx: currentTsx, edited: false };
    // Tripped when the soft round backstop fires (see MAX_TOOL_ROUNDS).
    let stuck = false;

    try {
      const flushEvents = () => set({ streamingEvents: [...events] });

      // Append a text delta, coalescing into the trailing text segment so a run
      // of chunks renders as one bubble; a non-text event in between splits it.
      const appendText = (delta: string) => {
        if (delta === "") return;
        fullResponse += delta;
        const last = events[events.length - 1];
        if (last?.kind === "text") {
          events[events.length - 1] = { kind: "text", text: last.text + delta };
        } else {
          events.push({ kind: "text", text: delta });
        }
        flushEvents();
      };

      // Same coalescing for reasoning deltas — a contiguous run of thinking stays
      // one collapsible block until text or a tool call interrupts it.
      const appendThinking = (delta: string) => {
        if (delta === "") return;
        const last = events[events.length - 1];
        if (last?.kind === "thinking") {
          events[events.length - 1] = { kind: "thinking", text: last.text + delta };
        } else {
          events.push({ kind: "thinking", text: delta });
        }
        flushEvents();
      };

      const pushActivity = (
        kind: ChatActivity["kind"],
        detail: string,
        edit?: ChatActivity["edit"],
        write?: ChatActivity["write"]
      ) => {
        events.push({
          kind: "activity",
          activity: { id: crypto.randomUUID(), kind, detail, edit, write },
        });
        flushEvents();
      };

      // Live text/thinking deltas stream straight from the SSE parser (per
      // turn) via these callbacks. Tool-action rows are pushed directly by
      // dispatchTool — no transport-side tool event.
      const streamCallbacks = {
        onText: appendText,
        onThinking: appendThinking,
      };

      {
        // ─── Free-running agentic tool loop ─────────────────────────────────
        // Each iteration streams one model turn; if it finished on tool_calls we run
        // every tool call, append the assistant + tool-result turns, and loop. A
        // turn that stops WITHOUT a tool call ends the loop — except the one-time
        // recovery nudge below.
        let nudged = false;
        for (let round = 0; ; round++) {
          if (round >= MAX_TOOL_ROUNDS) {
            stuck = true;
            break;
          }
          // Re-resolved every round so the scheduled access-token refresh is
          // picked up mid-loop; signing out aborts cleanly instead of sending a
          // dead token. A turn also never flips between token-bearing and
          // anonymous mid-flight — a signed-in turn must not degrade to a
          // token-less request (and vice versa), so any transition aborts.
          const auth = resolveChatAuth();
          if (!auth || (auth.token === null) !== anonymous) {
            throw new Error("auth_lost");
          }
          const turn = await streamTurn(
            {
              auth,
              model: designModel,
              system: systemBlocks,
              messages: apiMessages,
              tools: CHAT_TOOLS,
              thinkingEffort: DESIGN_EFFORT,
              sessionId: get().sessionId,
              traceId,
            },
            streamCallbacks
          );
          if (turn.finishReason === "tool_calls" && turn.toolCalls.length > 0) {
            apiMessages.push(assistantMsgFromTurn(turn));
            // Every tool call MUST get a matching result message or the next
            // request 400s. Guard rejected backends so all IDs are answered.
            const results = await Promise.all(
              turn.toolCalls.map((tc) =>
                dispatchTool(
                  tc,
                  importedDefs,
                  auth,
                  helperModel,
                  traceId,
                  pushActivity,
                  workingTsx,
                ).catch((e) =>
                  toolResult(tc.id, `Tool ${tc.name} failed: ${String(e)}`)
                ),
              )
            );
            apiMessages.push(...results);
            continue;
          }

          // Turn ended without a tool call. If it neither edited the circuit nor
          // said anything (model gathered info but never finished), nudge once —
          // tools stay on so it can finish via edit_tsx. Skip when edit_tsx
          // already produced a working circuit: there's nothing to recover.
          if (!nudged && fullResponse.trim() === "" && !workingTsx.edited) {
            nudged = true;
            // Keep any thinking blocks the turn produced so the nudge reads as a
            // continuation; never push a truly empty assistant turn (it would 400).
            if (
              turn.text !== "" ||
              turn.reasoning.text !== "" ||
              turn.reasoning.details.length > 0
            ) {
              apiMessages.push(assistantMsgFromTurn(turn));
            }
            apiMessages.push({ role: "user", content: RECOVERY_PROMPT });
            continue;
          }
          break;
        }
      }

      // Only persist a non-empty assistant turn. On the stuck / empty-recovery
      // paths fullResponse is "", and a persisted empty-content assistant message
      // would be replayed next turn as an empty text block and 400 the API,
      // bricking the rest of the session. Reset streaming state either way.
      //
      // Exception: a pure edit_tsx turn that emitted no prose still changed the
      // circuit and carries an activity trail (the old/new strings) worth keeping
      // in history — synthesize a short summary so it persists. Gated on !stuck so
      // the unfinished-backstop path (which doesn't apply anything) stays empty.
      const turnText =
        fullResponse.trim() !== ""
          ? fullResponse
          : !stuck && workingTsx.edited
            ? "Updated the circuit."
            : "";
      // Captured here so the resulting circuit (applied below) can be stamped
      // onto this exact message for `restoreToMessage`. null on the empty
      // (stuck / no-output) paths where no assistant message is persisted.
      let assistantMessageId: string | null = null;
      if (turnText !== "") {
        // The rounds this turn's loop appended, reduced to their replayable
        // core (see toPersistedTranscript) — persisted so the next sendMessage
        // replays them and the model remembers what it searched, imported, and
        // edited (not just its answer prose).
        const toolTranscript = toPersistedTranscript(
          apiMessages.slice(historyLength)
        );
        assistantMessageId = crypto.randomUUID();
        const assistantMessage: ChatMessage = {
          id: assistantMessageId,
          role: "assistant",
          content: turnText,
          timestamp: Date.now(),
          events: events.length > 0 ? events : undefined,
          toolTranscript: toolTranscript.length > 0 ? toolTranscript : undefined,
        };
        set((s) => ({
          messages: [...s.messages, assistantMessage],
          isStreaming: false,
          streamingEvents: [],
        }));
      } else {
        set({ isStreaming: false, streamingEvents: [] });
      }

      // Fire-and-forget: once the raw tail overflows the window, distill its
      // oldest turns into the rolling notes. Doesn't block the next message.
      void foldHistoryIfNeeded(helperModel);

      // Soft backstop tripped — surface that the assistant got stuck rather than
      // apply a half-finished circuit.
      if (stuck) {
        const stuckMsg = `The assistant kept calling tools without finishing (stopped after ${MAX_TOOL_ROUNDS} rounds). Nothing was applied — try a more specific or smaller request.`;
        set({ error: stuckMsg });
        toast.error("Chat got stuck", { description: stuckMsg });
        return;
      }

      // edit_tsx and write_tsx are the ONLY paths that change the circuit. A ```tsx
      // block in the answer text is illustrative prose now — never extracted, never
      // applied — so the working copy is the sole source of an applied change.
      let tsxCode: string | null = workingTsx.edited ? workingTsx.tsx : null;

      // Prepend the real imported component definitions. The model used the exact
      // tag name import_component returned, so the key matches directly — no
      // rename dance and no post-turn race. Footprint meta was already stamped at
      // import time; only inject defs the final TSX actually references.
      if (tsxCode && importedDefs.size > 0) {
        for (const [componentName, { rawTsx }] of importedDefs) {
          if (!tsxCode.includes(`<${componentName}`)) continue;
          const alreadyDefined =
            tsxCode.includes(`const ${componentName}`) ||
            tsxCode.includes(`function ${componentName}`);
          if (alreadyDefined) continue;
          const cleaned = cleanImportedTsx(rawTsx);
          const idx = tsxCode.indexOf("export default");
          if (idx >= 0) {
            tsxCode = tsxCode.slice(0, idx) + cleaned + "\n\n" + tsxCode.slice(idx);
          }
        }
      }

      if (tsxCode) {
        // Structural parse check before applying — surfaces malformed TSX immediately
        try {
          extractComponents(tsxCode);
        } catch (parseErr) {
          set({ error: `Circuit code has a syntax error and was not applied: ${String(parseErr).slice(0, 120)}` });
          tsxCode = null;
        }
      }

      if (tsxCode) {
        // `false` means the model re-emitted the current circuit unchanged — a
        // no-op edit. Nothing changed, so there's nothing to validate; skip the
        // cycle entirely. (Running it would hang: no fresh eval fires for an
        // identical tsx, so the subscription never resolves before its backstop.)
        const applied = useCircuitStore.getState().applyAiEdit(tsxCode);
        if (applied) {
          useCircuitStore.getState().setValidating(true);
          const checkingId = crypto.randomUUID();
          set((s) => ({
            messages: [
              ...s.messages,
              {
                id: checkingId,
                role: "system" as const,
                content: "__checking__",
                timestamp: Date.now(),
              },
            ],
          }));
          // Hash the *post-applyAiEdit* tsx (which may have had keys
          // re-injected) plus the current sidecar — this is the input the
          // evaluator will see.
          const expectedTsx = useCircuitStore.getState().tsxCode;
          const expectedEdits = useEditorStore.getState().manualEdits;
          const expectedHash = hashInput(expectedTsx, expectedEdits);
          startValidationCycle(checkingId, set, expectedHash);
        }
      }

      // Stamp this turn's resulting circuit onto its assistant message so the
      // user can later rewind the conversation here and recover the exact TSX
      // (see restoreToMessage). Captured after applyAiEdit so an edit this turn
      // is reflected; a no-op / Q&A turn snapshots the unchanged circuit. Patched
      // by id because the message was pushed above before the edit applied.
      if (assistantMessageId) {
        const snapshotTsx = useCircuitStore.getState().tsxCode;
        const id = assistantMessageId;
        // Stamp this turn's snapshot, then immediately cap so only the most
        // recent MAX_SNAPSHOTS turns retain one — keeps the in-memory store and
        // its persisted copy bounded no matter how long the session runs.
        set((s) => ({
          messages: capSnapshots(
            s.messages.map((m) =>
              m.id === id ? { ...m, tsxSnapshot: snapshotTsx } : m
            ),
            MAX_SNAPSHOTS
          ),
        }));
      }
    } catch (err) {
      console.error("[chat] sendMessage failed:", err);
      const errorStr = String(err);

      if (fullResponse) {
        const interruptNote =
          "\n\n---\n*[Response interrupted — connection or API error]*";
        // Rounds are appended atomically (assistant tool_calls + all results
        // together), so even on a mid-turn failure the recorded transcript is
        // complete and safe to replay.
        const toolTranscript = toPersistedTranscript(
          apiMessages.slice(historyLength)
        );
        const partialMessage: ChatMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: fullResponse + interruptNote,
          timestamp: Date.now(),
          events: [...events, { kind: "text", text: interruptNote }],
          toolTranscript: toolTranscript.length > 0 ? toolTranscript : undefined,
        };
        set((s) => ({ messages: [...s.messages, partialMessage] }));
      }

      // ChatTransportError keeps Retry-After; read it structurally so this
      // works whether or not the transport class itself crossed the mock/seam.
      const retryAfter =
        typeof err === "object" &&
        err !== null &&
        typeof (err as { retryAfter?: unknown }).retryAfter === "string"
          ? (err as { retryAfter: string }).retryAfter
          : undefined;
      const { message: errorMessage, signInCta } = friendlyChatError(
        errorStr,
        anonymous,
        retryAfter
      );

      // Anonymous limit errors render as a sign-in prompt in the panel — a
      // plain error toast on top would bury the CTA.
      if (!signInCta) {
        toast.error("Chat error", { description: errorMessage });
      }

      set({
        isStreaming: false,
        streamingEvents: [],
        error: errorMessage,
        errorSignInCta: signInCta,
      });
    }
  },

  restoreToMessage: (messageId) => {
    const state = get();
    // Streaming, a validation/auto-fix cycle, and the background history fold all
    // mutate circuit + chat state asynchronously; rewinding mid-flight would race
    // those set() callbacks — a resolving fold would re-stamp summarizedCount /
    // sessionNotes onto turns the rewind just dropped. Stay inert until the turn
    // fully settles.
    if (state.isStreaming || isFolding || useCircuitStore.getState().isValidating)
      return;

    const idx = state.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;
    const target = state.messages[idx];
    // Only assistant turns carry a snapshot; nothing to restore otherwise.
    if (target.role !== "assistant" || target.tsxSnapshot === undefined) return;

    // Restore the circuit to the snapshot taken right after this turn. Routed
    // through setTsxCode so the restore lands in the circuit's own history
    // (undoable with Cmd+Z) and triggers a fresh eval/render of the old code.
    useCircuitStore.getState().setTsxCode(target.tsxSnapshot);

    // Rewind the conversation: keep up to and including this turn, drop every
    // later message (subsequent turns + trailing validation rows).
    const kept = state.messages.slice(0, idx + 1);
    const keptNonSystem = kept.filter((m) => m.role !== "system").length;
    // If the rewind landed before the summarized boundary, the rolling notes now
    // describe turns that no longer exist — drop them so the shorter tail is sent
    // raw and in full. Otherwise the boundary still lines up; keep it.
    const boundaryValid = state.summarizedCount <= keptNonSystem;
    set({
      messages: kept,
      streamingEvents: [],
      error: null,
      sessionNotes: boundaryValid ? state.sessionNotes : null,
      summarizedCount: boundaryValid ? state.summarizedCount : 0,
    });
  },

  toggleChat: () => set((s) => ({ chatOpen: !s.chatOpen })),
  setChatOpen: (open) => set({ chatOpen: open }),
  setChatWidth: (width) => set({ chatWidth: width }),
  setChatResizing: (resizing) => set({ chatResizing: resizing }),

  clearHistory: () =>
    set({
      messages: [],
      streamingEvents: [],
      error: null,
      errorSignInCta: false,
      sessionNotes: null,
      summarizedCount: 0,
      sessionId: crypto.randomUUID(),
      traceId: crypto.randomUUID(),
    }),
  clearError: () => set({ error: null, errorSignInCta: false }),
    }),
    {
      name: "cherryblossom_chat_history",
      partialize: (state) => ({
        // Persist snapshots for at most the recent MAX_SNAPSHOTS turns. The
        // in-memory store is already capped at the write site, so this is
        // belt-and-suspenders — it also self-heals any over-sized state left by
        // an earlier build on the next write.
        messages: capSnapshots(state.messages, MAX_SNAPSHOTS),
        sessionNotes: state.sessionNotes,
        summarizedCount: state.summarizedCount,
        sessionId: state.sessionId,
        traceId: state.traceId,
        chatWidth: state.chatWidth,
      }),
    }
  )
);
