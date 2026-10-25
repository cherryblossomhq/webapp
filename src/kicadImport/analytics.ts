import type { ImportSummary } from "./summary"

// One analytics event per import. The editor sends no events of its own: the host connects a sink
// with `connectAnalytics` (the website's projects page connects PostHog). What is sent is a handful
// of fixed words and numbers, never a file name, a net name, a part, or anything read from the file.

export type EventSink = (name: string, properties: Record<string, string | number | string[] | null>) => void

let sink: EventSink | null = null
export const connectAnalytics = (next: EventSink | null | undefined) => {
  sink = next ?? null
}

export type EventOutcome =
  | "imported"
  /** The board came in but could not be saved. */
  | "save_failed"
  | "refused_unsupported"
  | "refused_too_large"
  | "refused_unknown"
  | "refused_inexact"
  | "unreadable"
  | "no_board"
  | "bad_input"
  | "failed"
  | "cancelled"

export const EVENT_NAME = "kicad_import"

const OUTCOMES: Record<NonNullable<ImportSummary["reason"]>, EventOutcome> = {
  unsupported: "refused_unsupported",
  "too-large": "refused_too_large",
  unknown: "refused_unknown",
  inexact: "refused_inexact",
  unreadable: "unreadable",
  "no-board": "no_board",
  "bad-input": "bad_input",
  failed: "failed",
  cancelled: "cancelled",
}

/**
 * The event for an import that ended with `summary`; `saved` is false when the board came in and
 * saving it failed. Nothing is copied from the summary except the stamp, the release, the
 * extension ids and the sizes.
 */
export function importEvent(summary: ImportSummary, durationMs: number, saved = true) {
  const outcome: EventOutcome = summary.status === "imported" ? (saved ? "imported" : "save_failed") : OUTCOMES[summary.reason ?? "failed"]
  return {
    name: EVENT_NAME,
    properties: {
      outcome,
      kicad_stamp: summary.stamp === null ? null : String(summary.stamp),
      kicad_release: summary.era,
      missing_extensions: summary.missing.map((m) => m.id),
      board_kb: Math.round(summary.boardBytes / 1024),
      duration_ms: Math.round(durationMs),
    },
  } satisfies { name: string; properties: Record<string, string | number | string[] | null> }
}

export function trackImport(summary: ImportSummary, durationMs: number, saved = true) {
  try {
    const { name, properties } = importEvent(summary, durationMs, saved)
    sink?.(name, properties)
  } catch {
    // analytics never breaks an import
  }
}
