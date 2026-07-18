import { useState, useRef, useEffect, useCallback, useMemo, memo, type ReactNode } from "react";
import {
  isAiSetupError,
  useChatStore,
  type ChatMessage,
  type ChatActivity,
  type ChatEvent,
} from "@/store/chatStore";
import { useCircuitStore } from "@/store/circuitStore";
import { useEditorStore } from "@/editor/state/editorStore";
import { useSettingsStore } from "@/store/settingsStore";
import {
  Cpu,
  X,
  Send,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Copy,
  Check,
  Sparkles,
  KeyRound,
  Brain,
  Plus,
  Minus,
  Search,
  Ruler,
  FileText,
  Package,
  Pencil,
  UndoDot,
  SquarePen,
  FileCode2,
  ShieldCheck,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { DEFAULT_TSX } from "@/utils/tsxTransform";
import { copyText, buildSuggestions } from "@/lib/chatMessageUtils";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ManagedModelSelector } from "@/components/ManagedModelSelector";
import { useAiReady } from "@/hooks/useAiReady";

marked.setOptions({ breaks: true, gfm: true });

const COPIED_RESET_MS = 1500;

function MessageContent({ content }: { content: string }) {
  // Parsing + sanitizing markdown is the expensive part; memoize it on `content`
  // so historical messages don't re-parse on every streaming chunk (each chunk
  // re-renders the panel, which would otherwise re-run marked + DOMPurify for
  // every prior message — O(messages × chunks)).
  const html = useMemo(() => {
    // ```tsx blocks render as ordinary code the user can read — they are
    // illustrative only; the circuit changes solely through the edit_tsx tool
    // (surfaced as activity rows + a validation result message).
    const raw = marked.parse(content) as string;
    const sanitized = DOMPurify.sanitize(raw, { ADD_ATTR: ["class"] });
    // Inject a copy button into every rendered code block (CP2). This static,
    // trusted markup is added AFTER sanitize so DOMPurify doesn't strip it; the
    // click is handled via delegation below so it works with innerHTML content.
    return sanitized.replace(
      /<pre>/g,
      '<pre><button type="button" data-copy-code aria-label="Copy code" class="code-copy-btn">Copy</button>'
    );
  }, [content]);

  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const btn = (e.target as HTMLElement).closest("[data-copy-code]");
    if (!btn) return;
    const pre = btn.closest("pre");
    const code = pre?.querySelector("code")?.textContent ?? "";
    if (code) void copyText(code);
  }, []);

  return (
    <div
      className="text-sm text-foreground prose-chat"
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function CopyMessageButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Clear a pending reset on unmount so we never setState on an unmounted button.
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);
  const onCopy = useCallback(async () => {
    const ok = await copyText(content);
    if (!ok) return;
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
  }, [content]);

  return (
    <button
      onClick={onCopy}
      className="absolute right-3 top-2.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/70"
      aria-label="Copy message"
    >
      {copied ? (
        <Check className="size-3.5 text-primary" />
      ) : (
        <Copy className="size-3.5" />
      )}
    </button>
  );
}

// Rewind affordance on an assistant turn: restores the circuit to how it stood
// right after this message and drops every later message. Sits just left of the
// copy button and only appears on hover (a confirm dialog gates the actual
// rewind, since the dropped messages can't be recovered). Rendered disabled +
// muted on turns that are no longer a checkpoint (older than the snapshot window)
// or while a turn is mid-stream/validation.
function RestoreMessageButton({
  onRestore,
  disabled,
  title,
}: {
  onRestore: () => void;
  disabled: boolean;
  title: string;
}) {
  return (
    <button
      onClick={onRestore}
      disabled={disabled}
      className="absolute right-9 top-2.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/70 disabled:cursor-not-allowed disabled:text-muted-foreground/40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground/40"
      aria-label={title}
      title={title}
    >
      <UndoDot className="size-3.5" />
    </button>
  );
}

function RoleLabel({ isUser }: { isUser: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      {!isUser && (
        <span className="flex items-center justify-center size-4 rounded bg-primary/15 text-primary">
          <Sparkles className="size-2.5" aria-hidden="true" />
        </span>
      )}
      <span className="ui-label text-muted-foreground">
        {isUser ? "You" : "Assistant"}
      </span>
    </span>
  );
}

// Shared +/- affordance: a Minus when open, a Plus when collapsed. Centralizes
// the icon choice for every collapsible row/box below (callers supply styling).
function ExpandToggleIcon({ open, className }: { open: boolean; className: string }) {
  const Icon = open ? Minus : Plus;
  return <Icon className={className} aria-hidden="true" />;
}

// A collapsible trace row: icon + label + optional header extra, with a +/- toggle
// and a left-bordered body revealed on click. `header` receives the open state so
// callers can hide a preview when expanded. Shared by the Thinking trace and the
// edit_tsx activity row.
function CollapsibleTrace({
  icon: Icon,
  label,
  header,
  bodyClassName,
  children,
}: {
  icon: LucideIcon;
  label: string;
  header?: (expanded: boolean) => ReactNode;
  bodyClassName?: string;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
        aria-expanded={expanded}
      >
        <Icon className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
        <span className="shrink-0 font-medium">{label}</span>
        {header?.(expanded)}
        <ExpandToggleIcon open={expanded} className="ml-auto size-3 shrink-0 opacity-50" />
      </button>
      {expanded && (
        <div className={`ml-[7px] mt-1.5 border-l border-border/60 pl-3 ${bodyClassName ?? ""}`}>
          {children}
        </div>
      )}
    </div>
  );
}

// Collapsible reasoning trace — an icon + "Thinking" label + a truncated
// preview of the latest line, expandable to the full summarized reasoning.
// Used live (streaming) and on completed assistant turns that carry a trace.
function ThinkingTrace({
  thinking,
  streaming = false,
}: {
  thinking: string;
  streaming?: boolean;
}) {
  if (!thinking.trim()) return null;
  const lines = thinking
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const preview = lines[lines.length - 1] ?? "";

  return (
    <CollapsibleTrace
      icon={Brain}
      label="Thinking"
      bodyClassName="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground/80"
      header={(expanded) => (
        <>
          {streaming && (
            <Loader2 className="size-3 shrink-0 animate-spin opacity-60" aria-hidden="true" />
          )}
          {!expanded && preview && (
            <span className="truncate rounded bg-muted/60 px-1 py-px font-normal text-muted-foreground/70">
              {preview}
            </span>
          )}
        </>
      )}
    >
      {thinking}
    </CollapsibleTrace>
  );
}

// A single tool-action row (edit / search / footprint / datasheet / import).
// Most kinds render a static icon + label + muted detail; `edit` rows are
// expandable (like the Thinking trace) and reveal the full string-replace tool
// call on click. One row per tool call, in the order the call happened.
const ACTIVITY_META: Record<
  ChatActivity["kind"],
  { icon: LucideIcon; label: string }
> = {
  edit: { icon: Pencil, label: "Editing circuit" },
  write: { icon: FileCode2, label: "Rewriting circuit" },
  search: { icon: Search, label: "Searching JLCPCB" },
  footprint: { icon: Ruler, label: "Looking up footprint" },
  datasheet: { icon: FileText, label: "Reading datasheet" },
  import: { icon: Package, label: "Importing" },
  validation: { icon: ShieldCheck, label: "Repairing validation errors" },
};

// Click-to-expand `edit_tsx` row: collapsed it's just the icon + label (no inline
// preview); expanded it shows the exact old → new strings as a removed/added diff.
function EditActivityRow({ activity }: { activity: ChatActivity }) {
  const { label } = ACTIVITY_META.edit;
  const edit = activity.edit;
  if (!edit) return null;
  return (
    <CollapsibleTrace
      icon={ACTIVITY_META.edit.icon}
      label={label}
      bodyClassName="space-y-1.5 text-[11px] leading-relaxed"
      header={() =>
        edit.replaceAll && (
          <span className="shrink-0 rounded bg-muted/60 px-1 py-px font-normal text-muted-foreground/70">
            replace all
          </span>
        )
      }
    >
      <div>
        <div className="mb-0.5 font-medium text-muted-foreground/70">Replace</div>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-destructive/5 px-2 py-1 font-mono text-destructive">
          {edit.oldString}
        </pre>
      </div>
      <div>
        <div className="mb-0.5 font-medium text-muted-foreground/70">
          {edit.newString === "" ? "With (delete)" : "With"}
        </div>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-green-500/10 px-2 py-1 font-mono text-green-600 dark:text-green-400">
          {edit.newString === "" ? "∅" : edit.newString}
        </pre>
      </div>
    </CollapsibleTrace>
  );
}

// Click-to-expand `write_tsx` row: collapsed it's just the icon + label;
// expanded it reveals the full circuit the model wrote in one wholesale
// overwrite (used for empty circuits or ground-up rewrites).
function WriteActivityRow({ activity }: { activity: ChatActivity }) {
  const { label } = ACTIVITY_META.write;
  const write = activity.write;
  if (!write) return null;
  return (
    <CollapsibleTrace
      icon={ACTIVITY_META.write.icon}
      label={label}
      bodyClassName="space-y-1.5 text-[11px] leading-relaxed"
    >
      <div>
        <div className="mb-0.5 font-medium text-muted-foreground/70">
          New circuit
        </div>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-green-500/10 px-2 py-1 font-mono text-green-600 dark:text-green-400">
          {write.tsx}
        </pre>
      </div>
    </CollapsibleTrace>
  );
}

function ActivityRow({ activity }: { activity: ChatActivity }) {
  if (activity.kind === "edit" && activity.edit) {
    return <EditActivityRow activity={activity} />;
  }
  if (activity.kind === "write" && activity.write) {
    return <WriteActivityRow activity={activity} />;
  }
  const { icon: Icon, label } = ACTIVITY_META[activity.kind];
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Icon className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
      <span className="shrink-0 font-medium">{label}</span>
      {activity.detail && (
        <span className="truncate font-normal text-muted-foreground/60">
          {activity.detail}
        </span>
      )}
    </div>
  );
}

// A contiguous run of answer text — one "bubble" in the trail. The streaming
// cursor trails the last segment of the in-flight turn.
function TextSegment({
  content,
  streaming = false,
}: {
  content: string;
  streaming?: boolean;
}) {
  return (
    <div>
      <MessageContent content={content} />
      {streaming && (
        <span className="inline-block w-2 h-4 bg-primary animate-pulse ml-0.5 align-text-bottom rounded-sm" />
      )}
    </div>
  );
}

// The chronological trail of an assistant turn: reasoning, tool actions, and
// answer text rendered top-to-bottom in the exact order they streamed. When
// `streaming`, the final entry carries the live spinner/cursor. Index keys are
// safe — the list only ever grows append-only and only its last entry mutates.
function MessageTrail({
  events,
  streaming = false,
}: {
  events: ChatEvent[];
  streaming?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      {events.map((ev, i) => {
        const live = streaming && i === events.length - 1;
        if (ev.kind === "thinking") {
          return <ThinkingTrace key={i} thinking={ev.text} streaming={live} />;
        }
        if (ev.kind === "activity") {
          return <ActivityRow key={i} activity={ev.activity} />;
        }
        return <TextSegment key={i} content={ev.text} streaming={live} />;
      })}
    </div>
  );
}

// Memoized: a streaming response re-renders the panel on every chunk, but a
// historical message only changes when its own `message` object does, so memo
// lets the prior turns skip re-rendering (and re-parsing markdown) mid-stream.
const ChatMessageItem = memo(function ChatMessageItem({
  message,
  onRestore,
  restoreDisabled,
}: {
  message: ChatMessage;
  onRestore: (id: string) => void;
  restoreDisabled: boolean;
}) {
  const isUser = message.role === "user";
  const time = new Date(message.timestamp);
  const timeStr = time.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  // The rewind affordance shows on every assistant turn but is only actionable
  // when this turn still carries a snapshot (i.e. within the recent window — see
  // MAX_SNAPSHOTS) and no turn is mid-stream/validation. Out-of-range turns keep
  // a muted, disabled icon so it's clear they're no longer a checkpoint.
  const hasSnapshot = message.tsxSnapshot !== undefined;
  const restoreTitle = !hasSnapshot
    ? "Only the most recent turns can be restored"
    : "Restore circuit to this point";

  return (
    <div className="group relative px-4 py-3">
      <div className="flex items-center gap-2 mb-1.5">
        <RoleLabel isUser={isUser} />
        <span className="text-xs text-muted-foreground/70">{timeStr}</span>
      </div>
      {isUser ? (
        <div className="rounded-md bg-foreground/5 px-3 py-2">
          <MessageContent content={message.content} />
        </div>
      ) : !message.events ? (
        <MessageContent content={message.content} />
      ) : (
        <MessageTrail events={message.events} />
      )}
      <CopyMessageButton content={message.content} />
      {!isUser && (
        <RestoreMessageButton
          onRestore={() => onRestore(message.id)}
          disabled={!hasSnapshot || restoreDisabled}
          title={restoreTitle}
        />
      )}
    </div>
  );
});

function StreamingMessage({ events }: { events: ChatEvent[] }) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2 mb-1.5">
        <RoleLabel isUser={false} />
      </div>
      {events.length === 0 ? (
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <span className="flex gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "0ms" }} />
            <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "150ms" }} />
            <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "300ms" }} />
          </span>
          Thinking...
        </div>
      ) : (
        <MessageTrail events={events} streaming />
      )}
    </div>
  );
}

function SystemValidationMessage({
  message,
  isLatest,
}: {
  message: ChatMessage;
  isLatest: boolean;
}) {
  const { content } = message;

  if (content === "__checking__") {
    return (
      <div className="flex items-center gap-2 mx-4 my-2 px-3 py-2 rounded-md bg-muted/60 text-muted-foreground text-xs">
        <Loader2 className="size-3.5 animate-spin shrink-0" />
        <span>Validating circuit...</span>
      </div>
    );
  }

  if (content === "__ok__") {
    return (
      <div className="flex items-center gap-2 mx-4 my-2 px-3 py-2 rounded-md bg-green-500/10 text-green-600 dark:text-green-400 text-xs">
        <CheckCircle2 className="size-3.5 shrink-0" />
        <span>Circuit validated — no errors</span>
      </div>
    );
  }

  if (content === "__timeout__") {
    return (
      <div className="flex items-center gap-2 mx-4 my-2 px-3 py-2 rounded-md border border-yellow-500/30 bg-yellow-500/5 text-yellow-700 dark:text-yellow-400 text-xs">
        <AlertCircle className="size-3.5 shrink-0" />
        <span>Validation didn't finish — the render may be stuck</span>
      </div>
    );
  }

  if (content.startsWith("__issues__:")) {
    if (!isLatest) return null;
    const [, rawErrors = "0", rawWarnings = "0"] = content.split(":");
    const errors = Number(rawErrors) || 0;
    const warnings = Number(rawWarnings) || 0;
    return (
      <div className="flex items-center gap-2 mx-4 my-2 px-3 py-2 rounded-md border border-border bg-muted/40 text-xs">
        <AlertCircle
          className={`size-3.5 shrink-0 ${
            errors > 0 ? "text-destructive" : "text-amber-500"
          }`}
        />
        <span className="min-w-0 text-muted-foreground">
          Circuit evaluated with {errors} {errors === 1 ? "error" : "errors"}
          {warnings > 0 &&
            ` and ${warnings} ${warnings === 1 ? "warning" : "warnings"}`}
        </span>
        <button
          type="button"
          onClick={() => useEditorStore.getState().setIssuesOpen(true)}
          className="ml-auto shrink-0 font-medium text-foreground hover:text-primary"
        >
          Review issues
        </button>
      </div>
    );
  }

  return null;
}

function EmptyState({
  suggestions,
  onSuggestion,
}: {
  suggestions: string[];
  onSuggestion: (text: string) => void;
}) {
  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="text-center max-w-[300px]">
        <div className="size-12 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center mx-auto mb-3">
          <Cpu className="size-6 text-primary" />
        </div>
        <p className="text-sm font-semibold text-foreground mb-1">AI Assistant</p>
        <p className="text-xs text-muted-foreground mb-4">
          Describe what you want to build — the Assistant edits the circuit live.
        </p>
        <div className="flex flex-col gap-2">
          {suggestions.map((s) => (
            <button
              key={s}
              onClick={() => onSuggestion(s)}
              className="text-left text-xs rounded-lg border border-border px-3 py-2 text-muted-foreground hover:text-foreground hover:border-primary/40 hover:bg-muted/40 transition-colors"
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// Shown in place of the composer when the active AI provider isn't set up yet
// (no API key saved, or account mode while signed out). Rather than ambushing
// the user with an auto-opening modal on their first send, we present a calm
// inline CTA that takes them to the right Settings section.
function AiSetupCta({
  message,
  onOpenSettings,
}: {
  message: string;
  onOpenSettings: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-4 py-3 text-center">
      <KeyRound className="size-4 text-muted-foreground" aria-hidden="true" />
      <p className="text-xs text-muted-foreground">{message}</p>
      <button
        onClick={onOpenSettings}
        className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
      >
        Open Settings
      </button>
    </div>
  );
}

export function ChatPanel() {
  const messages = useChatStore((s) => s.messages);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const streamingEvents = useChatStore((s) => s.streamingEvents);
  const error = useChatStore((s) => s.error);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const restoreToMessage = useChatStore((s) => s.restoreToMessage);
  const clearHistory = useChatStore((s) => s.clearHistory);
  const setChatOpen = useChatStore((s) => s.setChatOpen);
  const clearError = useChatStore((s) => s.clearError);
  const openSettings = useSettingsStore((s) => s.openSettings);

  const tsxCode = useCircuitStore((s) => s.tsxCode);
  const isValidating = useCircuitStore((s) => s.isValidating);
  const selectedName = useCircuitStore((s) => s.selectedComponentName);

  const [input, setInput] = useState("");
  // Id of the message a pending rewind targets — non-null while the confirm
  // dialog is open. Restoring is destructive to later chat history, so it goes
  // through a confirm rather than firing on the bare click.
  const [restoreTargetId, setRestoreTargetId] = useState<string | null>(null);
  // Open while the "start a new chat" confirm is showing — clearing wipes the
  // whole conversation, so it goes through a confirm like restore does.
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Tracks whether the user has scrolled up to read earlier turns. When true,
  // streaming chunks no longer yank them back to the bottom — they have to
  // scroll down themselves (or send a new message) to resume autoscroll.
  const userScrolledUpRef = useRef(false);

  // Focus the input the moment the panel mounts (Cmd+L / toolbar / tab switch
  // into Chat all remount this) so the user can type immediately.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  const handleMessagesScroll = useCallback(() => {
    // While the user is dragging the rail wider/narrower the panel reflows,
    // which can fire spurious scroll events — ignore them so a resize never
    // silently flips the autoscroll lock.
    if (useChatStore.getState().chatResizing) return;
    const el = messagesContainerRef.current;
    if (!el) return;
    // 80px tolerance — small enough to feel "at the bottom", big enough that
    // smooth-scroll momentum doesn't accidentally toggle the lock.
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    userScrolledUpRef.current = distanceFromBottom > 80;
  }, []);

  // Autoscroll only when the user is already pinned to the bottom. New user
  // messages always force-scroll because the user just sent them.
  useEffect(() => {
    if (!userScrolledUpRef.current) scrollToBottom();
  }, [streamingEvents, scrollToBottom]);

  useEffect(() => {
    userScrolledUpRef.current = false;
    scrollToBottom();
  }, [messages.length, scrollToBottom]);

  // Kept in lockstep with the sendMessage guard so the CTA and the send path
  // agree on whether the active provider is usable. While `pending` (session
  // restore in flight at launch) the composer renders disabled instead of the
  // CTA, so signed-in users don't get a "Sign in" flash.
  const { ready: aiReady, pending: aiPending, settingsTab, ctaMessage } = useAiReady();

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage(text);
  }, [input, isStreaming, sendMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const handleSuggestion = useCallback(
    (text: string) => {
      if (isStreaming || aiPending) return;
      // Provider not set up yet → route to Settings rather than firing a doomed send.
      if (!aiReady) {
        openSettings(settingsTab);
        return;
      }
      sendMessage(text);
    },
    [isStreaming, aiReady, aiPending, settingsTab, openSettings, sendMessage]
  );

  // Stable across renders so memoized ChatMessageItems don't re-render when an
  // unrelated message streams in.
  const handleRequestRestore = useCallback((id: string) => {
    setRestoreTargetId(id);
  }, []);

  const handleConfirmRestore = useCallback(() => {
    if (restoreTargetId) restoreToMessage(restoreTargetId);
    setRestoreTargetId(null);
  }, [restoreTargetId, restoreToMessage]);

  const handleConfirmClear = useCallback(() => {
    clearHistory();
    setClearConfirmOpen(false);
  }, [clearHistory]);

  // Hide every message's restore affordance while a turn is streaming or its
  // circuit is validating — a rewind then would race those async state writes.
  const restoreDisabled = isStreaming || isValidating;

  const isEmpty = messages.length === 0 && !isStreaming;
  const isEmptyBoard = tsxCode.trim() === DEFAULT_TSX.trim();

  const suggestions = useMemo(
    () => buildSuggestions({ isEmptyBoard, selectedName }),
    [isEmptyBoard, selectedName]
  );

  // Only the most recent validation reflects the live circuit; stale error boxes
  // from earlier turns are hidden, so we tag the last system message as current.
  const latestSystemId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "system") return messages[i].id;
    }
    return null;
  }, [messages]);

  const inputPlaceholder = isStreaming
    ? "Assistant is thinking..."
    : isEmptyBoard
    ? "Describe your board to get started..."
    : "Ask about your circuit...";

  return (
      <div className="flex flex-col h-full">
        {/* Header — title + chat actions */}
        <div className="flex items-center justify-between h-9 px-3 border-b border-border bg-sidebar shrink-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="flex shrink-0 items-center gap-1.5 text-sm font-semibold">
              <Sparkles className="size-3.5 text-primary" aria-hidden="true" />
              AI Assistant
            </span>
            <ManagedModelSelector />
          </div>
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => setClearConfirmOpen(true)}
              // Disabled mid-stream and mid-validation (same as restore) so a
              // wipe never races those async writes — e.g. clearing the
              // in-flight "__checking__" row out from under the validation cycle.
              disabled={isStreaming || isValidating || messages.length === 0}
              className="p-1 rounded-md text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-muted-foreground"
              aria-label="New chat"
              title="New chat"
            >
              <SquarePen className="size-3.5" />
            </button>
            <button
              onClick={() => setChatOpen(false)}
              className="p-1 rounded-md text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Close chat"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>

        {/* Messages */}
        {isEmpty ? (
          <EmptyState suggestions={suggestions} onSuggestion={handleSuggestion} />
        ) : (
          <div
            ref={messagesContainerRef}
            onScroll={handleMessagesScroll}
            className="flex-1 overflow-y-auto min-h-0"
            role="log"
            aria-live="polite"
          >
            {messages.map((m) =>
              m.role === "system" ? (
                <SystemValidationMessage
                  key={m.id}
                  message={m}
                  isLatest={m.id === latestSystemId}
                />
              ) : (
                <ChatMessageItem
                  key={m.id}
                  message={m}
                  onRestore={handleRequestRestore}
                  restoreDisabled={restoreDisabled}
                />
              )
            )}
            {isStreaming && <StreamingMessage events={streamingEvents} />}
            <div ref={messagesEndRef} />
          </div>
        )}

        {/* Error banner */}
        {error && !isAiSetupError(error) && (
          <div className="flex items-center gap-2 mx-3 mb-2 px-3 py-2 rounded-md bg-destructive/10 text-destructive text-xs">
            <AlertCircle className="size-3.5 shrink-0" />
            <span className="flex-1">{error}</span>
            <button onClick={clearError} className="text-destructive/70 hover:text-destructive">
              <X className="size-3" />
            </button>
          </div>
        )}

        {/* Input area — or the setup CTA when the AI provider isn't ready yet.
            While readiness is pending (session restore in flight) keep the
            composer, just disabled, to avoid a CTA flash on launch. */}
        <div className="border-t border-border p-3 bg-sidebar shrink-0">
          {!aiReady && !aiPending ? (
            <AiSetupCta message={ctaMessage} onOpenSettings={() => openSettings(settingsTab)} />
          ) : (
            <div className="flex gap-2">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={inputPlaceholder}
                disabled={isStreaming || aiPending}
                rows={1}
                className="flex-1 resize-none text-sm bg-background border border-input rounded-md px-3 py-2 outline-none focus:border-ring focus:ring-2 focus:ring-ring/50 disabled:opacity-50 disabled:cursor-not-allowed placeholder:text-muted-foreground"
                style={{ maxHeight: "144px", fieldSizing: "content" } as React.CSSProperties}
              />
              <button
                onClick={handleSend}
                disabled={isStreaming || aiPending || !input.trim()}
                className="size-8 shrink-0 flex items-center justify-center rounded-md bg-primary text-primary-foreground disabled:opacity-50 disabled:cursor-not-allowed hover:bg-primary/90 transition-colors"
                aria-label="Send message"
              >
                <Send className="size-4" />
              </button>
            </div>
          )}
        </div>

        <ConfirmDialog
          open={restoreTargetId !== null}
          onOpenChange={(open) => {
            if (!open) setRestoreTargetId(null);
          }}
          title="Restore to this point?"
          message="This reverts the circuit to how it was at this message and removes every later message in the conversation. The circuit change can be undone (Cmd+Z), but the removed messages can't be recovered."
          confirmLabel="Restore"
          destructive
          onConfirm={handleConfirmRestore}
        />

        <ConfirmDialog
          open={clearConfirmOpen}
          onOpenChange={setClearConfirmOpen}
          title="Start a new chat?"
          message="This clears the entire conversation so you can start fresh. Your circuit is untouched, but the chat history can't be recovered."
          confirmLabel="New chat"
          destructive
          onConfirm={handleConfirmClear}
        />
      </div>
  );
}
