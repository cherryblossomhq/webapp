import { useEffect, useRef, type RefObject } from "react"

// What a modal dialog owes the keyboard: focus moves in when it opens and back to where it was
// when it closes, Tab stays inside, Escape closes it (when it may close) without reaching the
// editor's shortcuts, and no other key reaches the shortcuts behind it. Shared by the editor's
// dialog and the website's, which look different and behave the same.

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Where focus was before the first of a run of dialogs opened: the dialog changes step by remounting, and the opener is the one to return to. */
let opened = 0
let opener: Element | null = null

/**
 * Put this on the dialog's box. It stops every key at the window (capture phase), so nothing behind
 * the dialog sees one: a dialog with a text field must handle its keys there (an `onKeyDown` on the
 * field runs too late), or leave this out.
 *
 * `onEscape` is what Escape does; leave it out for a step that must
 * not be dismissed by a key (a running import is ended with its Cancel button).
 */
export function useModal(onEscape?: () => void): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)
  const escape = useRef(onEscape)
  useEffect(() => {
    escape.current = onEscape
  })

  useEffect(() => {
    const root = ref.current
    if (opened++ === 0) opener = document.activeElement
    const items = () => [...(root?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
    // The dialog's own choice first (`data-autofocus`), then its first control, then the box itself.
    const first = root?.querySelector<HTMLElement>("[data-autofocus]") ?? items()[0] ?? root
    if (root && !root.hasAttribute("tabindex")) root.tabIndex = -1
    first?.focus()

    const onKey = (e: KeyboardEvent) => {
      // Capture on the window: this runs before the editor's own listeners, and nothing behind the modal sees a key.
      e.stopPropagation()
      if (e.key === "Escape") {
        e.preventDefault()
        escape.current?.()
        return
      }
      if (e.key !== "Tab" || !root) return
      const list = items()
      if (!list.length) {
        e.preventDefault()
        root.focus()
        return
      }
      const active = document.activeElement
      const at = active ? list.indexOf(active as HTMLElement) : -1
      if (e.shiftKey && (at <= 0 || !root.contains(active))) {
        e.preventDefault()
        list[list.length - 1].focus()
      } else if (!e.shiftKey && (at === list.length - 1 || !root.contains(active))) {
        e.preventDefault()
        list[0].focus()
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => {
      window.removeEventListener("keydown", onKey, true)
      if (--opened === 0) {
        const back = opener
        opener = null
        if (back instanceof HTMLElement && back.isConnected) back.focus()
      }
    }
  }, [])
  return ref
}
