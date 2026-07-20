import { create } from "zustand";
import { persist } from "zustand/middleware";
import { toast } from "sonner";
import type { AnyCircuitElement } from "circuit-json";
import { useCircuitStore, cleanImportedTsx } from "./circuitStore";
import { useEditorStore } from "../editor/state/editorStore";
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
import { useAccountStore } from "./accountStore";
import { listCachedDatasheets } from "../utils/datasheets";
import {
  buildCandidateRepairPrompt,
  validateCandidateTsx,
  type CandidateValidationResult,
} from "../ai/candidateValidation";
import {
  applySemanticCircuitTool,
  isSemanticCircuitTool,
} from "../ai/semanticCircuitTools";
import { buildRuntimePcbSkillContext } from "../ai/runtimePcbSkills";

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
  kind:
    | "search"
    | "footprint"
    | "datasheet"
    | "import"
    | "edit"
    | "write"
    | "semantic"
    | "validation";
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
  // Rolling distillation of older turns (decisions/preferences/constraints) that
  // have scrolled out of the raw window, plus a count of how many non-system
  // messages it already covers. Together they form the "summarized prefix".
  sessionNotes: string | null;
  summarizedCount: number;
  // Stable, random routing key for OpenRouter provider/cache affinity.
  // It contains no user data and rotates whenever chat history is cleared.
  sessionId: string;

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
const MAX_CANDIDATE_REPAIR_ATTEMPTS = 2;
const MAX_WORKFLOW_CONTINUATIONS = 3;

const DIRECT_EDIT_INTENT =
  /\b(add|build|create|design|make|implement|edit|change|update|replace|remove|delete|connect|wire|fix|repair|rewrite)\b/i;
const INFORMATIONAL_PREFIX = /^(how|why|what|where|when)\b/i;
const HOW_TO_REQUEST = /\b(tell|show|explain)\s+me\s+how\b/i;
const RESEARCH_REQUIRED_TAGS = new Set(["chip", "opamp"]);

interface ImportedComponentDef {
  rawTsx: string;
  lcscId: string;
}

interface ComponentResearchEvidence {
  searched: boolean;
  datasheet: boolean;
  footprint: boolean;
  importedTags: Set<string>;
}

function isDirectCircuitEditRequest(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (INFORMATIONAL_PREFIX.test(trimmed) || HOW_TO_REQUEST.test(trimmed)) {
    return false;
  }
  return DIRECT_EDIT_INTENT.test(trimmed);
}

function isClarifyingQuestion(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.endsWith("?") &&
    /\b(which|what|where|how many|voltage|current|package|size|frequency|speed|interface)\b/i.test(
      trimmed
    )
  );
}

function isResearchRequiredTag(tag: string): boolean {
  return (
    RESEARCH_REQUIRED_TAGS.has(tag) ||
    (tag.length > 0 && tag[0] === tag[0].toUpperCase())
  );
}

function normalizeLcscId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return /^C\d+$/.test(normalized) ? normalized : null;
}

function researchEvidenceFor(
  researchByLcsc: Map<string, ComponentResearchEvidence>,
  lcscId: string,
): ComponentResearchEvidence {
  const existing = researchByLcsc.get(lcscId);
  if (existing) return existing;
  const created: ComponentResearchEvidence = {
    searched: false,
    datasheet: false,
    footprint: false,
    importedTags: new Set<string>(),
  };
  researchByLcsc.set(lcscId, created);
  return created;
}

function recordResearchToolResult(
  toolCall: ChatToolCall,
  content: string,
  importedDefs: ReadonlyMap<string, ImportedComponentDef>,
  researchByLcsc: Map<string, ComponentResearchEvidence>,
): void {
  if (toolCall.name === "search_jlcpcb" && content.startsWith("Found ")) {
    for (const match of content.matchAll(/\bC\d+\b/gi)) {
      researchEvidenceFor(researchByLcsc, match[0].toUpperCase()).searched = true;
    }
    return;
  }

  const lcscId = normalizeLcscId(toolCall.input?.lcsc_id);
  if (!lcscId) return;
  const evidence = researchEvidenceFor(researchByLcsc, lcscId);
  if (toolCall.name === "lookup_footprint" && content.startsWith("Best match:")) {
    evidence.footprint = true;
    return;
  }
  if (
    toolCall.name === "fetch_datasheet" &&
    content.startsWith("Datasheet summary for ")
  ) {
    // A returned summary satisfies the research gate even when the datasheet
    // was "Evidence: unavailable". EasyEDA surfaces no datasheet URL for many
    // common parts (e.g. TP4056/NE555/LIS3DH), so requiring VERIFIED evidence
    // made the gate unsatisfiable for those ICs: the model looped on
    // fetch_datasheet until the workflow-continuation budget ran out and the
    // fully-built circuit was discarded. The model has done its due diligence
    // by fetching; it cannot verify specs the source doesn't host. The
    // unverified summary still reaches the model's context — only the commit
    // gate is relaxed, not the evidence grounding.
    evidence.datasheet = true;
    return;
  }
  if (toolCall.name === "import_component" && content.startsWith("Imported ")) {
    for (const [tag, imported] of importedDefs) {
      if (imported.lcscId === lcscId) evidence.importedTags.add(tag);
    }
  }
}

function isCircuitMutatingTool(name: string): boolean {
  return (
    name === "edit_tsx" ||
    name === "write_tsx" ||
    (isSemanticCircuitTool(name) && name !== "inspect_circuit")
  );
}

function successfulCircuitMutation(name: string, content: string): boolean {
  if (name === "edit_tsx") return content.startsWith("Edit applied");
  if (name === "write_tsx") return content.startsWith("Circuit rewritten.");
  if (isSemanticCircuitTool(name) && name !== "inspect_circuit") {
    return !content.startsWith("Error:");
  }
  return false;
}

function missingComponentResearch(
  baselineTsx: string,
  candidateTsx: string,
  importedDefs: ReadonlyMap<string, ImportedComponentDef>,
  researchByLcsc: ReadonlyMap<string, ComponentResearchEvidence>,
): string[] {
  const baselineComponents = extractComponents(baselineTsx);
  const baselineByName = new Map(
    baselineComponents.map((component) => [component.name, component])
  );
  const baselineTags = new Set(
    baselineComponents.map((component) => component.elementTag),
  );
  const newComplexComponents = extractComponents(candidateTsx).filter(
    (component) => {
      const baseline = baselineByName.get(component.name);
      return (
        isResearchRequiredTag(component.elementTag) &&
        (!baseline || baseline.elementTag !== component.elementTag)
      );
    }
  );
  if (newComplexComponents.length === 0) return [];

  const missing: string[] = [];
  for (const component of newComplexComponents) {
    const { name, elementTag } = component;
    if (
      !RESEARCH_REQUIRED_TAGS.has(elementTag) &&
      baselineTags.has(elementTag)
    ) {
      continue;
    }
    if (RESEARCH_REQUIRED_TAGS.has(elementTag)) {
      missing.push(
        `${name}: replace the generic ${elementTag} with the exact imported JSX tag`,
      );
      continue;
    }
    const imported = importedDefs.get(elementTag);
    if (!imported) {
      missing.push(
        `${name} (${elementTag}): import_component must import this exact IC tag`,
      );
      continue;
    }
    const evidence = researchByLcsc.get(imported.lcscId);
    const label = `${name} (${elementTag}, ${imported.lcscId})`;
    if (!evidence?.searched) {
      missing.push(`${label}: search_jlcpcb must return this LCSC part`);
    }
    if (!evidence?.datasheet) {
      missing.push(`${label}: fetch_datasheet must return verified datasheet evidence`);
    }
    if (!evidence?.footprint) {
      missing.push(`${label}: lookup_footprint must confirm this package family`);
    }
    if (!evidence?.importedTags.has(elementTag)) {
      missing.push(`${label}: import_component must successfully import this exact tag`);
    }
  }
  return missing;
}

// One-time nudge when a turn ends having neither edited the circuit
// nor produced any answer text — almost always the model stopping mid-task after
// some tool calls. Re-prompted with tools still on so it can actually finish.
const RECOVERY_PROMPT =
  "You ended your turn without changing the circuit or answering. If the request needs a " +
  "circuit change, make it now with semantic circuit tools when possible (use edit_tsx for " +
  "advanced structures or write_tsx for an empty/wholesale rewrite), then add a one-line summary. " +
  "If it was a question, just answer it.";

const AI_SETUP_ERRORS = new Set(["no_account", "no_managed_model"]);

export function isAiSetupError(error: string | null): boolean {
  return error !== null && AI_SETUP_ERRORS.has(error);
}

const EXECUTION_CONTINUATION_PROMPT =
  "The user requested an actual circuit change, so a prose plan is not completion. Continue now with " +
  "the available tools and finish the circuit. For every new non-trivial IC, first call search_jlcpcb, " +
  "then lookup_footprint, fetch_datasheet, and import_component, and place the exact returned JSX tag. Use semantic " +
  "circuit tools for the remaining parts and wiring. Include finish_circuit_edit alongside the final mutation " +
  "once every requested change is complete. Only stop without an edit if one indispensable " +
  "user decision is missing; in that case ask exactly one concrete question.";

function researchContinuationPrompt(missing: readonly string[]): string {
  return (
    "The draft adds a non-trivial IC but its component-research workflow is incomplete, so it cannot " +
    "be applied yet. Continue using tools now. Missing requirements:\n- " +
    missing.join("\n- ") +
    "\nDo not merely describe these steps. Execute them, update the draft to use the imported part, then finish."
  );
}

// Resolve the credential for the next OpenRouter call. Read fresh at every call
// so a mid-turn token refresh (or sign-out) takes effect on the next request.
export function resolveChatAuth(): OpenRouterAuth | null {
  const { status, accessToken } = useAuthStore.getState();
  if (status !== "signedIn" || !accessToken) return null;
  return {
    token: accessToken,
    url: OPENROUTER_CHAT_COMPLETIONS_URL,
  };
}

// Keep `tsxSnapshot` only on the most recent `max` assistant turns that carry
// one; strip it from any older turn so memory and persistence stay bounded.
// Pure, and returns the SAME array reference when nothing needs stripping — safe
// to call on every snapshot write and inside the persist partializer.
export function capSnapshots(
  messages: ChatMessage[],
  max: number
): ChatMessage[] {
  // Walk newest→oldest, collecting the indices that currently hold a snapshot.
  const snapshotIdxNewestFirst: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.tsxSnapshot !== undefined) {
      snapshotIdxNewestFirst.push(i);
    }
  }
  if (snapshotIdxNewestFirst.length <= max) return messages;
  // Everything past the newest `max` is stale and loses its snapshot.
  const stale = new Set(snapshotIdxNewestFirst.slice(max));
  return messages.map((m, i) => {
    if (!stale.has(i)) return m;
    const { tsxSnapshot: _drop, ...rest } = m;
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
// proxy plan gates additionally expose `error.type`.
function friendlyChatError(errorStr: string): string {
  if (errorStr.includes("auth_lost")) {
    return "You were signed out before the response finished. Sign in again in Settings → Account.";
  }
  if (errorStr.includes("api_error:")) {
    return errorStr.replace(/.*api_error:/, "");
  }
  const httpMatch = errorStr.match(/(\d{3}):([\s\S]*)/);
  if (!httpMatch) {
    return "Connection error. Check your network and try again.";
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
    return "Your session has expired. Sign in again in Settings → Account.";
  }
  // Managed-plan gates: the server's message names the plan and model — show it.
  if (type === "plan_required" || type === "model_not_allowed") {
    return message ?? "Your plan doesn't include this model. See Settings → Account.";
  }
  if (status === 429) {
    return "You've hit your plan's usage limit — wait a bit and try again.";
  }
  return message ?? "Connection error. Check your network and try again.";
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

function materializeCandidateTsx(
  draftTsx: string,
  importedDefs: ReadonlyMap<string, ImportedComponentDef>,
): string {
  let candidate = draftTsx;
  for (const [componentName, { rawTsx }] of importedDefs) {
    if (!candidate.includes(`<${componentName}`)) continue;
    const alreadyDefined =
      candidate.includes(`const ${componentName}`) ||
      candidate.includes(`function ${componentName}`);
    if (alreadyDefined) continue;
    const cleaned = cleanImportedTsx(rawTsx);
    const idx = candidate.indexOf("export default");
    if (idx >= 0) {
      candidate =
        candidate.slice(0, idx) + cleaned + "\n\n" + candidate.slice(idx);
    }
  }
  return candidate;
}

const asString = (v: unknown): string =>
  typeof v === "string" ? v : v == null ? "" : String(v);

// Run one tool call and return its OpenRouter tool message. `import_component`
// resolves the real component definition INLINE here (before the model's next
// turn) — so the model learns the real tag name and any failure immediately,
// instead of the old fake-synchronous predict-a-name-then-patch-after race.
async function dispatchTool(
  tc: ChatToolCall,
  importedDefs: Map<string, ImportedComponentDef>,
  auth: OpenRouterAuth,
  helperModel: string,
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
  if (isSemanticCircuitTool(tc.name)) {
    const result = applySemanticCircuitTool(workingTsx.tsx, tc.name, input);
    if (result.ok) {
      if (result.edited) {
        workingTsx.tsx = result.tsx;
        workingTsx.edited = true;
      }
      pushActivity("semantic", result.activity);
    }
    return toolResult(tc.id, result.content);
  }
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
    case "finish_circuit_edit":
      return toolResult(
        tc.id,
        "Completion marker received. The client will commit only if this batch changed the circuit, satisfied required component research, and passes validation.",
      );
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
        await fetchDatasheet(auth, helperModel, lcsc, mpn || undefined),
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
        importedDefs.set(def.componentName, {
          rawTsx: def.rawTsx,
          lcscId: lcsc.toUpperCase(),
        });
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
  sessionNotes: null,
  summarizedCount: 0,
  sessionId: crypto.randomUUID(),
  chatWidth: CHAT_DEFAULT_WIDTH,
  chatResizing: false,

  sendMessage: async (content: string) => {
    const state = get();
    if (state.isStreaming) return;
    // Sentinel errors render as the setup CTA in the chat panel, not as an
    // error banner — keep them in lockstep with the useAiReady composer gate.
    if (!resolveChatAuth()) {
      set({ error: "no_account" });
      return;
    }
    const authUserId = useAuthStore.getState().user?.id ?? null;
    const { account, accountUserId, selectedModel } =
      useAccountStore.getState();
    const designModel =
      authUserId &&
      accountUserId === authUserId &&
      account?.plan.managedAi &&
      selectedModel &&
      account.plan.allowedModels.includes(selectedModel)
        ? selectedModel
        : null;
    if (designModel === null) {
      set({ error: "no_managed_model" });
      return;
    }
    const helperModel = resolveHelperModel(
      account?.plan.allowedModels ?? [],
      designModel,
    );

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
    set((s) => ({ messages: [...s.messages, userMessage], isStreaming: true, streamingEvents: [], error: null }));

    const circuitState = useCircuitStore.getState();
    const currentTsx = circuitState.tsxCode;
    const components = circuitState.getComponents();
    const board = circuitState.getBoardConfig();
    const manualEdits = useEditorStore.getState().manualEdits;
    const activeView = resolveActiveView();

    const systemPrompt = buildSystemPrompt();
    const datasheetSummaries = await fetchDatasheetSummariesForCircuit(currentTsx);
    const dynamicContext = buildDynamicContext(
      currentTsx,
      components.length,
      board.width,
      board.height,
      summarizeManualEdits(manualEdits),
      activeView,
      resolveSelection(),
      circuitState.footprintIssues,
      datasheetSummaries,
      get().sessionNotes,
      circuitState.evalIssues
    );
    const runtimeSkillContext = buildRuntimePcbSkillContext({
      prompt: trimmedContent,
      activeView,
      componentTags: components.map((component) => component.elementTag),
    });

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
    // the cache-marked turn below.
    const apiMessages: OpenRouterMessage[] = tail
      // Defensively drop any empty-content turn (e.g. one persisted by an older
      // build before the stuck-path guard). Replaying an empty content block
      // 400s the API and would brick every following message in the session.
      .filter((m) => !(typeof m.content === "string" && m.content.trim() === ""))
      .map((m) => ({ role: m.role, content: m.content }));
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

    // System blocks: the large static prompt carries the prompt-cache breakpoint
    // (must stay ≥4096 tokens — see CLAUDE.md gotcha). The dynamic per-turn
    // context follows, uncached. Built once and reused on every loop turn.
    const systemBlocks: unknown[] = [
      { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
    ];
    if (dynamicContext) {
      systemBlocks.push({ type: "text", text: dynamicContext });
    }
    if (runtimeSkillContext) {
      systemBlocks.push({ type: "text", text: runtimeSkillContext });
    }

    let fullResponse = "";
    // The in-flight turn's chronological trail. Stream events append here in the
    // order they arrive; consecutive text/thinking deltas coalesce into the
    // trailing segment, while a tool call (or a switch between text and thinking)
    // opens a new entry — so the rendered trail mirrors the model's real sequence.
    const events: ChatEvent[] = [];
    // Real component definitions resolved inline during the loop, keyed by the
    // exact tag name the model now uses. Prepended into the final TSX below.
    const importedDefs = new Map<string, ImportedComponentDef>();
    // Working copy of the circuit TSX for semantic and raw editing tools. They
    // mutate this draft only; we validate and commit it once the turn ends. It
    // starts as the exact TSX shown in dynamic context, so raw edit anchors match.
    // A ```tsx block in answer text remains illustrative and is never applied.
    const workingTsx = { tsx: currentTsx, edited: false };
    const directEditRequest = isDirectCircuitEditRequest(trimmedContent);
    const researchByLcsc = new Map<string, ComponentResearchEvidence>();
    // Tripped when the soft round backstop fires (see MAX_TOOL_ROUNDS).
    let stuck = false;
    let validatedCandidate: CandidateValidationResult | null = null;
    let rejectedCandidate: CandidateValidationResult | null = null;
    let candidateRepairAttempts = 0;
    let workflowContinuations = 0;
    let forceToolNextTurn = directEditRequest;
    let incompleteWorkflow: string | null = null;
    let completionSummary: string | null = null;

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
          // dead token.
          const auth = resolveChatAuth();
          if (!auth) throw new Error("auth_lost");
          const toolChoice = forceToolNextTurn ? "required" : undefined;
          forceToolNextTurn = false;
          const turn = await streamTurn(
            {
              auth,
              model: designModel,
              system: systemBlocks,
              messages: apiMessages,
              tools: CHAT_TOOLS,
              toolChoice,
              thinkingEffort: DESIGN_EFFORT,
              sessionId: get().sessionId,
            },
            streamCallbacks
          );
          let assistantTurnRecorded = false;
          const recordAssistantTurn = () => {
            if (assistantTurnRecorded) return;
            if (
              turn.text !== "" ||
              turn.toolCalls.length > 0 ||
              turn.reasoning.text !== "" ||
              turn.reasoning.details.length > 0
            ) {
              apiMessages.push(assistantMsgFromTurn(turn));
              assistantTurnRecorded = true;
            }
          };
          if (turn.finishReason === "tool_calls" && turn.toolCalls.length > 0) {
            recordAssistantTurn();
            // Every tool call MUST get a matching result message or the next
            // request 400s. Guard rejected backends so all IDs are answered.
            const results = await Promise.all(
              turn.toolCalls.map((tc) =>
                dispatchTool(
                  tc,
                  importedDefs,
                  auth,
                  helperModel,
                  pushActivity,
                  workingTsx,
                ).catch((e) =>
                  toolResult(tc.id, `Tool ${tc.name} failed: ${String(e)}`)
                ),
              )
            );
            turn.toolCalls.forEach((toolCall, index) => {
              const resultContent = results[index]?.content;
              const content = typeof resultContent === "string" ? resultContent : "";
              recordResearchToolResult(
                toolCall,
                content,
                importedDefs,
                researchByLcsc,
              );
            });
            apiMessages.push(...results);
            const finishCall = turn.toolCalls.find(
              (toolCall) => toolCall.name === "finish_circuit_edit",
            );
            const mutationCalls = turn.toolCalls
              .map((toolCall, index) => {
                const resultContent = results[index]?.content;
                return {
                  toolCall,
                  content:
                    typeof resultContent === "string" ? resultContent : "",
                };
              })
              .filter(({ toolCall }) => isCircuitMutatingTool(toolCall.name));
            const batchMutationsSucceeded =
              mutationCalls.length > 0 &&
              mutationCalls.every(({ toolCall, content }) =>
                successfulCircuitMutation(toolCall.name, content)
              );
            // Commit when the model signals completion AND the circuit has
            // actually changed — either by a mutation in THIS batch (the
            // one-turn fast path) or by edits accumulated over prior rounds.
            // Weaker models (e.g. the free-plan model) reliably call
            // finish_circuit_edit as a standalone final turn rather than
            // batching it with their last mutation; requiring same-batch left
            // their fully-built circuit uncommitted, so they spiralled into
            // redundant tool calls until the MAX_TOOL_ROUNDS backstop and
            // nothing was applied. Falling through to validation whenever edits
            // exist rescues that circuit; missing component research is still
            // enforced by the validation block below.
            const readyToCommit =
              !!finishCall && (batchMutationsSucceeded || workingTsx.edited);
            if (!readyToCommit) {
              if (finishCall) completionSummary = null;
              continue;
            }
            const requestedSummary = asString(finishCall.input?.summary).trim();
            if (requestedSummary !== "") completionSummary = requestedSummary;
          }

          if (
            directEditRequest &&
            !workingTsx.edited &&
            !isClarifyingQuestion(turn.text)
          ) {
            if (workflowContinuations >= MAX_WORKFLOW_CONTINUATIONS) {
              incompleteWorkflow =
                "The assistant stopped before making the requested circuit change. Nothing was applied.";
              break;
            }
            workflowContinuations += 1;
            recordAssistantTurn();
            apiMessages.push({ role: "user", content: EXECUTION_CONTINUATION_PROMPT });
            forceToolNextTurn = true;
            continue;
          }

          // Turn ended without a tool call. If it neither edited the circuit nor
          // said anything (model gathered info but never finished), nudge once —
          // tools stay on so it can finish the requested work. Skip when a
          // mutating tool already produced a working circuit: nothing to recover.
          if (!nudged && fullResponse.trim() === "" && !workingTsx.edited) {
            nudged = true;
            // Keep any thinking blocks the turn produced so the nudge reads as a
            // continuation; never push a truly empty assistant turn (it would 400).
            recordAssistantTurn();
            apiMessages.push({ role: "user", content: RECOVERY_PROMPT });
            continue;
          }

          if (workingTsx.edited) {
            const candidateTsx = materializeCandidateTsx(
              workingTsx.tsx,
              importedDefs,
            );
            const missingResearch = missingComponentResearch(
              currentTsx,
              candidateTsx,
              importedDefs,
              researchByLcsc,
            );
            if (missingResearch.length > 0) {
              completionSummary = null;
              if (workflowContinuations >= MAX_WORKFLOW_CONTINUATIONS) {
                incompleteWorkflow =
                  "The assistant could not finish component research for the new IC. Nothing was applied.";
                break;
              }
              workflowContinuations += 1;
              recordAssistantTurn();
              apiMessages.push({
                role: "user",
                content: researchContinuationPrompt(missingResearch),
              });
              forceToolNextTurn = true;
              continue;
            }
            const validation = await validateCandidateTsx({
              candidateTsx,
              manualEdits,
              baselineIssues: circuitState.evalIssues,
            });
            if (!validation.ok) {
              if (
                candidateRepairAttempts < MAX_CANDIDATE_REPAIR_ATTEMPTS
              ) {
                completionSummary = null;
                candidateRepairAttempts += 1;
                workingTsx.tsx = candidateTsx;
                recordAssistantTurn();
                events.push({
                  kind: "activity",
                  activity: {
                    id: crypto.randomUUID(),
                    kind: "validation",
                    detail: `Repair ${candidateRepairAttempts}/${MAX_CANDIDATE_REPAIR_ATTEMPTS}`,
                  },
                });
                flushEvents();
                apiMessages.push({
                  role: "user",
                  content: buildCandidateRepairPrompt(validation),
                });
                continue;
              }
              // A candidate with circuitJson rendered successfully. Preserve it
              // after repairs are exhausted so DRC/layout issues remain visible
              // in the editor; syntax/runtime evaluation failures have no render
              // and remain fail-closed.
              if (validation.circuitJson !== undefined) {
                validatedCandidate = validation;
              } else {
                rejectedCandidate = validation;
              }
              break;
            }
            validatedCandidate = validation;
          }
          break;
        }
      }

      if (rejectedCandidate) {
        const details =
          rejectedCandidate.evaluationError ??
          rejectedCandidate.newErrors
            .slice(0, 2)
            .map((issue) => issue.message)
            .join(" ");
        const message =
          `The draft still failed validation after ${MAX_CANDIDATE_REPAIR_ATTEMPTS} repair attempts. ` +
          `Nothing was applied.${details ? ` ${details}` : ""}`;
        set({ isStreaming: false, streamingEvents: [], error: message });
        toast.error("Draft was not applied", { description: message });
        return;
      }

      // The draft was produced from currentTsx. If the user, undo/redo, or
      // another editor action changed the live circuit while the model or
      // validator was running, applying this stale draft would overwrite newer
      // work. Compare immediately before the synchronous commit path.
      if (
        workingTsx.edited &&
        useCircuitStore.getState().tsxCode !== currentTsx
      ) {
        const message =
          "The circuit changed while the assistant was working. The draft was not applied. Review the latest circuit and try again.";
        set({ isStreaming: false, streamingEvents: [], error: message });
        toast.error("Circuit changed during edit", { description: message });
        return;
      }

      // Historical assistant turns with activities render their event trail, not
      // message.content. Move an already-streamed identical summary to the end or
      // append it once so the completion is visible without creating another
      // assistant message or duplicate text event.
      if (
        !stuck &&
        !incompleteWorkflow &&
        validatedCandidate &&
        completionSummary
      ) {
        const summary = completionSummary;
        const responseIsSummary = fullResponse.trim() === summary;
        for (let index = events.length - 1; index >= 0; index--) {
          const event = events[index];
          if (
            event.kind === "text" &&
            (responseIsSummary || event.text.trim() === summary)
          ) {
            events.splice(index, 1);
          }
        }
        events.push({ kind: "text", text: summary });
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
        !stuck && workingTsx.edited && completionSummary
          ? completionSummary
          : fullResponse.trim() !== ""
            ? fullResponse
          : !stuck && workingTsx.edited
            ? "Updated the circuit."
            : "";
      // Captured here so the resulting circuit (applied below) can be stamped
      // onto this exact message for `restoreToMessage`. null on the empty
      // (stuck / no-output) paths where no assistant message is persisted.
      let assistantMessageId: string | null = null;
      if (turnText !== "") {
        assistantMessageId = crypto.randomUUID();
        const assistantMessage: ChatMessage = {
          id: assistantMessageId,
          role: "assistant",
          content: turnText,
          timestamp: Date.now(),
          events: events.length > 0 ? events : undefined,
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

      if (incompleteWorkflow) {
        set({ error: incompleteWorkflow });
        toast.error("Circuit workflow incomplete", {
          description: incompleteWorkflow,
        });
        return;
      }

      // Circuit-mutating tools update only the working draft. A ```tsx block in
      // answer text is illustrative prose — never extracted or applied — so the
      // validated working copy is the sole source of an applied change.
      let tsxCode: string | null = workingTsx.edited
        ? validatedCandidate?.candidateTsx ?? null
        : null;

      // Prepend the real imported component definitions. The model used the exact
      // tag name import_component returned, so the key matches directly — no
      // rename dance and no post-turn race. Footprint meta was already stamped at
      // import time; only inject defs the final TSX actually references.
      // Imported definitions were included in the pre-commit candidate so the
      // exact TSX that passed validation is the TSX committed here.

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
        // `false` means the model re-emitted the current circuit unchanged.
        const candidateCircuitJson = validatedCandidate?.circuitJson as
          | AnyCircuitElement[]
          | undefined;
        const applied = useCircuitStore
          .getState()
          .applyAiEdit(tsxCode, candidateCircuitJson);
        if (applied && validatedCandidate) {
          // Pre-commit validation already evaluated this exact candidate and ran
          // the full checks. applyAiEdit committed its render with the TSX, so
          // the panels stay populated while the background refresh catches up.
          const errors = validatedCandidate.issues.filter(
            (issue) => issue.severity === "error"
          ).length;
          const warnings = validatedCandidate.issues.filter(
            (issue) => issue.severity === "warning"
          ).length;
          const content =
            errors === 0 && warnings === 0
              ? "__ok__"
              : `__issues__:${errors}:${warnings}`;
          set((s) => ({
            messages: [
              ...s.messages,
              {
                id: crypto.randomUUID(),
                role: "system" as const,
                content,
                timestamp: Date.now(),
              },
            ],
          }));
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
        const partialMessage: ChatMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: fullResponse + interruptNote,
          timestamp: Date.now(),
          events: [...events, { kind: "text", text: interruptNote }],
        };
        set((s) => ({ messages: [...s.messages, partialMessage] }));
      }

      const errorMessage = friendlyChatError(errorStr);

      toast.error("Chat error", { description: errorMessage });

      set({
        isStreaming: false,
        streamingEvents: [],
        error: errorMessage,
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
      sessionNotes: null,
      summarizedCount: 0,
      sessionId: crypto.randomUUID(),
    }),
  clearError: () => set({ error: null }),
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
        chatWidth: state.chatWidth,
      }),
    }
  )
);
