// Pure, dependency-light helpers for the chat panel — split out of ChatPanel so
// they can be unit-tested without mounting the whole component tree.
import { toast } from "sonner";

// Copy helper — clipboard writes reject in non-secure contexts / when the user
// denies permission, so every copy is wrapped and surfaces a toast on failure
// instead of silently doing nothing.
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    console.error("[chat] copy failed:", err);
    toast.error("Couldn't copy to clipboard");
    return false;
  }
}

// Suggestions adapt to context (CP5): a fresh board, a populated board, or a
// component the user has selected — so the first impression feels aware of what
// the user is actually looking at instead of three fixed strings.
export function buildSuggestions(opts: {
  isEmptyBoard: boolean;
  selectedName: string | null;
}): string[] {
  if (opts.selectedName) {
    const n = opts.selectedName;
    return [
      `Explain what ${n} does in this circuit`,
      `Add a decoupling capacitor near ${n}`,
      `What are the pin connections on ${n}?`,
    ];
  }
  if (opts.isEmptyBoard) {
    return [
      "Design a 555 timer LED blinker",
      "Add an ESP32 with USB-C power",
      "Start a 5V → 3.3V power supply",
    ];
  }
  return [
    "Add a 10k pullup resistor to VCC",
    "Connect all grounds together",
    "Explain this circuit's power section",
  ];
}
