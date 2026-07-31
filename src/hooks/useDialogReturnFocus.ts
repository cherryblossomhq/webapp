// useDialogReturnFocus — restore focus to the element that opened a dialog.
//
// Radix's modal Dialog restores focus to its <DialogTrigger> on close, via an
// onCloseAutoFocus that preventDefault()s FocusScope's own fallback. Our
// dialogs open from external state (toolbar buttons, keyboard shortcuts), not a
// DialogTrigger, so Radix focuses nothing and the preventDefault drops focus to
// <body> — a keyboard/screen-reader user loses their place on every close.
//
// We track the focused element while the dialog is CLOSED (via a focusin
// listener), so by the time `open` flips true the opener is already captured —
// before Radix's mount-focus moves focus into the content. The returned
// onCloseAutoFocus handler restores it on close.
import { useEffect, useRef } from "react";

export function useDialogReturnFocus(open: boolean) {
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    // While open, Radix owns focus — don't track. While closed, remember
    // whatever holds focus (skipping <body>) so the last focus before opening
    // is the opener we return to.
    if (open) return;
    const remember = () => {
      const el = document.activeElement as HTMLElement | null;
      if (el && el !== document.body) opener.current = el;
    };
    remember();
    document.addEventListener("focusin", remember);
    return () => document.removeEventListener("focusin", remember);
  }, [open]);

  return (event: Event) => {
    // preventDefault skips Radix's default (which would focus a null trigger);
    // we then restore focus to the captured opener ourselves.
    event.preventDefault();
    opener.current?.focus?.();
  };
}
