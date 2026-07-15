// externalEditor — "Open in editor" for the Code tab.
//
// The desktop app wrote a scratch file and launched a local code editor on it.
// A browser can't launch apps or write to disk, so the web equivalent is a
// download: `openInEditor()` saves the current circuit TSX as `circuit.tsx`
// for the user to open wherever they like. There is no sync-back either way.
// `listEditors()` returns [] so the editor-picker dropdown never renders.

import { useCircuitStore } from "@/store/circuitStore";

export interface EditorInfo {
  id: string;
  label: string;
}

/** Local code editors — none are detectable (or launchable) from a browser. */
export async function listEditors(): Promise<EditorInfo[]> {
  return [];
}

/** Download the current circuit TSX as a file (`editor` is ignored on web). */
export async function openInEditor(_editor?: string): Promise<void> {
  const content = useCircuitStore.getState().tsxCode;
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "circuit.tsx";
  anchor.click();
  URL.revokeObjectURL(url);
}
