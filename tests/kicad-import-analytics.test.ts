import { beforeEach, describe, expect, it, vi } from "vitest"
import { connectAnalytics, EVENT_NAME, importEvent, trackImport } from "../src/kicadImport/analytics"
import { stoppedSummary, summarize, type ImportSummary, type SummaryReason } from "../src/kicadImport/summary"
import { importKicadBoard } from "../src/model/kicad/board"
import { board, REFUSED_BOARD } from "./kicad-board-fixtures"

// The one analytics event: what it holds, and what it never holds.

const SECRETS = ["Net-(U17-Pad3)", "SecretBoard", "R99", "alice"]

const withSecrets = (s: ImportSummary): ImportSummary => ({
  ...s,
  used: ["SecretBoard.kicad_pcb"],
  notRead: [{ file: "SecretBoard.kicad_pro", why: "w" }],
  notBrought: [{ code: "x", object: "footprint R99, pad Net-(U17-Pad3)", why: "alice's design" }],
  changed: [{ code: "x", object: "R99", why: "Net-(U17-Pad3)" }],
  notes: [{ code: "x", object: "SecretBoard", why: "alice" }],
})

const refused = summarize(importKicadBoard(REFUSED_BOARD), { used: [], notRead: [], ignored: [], boardBytes: 3 * 1024 })
const imported = summarize(importKicadBoard(board({})), { used: [], notRead: [], ignored: [], boardBytes: 41 * 1024 * 1024 })

beforeEach(() => connectAnalytics(null))

describe("the kicad_import event", () => {
  it("carries the outcome, the stamp, the missing extension ids, the board size in KB and the duration, and nothing else", () => {
    const e = importEvent(withSecrets(refused), 1234.6)
    expect(e.name).toBe("kicad_import")
    expect(Object.keys(e.properties).sort()).toEqual(["board_kb", "duration_ms", "kicad_release", "kicad_stamp", "missing_extensions", "outcome"])
    expect(e.properties).toEqual({ outcome: "refused_unsupported", kicad_stamp: "20240108", kicad_release: "kicad8", missing_extensions: ["X25"], board_kb: 3, duration_ms: 1235 })
  })

  it("never holds a name from the file, a net, a part, the board's file name or a sentence", () => {
    for (const s of [withSecrets(refused), withSecrets(imported)]) {
      const text = JSON.stringify(importEvent(s, 10))
      for (const secret of SECRETS) expect(text).not.toContain(secret)
      expect(text).not.toContain(s.message)
    }
  })

  it("every value is a short fixed word or a number", () => {
    for (const s of [refused, imported]) {
      for (const [k, v] of Object.entries(importEvent(s, 5).properties)) {
        if (typeof v === "string") expect(v, k).toMatch(/^[a-z0-9_]{1,24}$/)
        else if (Array.isArray(v)) for (const x of v) expect(x, k).toMatch(/^X\d{1,2}$/)
        else expect(["number", "object"]).toContain(typeof v)
      }
    }
  })

  it("an import reports its size in KB", () => {
    expect(importEvent(imported, 0).properties).toMatchObject({ outcome: "imported", board_kb: 41 * 1024 })
  })

  it("every way an import can end has an outcome of its own", () => {
    const reasons: SummaryReason[] = ["too-large", "unsupported", "unknown", "inexact", "unreadable", "no-board", "bad-input", "failed", "cancelled"]
    const outcomes = reasons.map((r) => importEvent(stoppedSummary(r, "m"), 0).properties.outcome)
    expect(new Set(outcomes).size).toBe(reasons.length)
    expect(outcomes).toContain("refused_too_large")
    expect(importEvent(imported, 0, false).properties.outcome).toBe("save_failed")
  })

  it("a stop before any board was read has no stamp and no size", () => {
    expect(importEvent(stoppedSummary("no-board", "m"), 7).properties).toMatchObject({ kicad_stamp: null, kicad_release: null, board_kb: 0, missing_extensions: [] })
  })
})

describe("sending it", () => {
  it("goes to the sink the host gave, once", () => {
    const sink = vi.fn()
    connectAnalytics(sink)
    trackImport(refused, 10)
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink.mock.calls[0][0]).toBe(EVENT_NAME)
  })

  it("does nothing without a sink, and a sink that throws never breaks the import", () => {
    expect(() => trackImport(refused, 1)).not.toThrow()
    connectAnalytics(() => {
      throw new Error("blocked by an ad blocker")
    })
    expect(() => trackImport(refused, 1)).not.toThrow()
  })
})
