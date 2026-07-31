// Context-aware keyboard shortcut dispatcher.
//
// Why we need this: the schematic editor has single-key shortcuts (M for
// move, W for route, etc.) that must NOT fire while the user is typing in
// the properties panel or any other text field. The plan's
// regression table flags this as a CRITICAL gap; without it, hitting "M"
// while typing "Move R1" in a search box quietly changes the tool.
//
// We can't just register at window-level and call it a day — React-managed
// inputs can be inside shadow DOM (cmdk does this), and dialogs render in
// portals where parent-based focus tracking lies. The check below covers
// the common cases plus the explicit contenteditable / role=textbox escape
// hatches.

export type ShortcutHandler = (e: KeyboardEvent) => void;

export interface ShortcutSpec {
  // Lowercase letter key (e.g. "m"), or a special name like "escape", "delete".
  key: string;
  // Optional modifiers. Default is "none required, none allowed."
  ctrlOrMeta?: boolean;
  shift?: boolean;
  alt?: boolean;
  handler: ShortcutHandler;
  // If true, the shortcut fires even when focus is inside a text input. Used
  // for things like Cmd+Z which should always work.
  allowInInput?: boolean;
}

const TEXT_INPUT_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof Element)) return false;
  if (TEXT_INPUT_TAGS.has(target.tagName)) return true;
  // contenteditable=true on any ancestor disqualifies the target. Looking up
  // ancestors covers React portals where the actual editable element is the
  // child but the event target might be a descendant.
  //
  // We read the attribute directly rather than `el.isContentEditable` because
  // jsdom doesn't fully populate that property (the getter returns false even
  // when the attribute is set). The attribute is authoritative in both real
  // browsers and jsdom.
  let el: Element | null = target;
  while (el) {
    const ce = el.getAttribute?.("contenteditable");
    if (ce === "" || ce === "true" || ce === "plaintext-only") return true;
    const role = el.getAttribute?.("role");
    if (role === "textbox" || role === "combobox" || role === "searchbox") return true;
    el = el.parentElement;
  }
  return false;
}

// Normalize a KeyboardEvent into a comparable lowercase key. KeyboardEvent.key
// gives us the localized character; for shortcut purposes we want the
// physical-ish letter regardless of caps / shift state.
function eventKey(e: KeyboardEvent): string {
  const k = e.key;
  if (k.length === 1) return k.toLowerCase();
  return k.toLowerCase(); // "Escape" -> "escape", "ArrowUp" -> "arrowup", etc.
}

function matches(spec: ShortcutSpec, e: KeyboardEvent): boolean {
  if (eventKey(e) !== spec.key.toLowerCase()) return false;
  const ctrlOrMeta = !!(e.ctrlKey || e.metaKey);
  if ((spec.ctrlOrMeta ?? false) !== ctrlOrMeta) return false;
  if ((spec.shift ?? false) !== e.shiftKey) return false;
  if ((spec.alt ?? false) !== e.altKey) return false;
  return true;
}

// Subscribe to a set of shortcuts. Returns an unsubscribe function. The
// shortcuts list is captured at subscribe time; to update, unsubscribe and
// re-subscribe (this matches React's effect cleanup model and avoids the
// "stale closure" footgun of mutable subscription state).
export function registerShortcuts(
  shortcuts: ReadonlyArray<ShortcutSpec>,
  target: EventTarget = window
): () => void {
  const handler = (e: Event) => {
    const ev = e as KeyboardEvent;
    const inInput = isTypingTarget(ev.target);
    for (const spec of shortcuts) {
      if (inInput && !spec.allowInInput) continue;
      if (!matches(spec, ev)) continue;
      spec.handler(ev);
      // Stop after the first match — predictable single-shot semantics.
      break;
    }
  };
  target.addEventListener("keydown", handler);
  return () => target.removeEventListener("keydown", handler);
}
