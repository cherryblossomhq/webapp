import type { PartIndexHit, PartIndexPart, PartSearchResponse, SupplierPart } from "@cherryblossom/api-contract"
import {
  buildCustomPart,
  CUSTOM_CATEGORIES,
  CUSTOM_SYMBOLS,
  customPartId,
  customPartProblems,
  DEFAULT_REF_PREFIX,
} from "../model/customParts"
import { drawnLand, type DrawnLandInput } from "../model/drawnLand"
import { registerProjectFootprints } from "../model/footprints"
import { draftFromIndexPart } from "../model/indexPart"
import { kicadFootprintLand } from "../model/kicadImport"
import { registerPart } from "../model/library"
import { schematicEditProblems } from "../model/merges"
import { setModel, modelAssignment } from "../model/models3d"
import { landForSupplierPart, landPads, supplierLandPads, supplierPins } from "../model/supplier/build"
import { supplierModelOn } from "../model/supplier/model"
import { DRAWN_LAND_ADVICE, footprintNameProblem, footprintOptionProblem } from "../model/supplier/footprintGuard"
import { describeLand, summarizeLand } from "../model/supplier/land"
import { comparePins, pinMapText } from "../model/supplier/pinmap"
import { needsCheck } from "../model/partChecks"
import { checkAgainstSupplier, type SupplierCheck } from "../model/supplier/verify"
import type { CustomPartSpec, FootprintDef, Model3D, PartCategory, PartSource, PinSide, Project } from "../model/types"
import { isWildcardOf, resolveStored, secondOpinion, storedLine, storedName, type StoredResolution } from "./databaseLookup"
import { getConnectivity } from "../store/analysis"
import { resolvePartName } from "./partLookup"
import { supplierVerdict, type PartCheckResult } from "./supplierVerdict"
import { lookupFailure, type SupplierPartsSource } from "./supplierParts"
import { fail, ok, pinList, stringProps, type JsonSchema, type ToolContext, type ToolInput, type ToolSpec } from "./toolKit"

// The copilot's part tools: find a part at a supplier, read its data, build a project part from
// it, and check the parts a project already has. Production measured why (October 2026): every
// Sakura user made parts with create_part, writing pins and choosing a footprint from memory, and
// of 13 checked against LCSC three had pin maps that kill the board (a boost converter with its
// input on its output pin) and eight sat on the wrong land. Building from the supplier's record
// is the default now; memory is the fallback, and it is marked as one.
//
// The parts database (`ai/databaseLookup.ts`) sits beside the supplier: find_part lists what it
// stores, create_part and get_part_data take its ids, and create_part by name builds from it when
// the supplier lookup fails or has no part numbered like the name, before falling back to memory.

const UNAVAILABLE = "Supplier part lookup isn't available in this editor"

const lookupMessage = lookupFailure

const stockText = (n: number | null) => (n === null ? "stock unknown" : `${n} in stock`)

// ---------- find_part ----------

/** Stored parts find_part lists beside the supplier's: enough to choose from, few enough to read. */
const STORED_SHOWN = 5

type FindPrepared =
  | {
      /** Null when the supplier search failed and only the parts database answered. */
      response: PartSearchResponse | null
      supplierError?: string
      stored: PartIndexHit[]
      storedCredit: string[]
    }
  | { error: string }

/** The parts database's lines for find_part: the stored parts the supplier's list doesn't already have. */
function storedSection(stored: PartIndexHit[], credit: string[], supplier: PartSearchResponse | null): string {
  const listed = new Set((supplier?.candidates ?? []).map((c) => c.lcsc))
  const shown = stored.filter((h) => !(h.lcsc && listed.has(h.lcsc))).slice(0, STORED_SHOWN)
  if (!shown.length) return ""
  return (
    `\nFrom the parts database (stored whole, no supplier lookup needed; build one with create_part database_id, read it with get_part_data database_id):\n` +
    `${shown.map(storedLine).join("\n")}\n` +
    `[family] is a stored name that covers this one (a KiCad wildcard such as STM32F103C8Tx) or this number less its ordering letters, which can be another package; [typo] is a different number; [keyword] matched words, not the number.` +
    `${credit.length ? `\n${credit.join("\n")}` : ""}`
  )
}

export const findPartTool: ToolSpec<FindPrepared> = {
  name: "find_part",
  description:
    "Search the supplier catalogue (LCSC, with EasyEDA's symbols and land patterns) and the parts database (KiCad's libraries, and supplier records it kept, stored whole) for a part the library doesn't have, by part number or a few words; the name doesn't have to be an exact orderable number (ADS1115 finds ADS1115IDGSR). Returns supplier candidates, best stocked first, with their LCSC number, part number, package, stock, pin count and whether the supplier has a named pinout and a land pattern, then stored parts with their database_id. Build one with create_part lcsc or database_id (or just create_part with the name), or read it first with get_part_data.",
  input_schema: {
    type: "object",
    properties: { query: { type: "string", description: "A part number (best), e.g. \"TPS61023\", or a few words" } },
    required: ["query"],
  },
  async prepare(_project, input, ctx) {
    if (!ctx.parts) return { error: `${UNAVAILABLE}. Make the part with create_part from the datasheet and tell the user it is unverified.` }
    const query = String(input.query).trim()
    const index = ctx.parts.index
    // Both at once: the database answers in tens of milliseconds, and it still answers when the supplier is busy.
    const [supplier, stored] = await Promise.all([
      ctx.parts.search(query, ctx.signal).then(
        (response) => ({ response }),
        (e: unknown) => ({ error: lookupMessage(e) }),
      ),
      index
        ? index.search(query, { limit: STORED_SHOWN * 2, full: true }, ctx.signal).then(
            (r) => ({ hits: r.hits, credit: r.attribution }),
            () => ({ hits: [] as PartIndexHit[], credit: [] as string[] }),
          )
        : Promise.resolve({ hits: [] as PartIndexHit[], credit: [] as string[] }),
    ])
    if ("error" in supplier && !stored.hits.length) return { error: supplier.error }
    return {
      response: "response" in supplier ? supplier.response : null,
      ...("error" in supplier && { supplierError: supplier.error }),
      stored: stored.hits,
      storedCredit: stored.credit,
    }
  },
  run(project, input, prepared) {
    const query = String(input.query).trim()
    if (!prepared || "error" in prepared) return fail(project, prepared?.error ?? UNAVAILABLE)
    const fromDatabase = storedSection(prepared.stored, prepared.storedCredit, prepared.response)
    if (!prepared.response) {
      return ok(
        project,
        `The supplier search failed (${prepared.supplierError?.replace(/\.$/, "") ?? "no answer"}), but the parts database answered.${fromDatabase || ` It has nothing for "${query}" either.`}`,
        `Supplier search failed; ${prepared.stored.length} stored part(s) for "${query}"`,
      )
    }
    const { candidates, attribution } = prepared.response
    if (!candidates.length) {
      return ok(
        project,
        `No supplier parts match "${query}".${fromDatabase || " Try the exact part number, or make the part from the datasheet with create_part (it will be marked unverified)."}`,
        `No supplier parts for "${query}"`,
      )
    }
    const unread = candidates.filter((c) => c.hasVendorPinout === null || c.hasVendorLand === null).length
    const rows = candidates.map((c) => {
      const data =
        c.hasVendorPinout === null || c.hasVendorLand === null
          ? "couldn't read this record, so its pinout and land are unknown"
          : c.hasVendorPinout && c.hasVendorLand
            ? "pinout and land"
            : c.hasVendorLand
              ? "land only, no named pinout"
              : c.hasVendorPinout
                ? "pinout only, no land"
                : "no pinout or land"
      return `${c.lcsc} ${c.mpn}${c.manufacturer ? ` (${c.manufacturer})` : ""}: ${c.package ?? "package unknown"}, ${c.pinCount ?? "?"} pins, ${data}, ${stockText(c.stock)} [${c.match}]`
    })
    const exact = candidates.filter((c) => c.match === "exact").length
    return ok(
      project,
      `${rows.join("\n")}\n` +
        `Build one with create_part lcsc "<number>". Prefer an exact match with a pinout and a land, in stock. ` +
        `A [prefix] match is the same number plus an ordering suffix (TPS61023DRLR for TPS61023): usually the same part, but check its package. create_part with just the name groups such variants by package and pins and builds from the best stocked.` +
        `${exact ? "" : ` None is exactly "${query}".`}` +
        `${unread ? `\n${unread} record${unread === 1 ? "" : "s"} couldn't be read, so ${unread === 1 ? "it" : "they"} may have a pinout: call find_part again before saying there is none.` : ""}\n${attribution}${fromDatabase}`,
      `Found ${candidates.length} supplier part(s) for "${query}"`,
    )
  },
}

// ---------- get_part_data ----------

type PartPrepared = { part: SupplierPart | null } | { stored: PartIndexPart | null; id: string } | { error: string }

const DATABASE_UNAVAILABLE = "The parts database isn't available in this editor: use lcsc or the part's name instead"

/** A stored part by its database id, as a prepared answer: a failed read is said, never taken for "no such part". */
async function fetchStored(id: string, ctx: ToolContext): Promise<{ stored: PartIndexPart | null; id: string } | { error: string }> {
  const index = ctx.parts?.index
  if (!index) return { error: `${DATABASE_UNAVAILABLE}.` }
  if (!/^\d{1,18}$/.test(id)) return { error: `database_id is a number from find_part's parts database list, not "${id}".` }
  try {
    return { stored: await index.part(id, ctx.signal), id }
  } catch (e) {
    return { error: lookupMessage(e) }
  }
}

/** A stored part's pins and land in the words get_part_data uses for a supplier's. */
function storedPartText(part: PartIndexPart): string {
  const land = describeLand(summarizeLand(supplierLandPads(part)))
  const origin =
    part.source === "kicad"
      ? `KiCad library part ${part.sourceKey}${part.provenance.release ? ` (release ${part.provenance.release})` : ""}`
      : `LCSC ${part.lcsc ?? part.sourceKey}, a supplier record the parts database kept${part.verification === "consensus" ? " (its drawings agree)" : part.verification === "curated" ? " (checked by hand)" : ""}`
  return [
    `database_id ${part.id}: ${part.mpn}${part.manufacturer ? ` by ${part.manufacturer}` : ""}, ${part.package ?? "package unknown"}, from the ${origin}.${part.description ? ` ${part.description}.` : ""}`,
    `${part.lcsc ? `LCSC ${part.lcsc}. ` : ""}${part.datasheet ? `Datasheet: ${part.datasheet}` : ""}`.trim(),
    `Pins (${part.pins.length}): ${pinMapText(part.pins)}`,
    `Land (from ${part.land.from}): ${land}.`,
    part.provenance.attribution,
  ]
    .filter(Boolean)
    .join("\n")
}

async function fetchPart(lcsc: string, ctx: ToolContext): Promise<{ part: SupplierPart | null } | { error: string }> {
  if (!ctx.parts) return { error: `${UNAVAILABLE}.` }
  try {
    return { part: await ctx.parts.part(lcsc, ctx.signal) }
  } catch (e) {
    return { error: lookupMessage(e) }
  }
}

const normalizeLcsc = (raw: unknown) => String(raw ?? "").trim().toUpperCase()

function confidenceText(part: SupplierPart) {
  const p = part.provenance
  if (p.confidence === "curated") return "checked by hand against the datasheet or a second library"
  if (p.confidence === "consensus") return `${p.vendors} supplier drawings agree`
  if (p.confidence === "disputed") return `supplier drawings disagree: ${p.disputes.join(" ")}`
  return "one supplier drawing"
}

const uploadNote = " This record is an EasyEDA user's upload, not an LCSC catalogue part: lower confidence, so tell the user to check it against the datasheet."

const partialNote = (part: SupplierPart) => (part.provenance.partial ? " Other supplier drawings of it couldn't be read, so more may agree than this says: ask again for a fuller answer." : "")

export const getPartDataTool: ToolSpec<PartPrepared> = {
  name: "get_part_data",
  description:
    "Read one supplier part by LCSC number, or one stored part by database_id (from find_part's parts database list): its pins (number, name, and whether each is a supply, ground, exposed pad or not connected), package, land pattern in millimetres, datasheet link, and for a supplier part its stock and how many supplier drawings agree on the pins.",
  input_schema: {
    type: "object",
    properties: {
      lcsc: { type: "string", description: "LCSC number, e.g. \"C1852149\"" },
      database_id: { type: "string", description: "A stored part's id from find_part, e.g. \"18342\"" },
    },
  },
  prepare(_project, input, ctx) {
    const id = String(input.database_id ?? "").trim()
    if (id) return fetchStored(id, ctx)
    const lcsc = normalizeLcsc(input.lcsc)
    if (!lcsc) return Promise.resolve({ error: "Pass lcsc (an LCSC number) or database_id (a stored part from find_part)." })
    return fetchPart(lcsc, ctx)
  },
  run(project, input, prepared) {
    const lcsc = normalizeLcsc(input.lcsc)
    if (!prepared || "error" in prepared) return fail(project, prepared?.error ?? UNAVAILABLE)
    if ("stored" in prepared) {
      if (!prepared.stored) return fail(project, `No part ${prepared.id} is stored whole in the parts database. Find one with find_part.`)
      return ok(project, storedPartText(prepared.stored), `Read ${prepared.stored.mpn} from the parts database`)
    }
    const part = prepared.part
    if (!part) return fail(project, `No supplier record for ${lcsc}. Find the LCSC number with find_part.`)
    const upload = part.provenance.userUpload ? uploadNote : ""
    const land = part.land ? describeLand(summarizeLand(supplierLandPads(part))) : null
    const lines = [
      `${part.lcsc}: ${part.mpn}${part.manufacturer ? ` by ${part.manufacturer}` : ""}, ${part.package ?? "package unknown"}.${part.description ? ` ${part.description}.` : ""}`,
      `${stockText(part.stock)}.${part.datasheet ? ` Datasheet: ${part.datasheet}` : ""}`,
      part.pins
        ? `Pins (${part.pins.length}, ${confidenceText(part)}): ${pinMapText(part.pins)}${partialNote(part)}`
        : "The supplier's symbol numbers its pins without naming them: there is no pinout to use.",
      land ? `Land (from ${part.land!.from}): ${land}.` : "No land pattern: create_part needs a footprint for this one.",
      part.provenance.attribution,
    ]
    return ok(project, `${lines.join("\n")}${upload}`, `Read ${part.lcsc} (${part.mpn})`)
  },
}

// ---------- create_part ----------

const PIN_KINDS = ["passive", "input", "output", "io", "power", "ground", "nc"]
const PIN_SIDES: PinSide[] = ["left", "right", "top", "bottom"]

type DrawnPinInput = { number: string; name: string; kind?: string; side?: PinSide }

const mmField = (description?: string): JsonSchema => ({ type: "number", ...(description && { description }) })

/** create_part's `land`: a land pattern pad by pad, or a KiCad footprint file's text. Unknown fields are refused, not dropped. */
const LAND_SCHEMA: JsonSchema = {
  type: "object",
  description:
    "Instead of footprint: the land pad by pad, or kicad_mod alone. Millimetres seen from the top, x right, y up (KiCad's y points down; a bottom view is mirrored); any origin.",
  additionalProperties: false,
  properties: {
    pads: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["x", "y"],
        properties: {
          number: { type: "string", description: "Its pin; none for a pad that is no pin" },
          x: mmField(),
          y: mmField(),
          shape: { type: "string", enum: ["rect", "roundrect", "circle", "oval"] },
          w: mmField(),
          h: mmField(),
          d: mmField("A circle's diameter"),
          drill: mmField("Hole diameter (a slot's width): through-hole"),
          slot_length: mmField("Slot length, along the pad's longer side"),
          plated: { type: "boolean", description: "false: a bare mounting hole, no number" },
          rotation: mmField("Degrees counter-clockwise"),
          corner_ratio: mmField("roundrect, to 0.5; default 0.25"),
          paste: { type: "boolean", description: "false: no paste" },
          paste_margin: mmField(),
          paste_ratio: mmField("Negative shrinks, e.g. -0.3 on a thermal pad"),
          mask_margin: mmField(),
        },
      },
    },
    body: {
      type: "object",
      description: "Body outline, two opposite corners",
      additionalProperties: false,
      required: ["x1", "y1", "x2", "y2"],
      properties: { x1: mmField(), y1: mmField(), x2: mmField(), y2: mmField() },
    },
    courtyard_margin: mmField("Default 0.25"),
    package: { type: "string", description: "e.g. TO-220-3, for the 3D body" },
    kicad_mod: { type: "string", description: "A .kicad_mod file's text, e.g. a vendor's download the user gave you" },
  },
}

/** A land the call gave whole (`land`), registered so its name resolves; null when it gave none. */
function landOf(input: ToolInput, partName: string): { land: FootprintDef; from: string } | { problem: string } | null {
  if (input.land === undefined) return null
  const raw = input.land as DrawnLandInput & { kicad_mod?: string }
  if (typeof input.footprint === "string" && input.footprint.trim()) return { problem: "Pass footprint or land, not both." }
  let got: { land: FootprintDef; from: string }
  if (raw.kicad_mod !== undefined) {
    if (raw.pads || raw.body || raw.courtyard_margin !== undefined || raw.package) return { problem: "land.kicad_mod is a whole land: pass it alone, or pads without it." }
    const read = kicadFootprintLand(raw.kicad_mod)
    if ("problem" in read) return { problem: `Can't read land.kicad_mod: ${read.problem}` }
    got = { land: read.land, from: `the KiCad footprint ${read.name}` }
  } else {
    const drawn = drawnLand(raw, partName)
    if ("problem" in drawn) return { problem: `Can't draw the land: ${drawn.problem}.` }
    got = { land: drawn.land, from: "the pads you gave" }
  }
  registerProjectFootprints({ footprints: [got.land] })
  return got
}

type CreatePrepared =
  | {
      kind: "supplier"
      part: SupplierPart
      via: "lcsc" | "name"
      /** Which of several part numbers was chosen, and why. */
      chosen?: string | null
      /** KiCad's drawing of the same part, where it disagrees with the supplier's. */
      opinion?: string | null
    }
  /**
   * A part the parts database stores whole. `note` says why it was chosen; `check` is the supplier's
   * verdict on a KiCad part, when one could be read.
   */
  | {
      kind: "database"
      part: PartIndexPart
      note: string | null
      check?: PartCheckResult
      /** The name asked for, when the stored part is a KiCad symbol drawn for a family of numbers: it is the part number. */
      asName?: string
    }
  /** The lookup settled it: no such LCSC number, a name that is several parts, or pins that are wrong. */
  | { kind: "refused"; text: string }
  /**
   * Built from the copilot's own pins and footprint, and why. `pending` is set when the lookup
   * failed: the part is made, marked unverified, with a re-check waiting.
   */
  | { kind: "memory"; note: string; pending?: string }

const drawnPinsOf = (input: ToolInput): DrawnPinInput[] | null =>
  Array.isArray(input.pins) && input.pins.length
    ? (input.pins as DrawnPinInput[]).map((p) => ({ ...p, number: String(p.number).trim(), name: String(p.name).trim() || String(p.number).trim() }))
    : null

/**
 * What the supplier's verdict on a KiCad part means for the result and the part: a contradiction is
 * said and kept (Checks shows it as an error), agreement is said, and a lookup that failed leaves a
 * pending check, so verify_parts compares it once the supplier is back.
 */
function kicadCheckNote(part: PartIndexPart, verdict: Awaited<ReturnType<typeof supplierVerdict>>): { note: string | null; check?: PartCheckResult } {
  if ("failed" in verdict) {
    return {
      note: `It couldn't be compared with the supplier (${verdict.failed.replace(/\.$/, "")}); call verify_parts later.`,
      check: { at: new Date().toISOString(), verdict: "pending", findings: [verdict.failed] },
    }
  }
  const r = verdict.result
  if (r.verdict === "contradicted") {
    return {
      check: r,
      note: `LCSC ${r.lcsc ?? "the supplier"} disagrees with KiCad's drawing of ${part.mpn}: ${r.findings.join(" ")} It is built as KiCad draws it, and Checks shows the disagreement as an error: tell the user to check those pins against the datasheet${r.lcsc ? `, or rebuild it with create_part lcsc "${r.lcsc}" and replaces` : ""}.`,
    }
  }
  if (r.verdict === "agrees" || r.verdict === "renamed") return { check: r, note: `Its pins agree with LCSC ${r.lcsc}.` }
  // No one supplier record to compare (none, several packages, other pin counts): built as KiCad draws it.
  return { check: r, note: null }
}

/**
 * create_part database_id: the stored part, with the copilot's pins compared to it, and a KiCad part
 * compared with the supplier's record of its number. KiCad's libraries are drawn with care, and so
 * are LCSC's best records, so a disagreement between them is worth a person's look: the part is
 * built from KiCad's drawing as asked, and the supplier's verdict is kept on it, where Checks shows
 * a contradiction as an error.
 */
async function prepareStored(id: string, drawn: DrawnPinInput[] | null, asked: string, ctx: ToolContext): Promise<CreatePrepared> {
  const got = await fetchStored(id, ctx)
  if ("error" in got) return { kind: "refused", text: got.error }
  const part = got.stored
  if (!part) return { kind: "refused", text: `No part ${id} is stored whole in the parts database. Find one with find_part.` }
  if (drawn) {
    const cmp = comparePins(drawn, part.pins)
    if (cmp.verdict === "contradicted") {
      return {
        kind: "refused",
        text: `Can't make ${part.mpn} as given. ${cmp.fatal.length} pin${cmp.fatal.length === 1 ? "" : "s"} contradict ${storedName(part)}: ${cmp.fatal
          .slice(0, 6)
          .map((f) => f.text)
          .join("; ")}. Call create_part again with database_id "${id}" and without pins.`,
      }
    }
  }
  if (part.source !== "kicad" || !ctx.parts) return { kind: "database", part, note: null }
  // A KiCad wildcard (`STM32F103C8Tx`) is no number to order or look up: the name asked, when it
  // fills the x's, is both; without one there is nothing to compare it with.
  const wild = /[A-Z0-9]x{1,2}$/.test(part.mpn)
  const asName = wild && asked && isWildcardOf(asked, part.mpn) ? asked : undefined
  if (wild && !asName) return { kind: "database", part, note: `${part.mpn} is drawn for a family of part numbers: pass name with the one the user means, which is its number and what the supplier is asked about.` }
  const built = draftFromIndexPart(part)
  if ("error" in built) return { kind: "refused", text: `Can't make ${part.mpn} from the parts database: ${built.error}.` }
  const verdict = await supplierVerdict(ctx.parts, { name: asName ?? part.mpn, pins: built.draft.pins, footprint: built.draft.footprint, props: {} }, { lands: false, signal: ctx.signal })
  return { kind: "database", part, asName, ...kicadCheckNote(part, verdict) }
}

export const createPartTool: ToolSpec<CreatePrepared> = {
  name: "create_part",
  description: `Make a part the library doesn't have (an IC, sensor, regulator, connector, discrete...), store it in this project and return its part_id for add_component. Use it only when search_parts has nothing suitable.

Build it from supplier data:
- Pass lcsc (an LCSC number from find_part, e.g. "C1852149"): pins and land come from the supplier. Leave pins and footprint out unless you want yours checked against it.
- Without lcsc, create_part looks up the name (or props.mpn) itself, and it need not be an exact orderable number: ADS1115, TPS61023 and SHT31-DIS find ADS1115IDGSR, TPS61023DRLR and SHT31-DIS-F2.5kS. Part numbers that start with the name and share a package and every pin's function are one part, and the best stocked is built (the result says which; a reviewed LCSC record outranks a user upload). So for "add an ADS1115", pass name "ADS1115" (and the footprint family you expect, such as vssop10) and no pins.
- A name sold in several packages or pinouts (ADS1115 in VSSOP-10 and X2QFN-10) is refused with a short list, best stocked (or most common) first, and what differs pin by pin: pass the lcsc of the one the user means, or of the first, and tell them which package you chose.
- Pins or a footprint you pass are compared with every supplier part the name could mean, pin role by pin role and pad by pad; a mismatch is refused with the pins and millimetres that differ. Then use the supplier's.
- database_id (from find_part's parts database list) builds a part the parts database stores whole, a KiCad library part or a kept supplier record, with no supplier lookup. A KiCad part is compared with the supplier's record of its number; a disagreement is said in the result and shown as an error in Checks.
- Without lcsc or database_id the parts database is asked too: when the supplier fails or has no part numbered like the name, a stored part that is the name is built (the result says which), and stored parts that may be another package of it are listed to choose by database_id.
- Only when neither has the part is it made from your pins and footprint, marked unverified: tell the user. A failed lookup (supplier down or busy) with nothing in the database does the same, with a re-check pending: say so, and call verify_parts later.
- from_memory true is for a part with no supplier part to compare: honoured when no supplier part numbered like the name has your pin count, or there is none; refused whenever one that could be it exists.

From memory (no supplier record):
- pins: every pin, numbered as on the datasheet (the footprint's pad numbers), unused ones too (name NC, kind nc). An exposed pad is numbered one past the last lead (17 on a 16-lead QFN), usually GND. Supplies (kind power) and grounds (kind ground) sit top and bottom, inputs left and outputs right, or set side.
- footprint, with the package's real pitch and size: soic8, soic16 (1.27 mm); tssop8_p0.65mm, tssop20_p0.65mm, ssop24_p0.65mm; vssop8 (0.65 mm), vssop10 (0.5 mm) for MSOP; sot23, sot23_5, sot23_6, sot563, sot363, sot223, sot89; qfn16_w4_h4_p0.65mm_thermalpad, dfn8_w2.5_p0.5mm_pl0.5mm_pw0.25mm (approximations: prefer the supplier's land); lqfp48, tqfp32_p0.8mm, to220_3, to92, sod123, sod323, sma, dip8, pinrow4 (2.54 mm header), pinrow2_p5.08mm (terminal block), jst_ph_4, hc49; chips 0201, 0402, 0603, 0805, 1206. Refused, as they draw another land: dfn8, ssopN, tssopN, msop8, msop10, and qfnN or sonN with no size. Pads that share a pin (a SOT-223 tab) are mapped with pad_alias.
- land, instead of footprint, when no footprint string draws it (a staggered or offset pin, an odd connector, a module): each pad's number, place, shape, size and through-hole drill, off the datasheet's drawing; pads with one number are one pin. Or land.kicad_mod with a KiCad footprint file's text. The result describes the land: compare it with the datasheet.
- symbol: leave it out for ICs and modules (a box). For discretes pick one; polarized ones need pins named A/K, +/-, B/C/E or G/D/S.`,
  input_schema: {
    type: "object",
    properties: {
      lcsc: { type: "string", description: "LCSC number to build from, e.g. \"C1852149\"" },
      database_id: { type: "string", description: "A stored part's id from find_part's parts database list, to build from it" },
      name: { type: "string", description: "Part name, normally the MPN, e.g. \"TPS63020\"; the supplier's MPN when lcsc is given" },
      description: { type: "string", description: "One line: what it is and its key specs" },
      category: { type: "string", enum: CUSTOM_CATEGORIES },
      footprint: { type: "string", description: "Only from memory, or to check yours against the supplier's land" },
      land: LAND_SCHEMA,
      pins: {
        type: "array",
        minItems: 1,
        description: "Only from memory, or to check yours against the supplier's pinout",
        items: {
          type: "object",
          properties: {
            number: { type: "string", description: "Pad number as a string, e.g. \"1\"" },
            name: { type: "string", description: "Datasheet pin name, e.g. \"VIN\"" },
            kind: { type: "string", enum: PIN_KINDS },
            side: { type: "string", enum: PIN_SIDES },
          },
          required: ["number", "name"],
        },
      },
      from_memory: { type: "boolean", description: "Only for a part the supplier has nothing to compare with: make it from your own pins and footprint when the supplier's parts numbered like the name have another pin count (they are other parts) or there are none. Refused if supplier parts that could be it exist. It is marked unverified" },
      symbol: { type: "string", enum: Object.keys(CUSTOM_SYMBOLS) },
      ref_prefix: { type: "string", description: "Designator prefix, e.g. U, J, Q; defaults by category and symbol" },
      props: {
        type: "object",
        description: "Default properties: mpn, manufacturer, datasheet (URL), value",
        additionalProperties: { type: "string" },
      },
      pad_alias: {
        type: "object",
        description: "Extra pad number -> the pin it belongs to, e.g. {\"4\": \"2\"} for a SOT-223 tab",
        additionalProperties: { type: "string" },
      },
      keywords: { type: "array", items: { type: "string" } },
      replaces: { type: "string", description: "part_id of a part made earlier in this project that this definition corrects; its components switch to the new one" },
    },
    required: ["category"],
  },
  async prepare(_project, input, ctx): Promise<CreatePrepared> {
    const databaseId = String(input.database_id ?? "").trim()
    if (databaseId && normalizeLcsc(input.lcsc)) return { kind: "refused", text: "Pass lcsc or database_id, not both: they are different records." }
    if (databaseId) return prepareStored(databaseId, drawnPinsOf(input), String(stringProps(input.props)?.mpn || input.name || "").trim(), ctx)
    const lcsc = normalizeLcsc(input.lcsc)
    if (lcsc) {
      if (!ctx.parts) return { kind: "refused", text: `${UNAVAILABLE}, so lcsc can't be used: pass pins and footprint from the datasheet without lcsc, and tell the user the part is unverified.` }
      const got = await fetchPart(lcsc, ctx)
      if ("error" in got) return { kind: "refused", text: `${got.error} Try again, or pass pins and footprint without lcsc and tell the user the part is unverified.` }
      if (!got.part) return { kind: "refused", text: `No supplier record for ${lcsc}. Find the LCSC number with find_part.` }
      return { kind: "supplier", part: got.part, via: "lcsc" }
    }
    const props = stringProps(input.props) ?? {}
    const name = (props.mpn || String(input.name ?? "")).trim()
    if (!name) return { kind: "memory", note: "no part number to look up" }
    if (!ctx.parts) return { kind: "memory", note: "supplier lookup isn't available in this editor" }
    const pins = drawnPinsOf(input)
    const hints = { pins: pins ?? undefined, footprint: typeof input.footprint === "string" ? input.footprint : undefined }
    const index = ctx.parts.index
    // The supplier and the database at once: the database is quick, and it is what is left when the supplier fails.
    const [found, stored] = await Promise.all([
      resolvePartName(ctx.parts, name, hints, ctx.signal),
      index ? resolveStored(index, name, hints, ctx.signal) : Promise.resolve<StoredResolution>({ kind: "none" }),
    ])
    if (found.kind === "found") {
      // The supplier's part is built, unless it is weaker than what is stored: a user's upload, or a
      // record with no land (which would leave the footprint to memory), beside a stored part that is the name.
      const weaker = found.part.provenance.userUpload ? "is an EasyEDA user's upload" : !found.part.land && !hints.footprint ? "has no land pattern" : null
      if (weaker && stored.kind === "found") {
        return { kind: "database", part: stored.part, note: `LCSC ${found.part.lcsc} ${weaker}, so it was built from the parts database. ${stored.note}`, asName: stored.wildcard ? name : undefined }
      }
      const opinion = stored.kind === "found" ? secondOpinion(stored.part, found.part) : null
      return { kind: "supplier", part: found.part, via: "name", chosen: found.chosen, opinion }
    }
    if (found.kind === "ambiguous") return { kind: "refused", text: found.text }
    // Pins that contradict every supplier part the name could mean: a wrong part, however it is
    // spelled, and never made from memory (from_memory doesn't reach here).
    if (found.kind === "contradicted") {
      return {
        kind: "refused",
        text: `Can't make ${name} as given. ${found.text} Call create_part again with lcsc of the one the user means (${found.candidates.slice(0, 3).map((c) => `${c.lcsc} ${c.mpn}`).join(", ")}) and without your pins: the supplier's pin names are the right ones.`,
      }
    }
    // From here the supplier has no part to build: a stored part that is the name is the next best
    // thing, and far better than memory. One the drawing's pins contradict is refused the same way.
    if (stored.kind === "found") {
      const why =
        found.kind === "failed"
          ? `The supplier lookup failed (${found.text.replace(/\.$/, "")}). `
          : found.kind === "different"
            ? `The supplier's parts numbered like ${name} have another pin count. `
            : `No supplier record names ${name}'s pins. `
      // A KiCad part built while the supplier is failing is compared later, as a memory part would be.
      const pending: PartCheckResult | undefined =
        found.kind === "failed" && stored.part.source === "kicad" ? { at: new Date().toISOString(), verdict: "pending", findings: [found.text] } : undefined
      return { kind: "database", part: stored.part, note: `${why}${stored.note}`, asName: stored.wildcard ? name : undefined, ...(pending && { check: pending }) }
    }
    if (stored.kind === "contradicted") return { kind: "refused", text: `Can't make ${name} as given. ${stored.text} Leave your pins out to build it from the parts database.` }
    const complete = !!pins && ((typeof input.footprint === "string" && !!input.footprint.trim()) || input.land !== undefined)
    // Stored parts that may be another package of it are a choice to make, not memory to fall back on.
    if (stored.kind === "offered" && !(input.from_memory === true && complete)) {
      const lead = found.kind === "failed" ? `The supplier lookup failed (${found.text.replace(/\.$/, "")}). ` : found.kind === "different" ? `${found.text} ` : ""
      return { kind: "refused", text: `${lead}${stored.text} If none of them is the part, pass from_memory true with pins and footprint (or land).` }
    }
    // A lookup that failed is not an answer: the part is made, plainly unverified, with a re-check pending.
    if (found.kind === "failed") return { kind: "memory", note: `the supplier lookup failed (${found.text.replace(/\.$/, "")})`, pending: found.text }
    // Supplier parts numbered like the name but with another pin count are other parts: refused
    // with the list so the copilot picks one knowingly. Only `from_memory` (the user's part really
    // has nothing to compare) goes on to an unverified part from the copilot's own pins and
    // footprint, saying why.
    if (found.kind === "different") {
      return input.from_memory === true && complete ? { kind: "memory", note: found.note } : { kind: "refused", text: found.text }
    }
    return { kind: "memory", note: found.text.replace(/\.$/, "") }
  },
  run(project, input, prepared) {
    if (prepared?.kind === "refused") return fail(project, prepared.text)
    const category = input.category as PartCategory
    const props = stringProps(input.props)
    const padAlias = stringProps(input.pad_alias)
    if (!props || !padAlias) return fail(project, "props and pad_alias must be objects of string values")
    const symbol = typeof input.symbol === "string" && input.symbol ? input.symbol : undefined
    const refPrefix =
      (typeof input.ref_prefix === "string" && input.ref_prefix.trim().toUpperCase()) ||
      (symbol && CUSTOM_SYMBOLS[symbol]?.ref) ||
      DEFAULT_REF_PREFIX[category]
    const keywords = Array.isArray(input.keywords) ? (input.keywords as string[]).map((k) => k.trim()).filter(Boolean) : []
    const drawn = drawnPinsOf(input)
    const footprintString = typeof input.footprint === "string" && input.footprint.trim() ? input.footprint.trim() : null
    const options = footprintString && footprintOptionProblem(footprintString)
    if (options) return fail(project, `Can't make ${String(input.name ?? "").trim() || "the part"}: ${options} ${DRAWN_LAND_ADVICE}`)
    const given = landOf(input, String(input.name || props.mpn || input.lcsc || "").trim())
    if (given && "problem" in given) return fail(project, given.problem)
    // A land given whole is checked and used as a footprint string is, by the name it was registered under.
    const footprintIn = given ? given.land.name : footprintString
    const footprintLabel = given ? `the land from ${given.from}` : footprintIn

    let name = String(input.name ?? "").trim()
    let description = String(input.description ?? "").trim()
    let pins: CustomPartSpec["pins"]
    let footprint: string
    let land: FootprintDef | null = null
    let source: PartSource
    let notes: string[] = []
    let check: SupplierCheck | null = null
    let storedModel: Model3D | null = null
    let storedRef: string | null = null

    if (prepared?.kind === "database") {
      const part = prepared.part
      const built = draftFromIndexPart(part)
      if ("error" in built) return fail(project, `Can't make ${part.mpn} from the parts database: ${built.error}.`)
      const d = built.draft
      // The stored land is the part's: a footprint passed with it is not used.
      if (footprintIn && footprintIn !== d.footprint) notes.push(`The stored land was used, not ${footprintLabel}.`)
      if (prepared.note) notes.push(prepared.note)
      if (prepared.asName && !props.mpn) props.mpn = prepared.asName
      name ||= prepared.asName ?? d.name
      description ||= d.description
      pins = d.pins
      footprint = d.footprint
      land = built.land
      source = { ...d.source!, ...(prepared.check && { check: prepared.check }) }
      for (const [key, value] of Object.entries(d.props)) if (value && !props[key]) props[key] = value
      for (const k of d.keywords ?? []) if (!keywords.includes(k)) keywords.push(k)
      storedRef = typeof input.ref_prefix === "string" && input.ref_prefix.trim() ? null : (d.refPrefix ?? null)
      storedModel = built.model
    } else if (prepared?.kind === "supplier") {
      const part = prepared.part
      check = checkAgainstSupplier({ pins: drawn, footprint: footprintIn, ...(given && { landLabel: `The land from ${given.from}` }) }, part)
      if (check.refusals.length) {
        return fail(project, `Can't make ${name || part.mpn} as given. ${check.refusals.join(" ")} Call create_part again with lcsc "${part.lcsc}" and without the pins, footprint or land that disagree, and wire it by the supplier's pin names.`)
      }
      notes = check.notes
      if (prepared.chosen) notes = [prepared.chosen, ...notes]
      if (prepared.opinion) notes = [...notes, prepared.opinion]
      if (part.provenance.userUpload) notes = [...notes, uploadNote.trim()]
      name ||= part.mpn
      description ||= part.description ?? part.mpn
      let pinsFrom: PartSource["pins"] = "supplier"
      if (part.pins) {
        pins = supplierPins(part.pins, drawn?.map((p) => ({ ...p, kind: p.kind as CustomPartSpec["pins"][number]["kind"] })) ?? [])
      } else {
        const pads = [...new Set((part.land?.pads ?? []).map((p) => p.number).filter(Boolean))]
        if (drawn) {
          pins = drawn.map((p) => ({ number: p.number, name: p.name, ...(p.kind && { kind: p.kind as CustomPartSpec["pins"][number]["kind"] }), ...(p.side && { side: p.side }) }))
          // A two-pad part's ends are its pinout; anything bigger is the copilot's word for it.
          if (pads.length > 2) pinsFrom = "memory"
        } else if (pads.length && pads.length <= 2) {
          pins = pads.map((n) => ({ number: n, name: n }))
        } else {
          return fail(project, `LCSC ${part.lcsc}'s symbol numbers its ${pads.length || "?"} pins without naming them, so there is no pinout to build from. Pass pins from the datasheet with lcsc "${part.lcsc}" (the land still comes from the supplier), and tell the user the pinout is unverified.`)
        }
      }
      let landFrom: PartSource["land"]
      if (footprintIn) {
        footprint = footprintIn
        land = given?.land ?? null
        landFrom = part.land ? "checked" : "memory"
        if (!part.land) {
          const named = footprintNameProblem(footprintIn)
          if (named) return fail(project, named)
        }
      } else {
        const chosen = landForSupplierPart(part)
        if (!chosen) return fail(project, `LCSC ${part.lcsc} has no land pattern. Pass footprint, a footprinter string for ${part.package ?? "its package"}, or land with its pads from the datasheet.`)
        footprint = chosen.footprint
        land = chosen.def
        landFrom = chosen.matched ? "checked" : "supplier"
      }
      for (const [key, value] of [
        ["mpn", part.mpn],
        ["manufacturer", part.manufacturer],
        ["datasheet", part.datasheet],
        ["lcsc", part.lcsc],
      ] as const) {
        if (value && !props[key]) props[key] = value
      }
      source = {
        pins: pinsFrom,
        land: landFrom,
        supplier: {
          lcsc: part.lcsc,
          mpn: part.mpn,
          confidence: part.provenance.confidence,
          vendors: part.provenance.vendors,
          fetchedAt: part.provenance.fetchedAt,
          ...(part.provenance.disputes.length && { disputes: part.provenance.disputes }),
          ...(part.provenance.userUpload && { userUpload: true }),
          ...(part.provenance.attribution && { attribution: part.provenance.attribution }),
        },
      }
    } else {
      const note = prepared?.kind === "memory" ? prepared.note : "no supplier lookup was made"
      if (!name) return fail(project, "name is required when lcsc isn't given")
      if (!drawn || !footprintIn) {
        return fail(project, `No supplier record to build ${name} from (${note}). Pass pins and footprint (or land, pad by pad) from the datasheet; the part will be marked unverified, so tell the user.`)
      }
      const named = footprintNameProblem(footprintIn)
      if (named) return fail(project, `Can't make ${name}: ${named}`)
      pins = drawn.map((p) => ({ number: p.number, name: p.name, ...(p.kind && { kind: p.kind as CustomPartSpec["pins"][number]["kind"] }), ...(p.side && { side: p.side }) }))
      footprint = footprintIn
      land = given?.land ?? null
      const pending = prepared?.kind === "memory" ? prepared.pending : undefined
      source = {
        pins: "memory",
        land: "memory",
        note,
        ...(pending && { check: { at: new Date().toISOString(), verdict: "pending" as const, findings: [pending] } }),
      }
    }
    if (!description) return fail(project, "description is required when lcsc isn't given")
    if (given && land === given.land) notes.push(`Land from ${given.from}: ${describeLand(summarizeLand(landPads(land.pads)))}.`)
    if (!props.mpn && ["ICs", "Power", "Modules", "Transistors", "Diodes"].includes(category)) props.mpn = name

    const draft: Omit<CustomPartSpec, "id"> = {
      name,
      description,
      category,
      refPrefix: storedRef ?? refPrefix,
      footprint,
      pins,
      ...(symbol && { symbol }),
      props,
      ...((props.value || props.mpn) && { valueProp: props.value ? "value" : "mpn" }),
      ...(Object.keys(padAlias).length && { padAlias }),
      ...(keywords.length && { keywords }),
      source,
    }
    if (land) registerProjectFootprints({ footprints: [land] })
    const problems = customPartProblems({ ...draft, id: "" })
    if (problems.length) return fail(project, `Can't make ${name || "the part"}: ${problems.join("; ")}`)

    const spec: CustomPartSpec = { id: customPartId(draft), ...draft }
    const part = buildCustomPart(spec)
    registerPart(part)
    // The supplier's 3D model comes with its land: the 3D view and the STEP export draw the part with it.
    const model3d = prepared?.kind === "supplier" ? supplierModelOn(prepared.part, spec.footprint) : storedModel
    // A part made now gets its model; one the project already has keeps what the user chose for it,
    // the generated body included, unless it was a memory part that only now has a record behind it.
    const withModel = (p: Project) => (model3d && !modelAssignment(p, spec.id, spec.footprint) ? setModel(p, spec.id, spec.footprint, model3d) : p)
    const replaces = typeof input.replaces === "string" ? input.replaces.trim() : ""
    if (replaces && !project.parts?.some((s) => s.id === replaces)) {
      return fail(project, `No part ${replaces} was made in this project; only parts from create_part can be replaced`)
    }
    const footprints = land && !project.footprints?.some((f) => f.name === land!.name) ? [...(project.footprints ?? []), land] : project.footprints
    const origin = describeSource(spec)
    const usage = `Pins: ${pinList(part.pins)}`
    const tail = notes.length ? ` ${notes.join(" ")}` : ""
    const existing = project.parts?.find((s) => s.id === spec.id)
    if (existing) {
      // The same drawing, now verified: keep the part, take the better provenance.
      // A stored part compared now keeps the verdict, as the result says: a real comparison (agrees,
      // renamed, contradicted) replaces whatever the part held, anything else fills only an empty or pending one.
      const compared = (v?: string) => v === "agrees" || v === "renamed" || v === "contradicted"
      const held = existing.source?.check
      if (source.pins === "database" && source.check && existing.source?.pins === "database" && (compared(source.check.verdict) || !held || held.verdict === "pending")) {
        const parts = project.parts!.map((s) => (s.id === spec.id ? { ...s, source: { ...s.source!, check: source.check } } : s))
        return ok({ ...project, parts, updatedAt: Date.now() }, `${name} already exists in this project as part_id "${spec.id}" (${origin}). ${usage}.${tail}`, `${name} already exists`)
      }
      if ((source.pins === "supplier" && existing.source?.pins !== "supplier") || (source.pins === "database" && (existing.source?.pins ?? "memory") === "memory")) {
        const parts = project.parts!.map((s) => (s.id === spec.id ? { ...s, source } : s))
        return ok(withModel({ ...project, parts, footprints, updatedAt: Date.now() }), `${name} already exists as part_id "${spec.id}"; it is now marked as ${origin}. ${usage}.${tail}`, `${name} verified (${origin})`)
      }
      return ok(project, `${name} already exists in this project as part_id "${spec.id}" (${origin}). ${usage}.${tail}`, `${name} already exists`)
    }
    let switched = 0
    const components = replaces
      ? project.components.map((c) => (c.partId === replaces ? (switched++, { ...c, partId: spec.id, footprint: spec.footprint }) : c))
      : project.components
    const parts = [...(project.parts ?? []).filter((s) => s.id !== replaces), spec]
    const next = withModel({ ...project, parts, components, footprints, updatedAt: Date.now() })
    if (switched) {
      // The new symbol puts its pins elsewhere, which can land them on other nets' wires.
      const joined = schematicEditProblems(project, next, getConnectivity(project), getConnectivity(next), new Set())
      if (joined.length) {
        return fail(
          project,
          `Not switched: ${name} draws its pins where ${joined.join("; ")}. Nothing was changed. Remove the ${switched} component(s) made from ${replaces} and add the new part with add_component part_id "${spec.id}" instead.`,
        )
      }
    }
    const after = replaces
      ? ` It replaces ${replaces}: ${switched} component(s) switched over; run_checks to find pins whose wiring moved.`
      : ` Add it with add_component part_id "${spec.id}".`
    const recheck = source.check?.verdict === "pending" ? " A re-check is pending: call verify_parts when the supplier lookup is back, and tell the user it is unverified until then." : ""
    const memory =
      source.pins === "memory"
        ? ` Its pinout and footprint are UNVERIFIED (${source.note ?? "made from memory"}): tell the user to check them against the datasheet.${recheck}`
        : source.pins === "database" && recheck
          ? " Its comparison with the supplier is pending: call verify_parts when the supplier lookup is back."
          : ""
    return ok(
      next,
      `Created part_id "${spec.id}" (${name}, ${origin}, footprint ${spec.footprint}).${memory} ${usage}.${tail}${after}`,
      source.pins === "memory"
        ? `Created part ${name} from memory (unverified)`
        : source.database
          ? `Created part ${name} from the parts database${source.check?.verdict === "contradicted" ? " (the supplier disagrees)" : ""}`
          : `Created part ${name} from LCSC ${source.supplier?.lcsc}`,
    )
  },
}

/** How a part was made, in a phrase: "from LCSC C1852149, 2 supplier drawings agree". */
export function describeSource(spec: Pick<CustomPartSpec, "source">): string {
  const s = spec.source
  // Changed by hand in the part editor: the user's word for the part, whatever it was built from.
  const edited = [s?.pins === "user" && "pins", s?.land === "user" && "land"].filter(Boolean)
  if (s && edited.length) {
    // What it was built from, which the rest of the source still names. A part from memory stays
    // `memory` however it is edited, so one the rest doesn't name is a library chip or a schematic's
    // part with both halves edited: nothing left says which.
    const was = s.file ? "file" : s.database ? "database" : s.supplier ? "supplier" : s.imported ? "import" : s.pins === "library" || s.land === "library" ? "library" : null
    if (!was) return `drawn by the user in the part editor, its ${edited.join(" and ")} edited by hand, which they stand by`
    const base = describeSource({ source: { ...s, pins: s.pins === "user" ? was : s.pins, land: s.land === "user" ? was : s.land } })
    return `${base}, then its ${edited.join(" and ")} edited by hand by the user, who stands by them`
  }
  if (s?.file) return `imported from the user's own KiCad files (${s.file.symbol ? `symbol ${s.file.symbol}, ` : "a footprint alone, a pin for each pad, "}footprint ${s.file.footprint}), pins and land from them`
  const d = s?.database
  if (s?.pins === "library") return "from the editor's own library, which listed chips and modules until October 2026; pins and land not checked against a supplier"
  if (s?.pins === "import") return `from the KiCad schematic ${s.imported?.file ?? "the user brought in"} (${s.imported?.libId ?? "its own symbol"}), drawn and pinned as that file has it`
  if (d?.origin === "kicad") return `from the KiCad library part ${d.key}${d.release ? ` (release ${d.release})` : ""}, pins and land from the library`
  if (d?.origin === "easyeda") return `from LCSC ${d.key}, a supplier record the parts database kept, pins and land from it`
  if (!s || !s.supplier) return "from memory"
  const conf =
    s.supplier.confidence === "curated"
      ? "pins checked by hand"
      : s.supplier.confidence === "consensus"
        ? `${s.supplier.vendors} supplier drawings agree`
        : s.supplier.confidence === "disputed"
          ? "supplier drawings disagree"
          : s.supplier.userUpload
            ? "one drawing, an EasyEDA user upload"
            : "one supplier drawing"
  const pins = s.pins === "supplier" ? "" : ", pins from memory"
  const land = s.land === "supplier" ? ", land from the supplier" : s.land === "checked" ? ", land checked against the supplier's" : ", land not checked"
  return `from LCSC ${s.supplier.lcsc}, ${conf}${pins}${land}`
}

// ---------- verify_parts ----------

export type { PartCheckResult }

export interface VerifyOutcome {
  results: Map<string, PartCheckResult>
  /** Parts whose lookup failed, each with the sentence for why: not checked, which is not the same as nothing to check. */
  failed: Map<string, string>
  /** Parts left for another call: over the per-call limit. */
  waiting: number
}

/**
 * Parts whose lookup failed lately go last in line, so one that keeps failing (or a rate limit
 * that hit the first ten) can't starve the parts behind it on every later call.
 */
const recentFailures = new Map<string, number>()
const FAILURE_MEMORY_MS = 10 * 60_000

/**
 * Check project parts against supplier records: each part's MPN (or name) is looked up as
 * create_part does, and its pins and footprint compared. Parts built from a supplier's pinout are
 * skipped unless named in `only`. At most `limit` parts per call: a part costs up to four lookups
 * (a search and three records), and ten of them stay inside the API's 60 lookups a minute. What
 * is left over is counted in `waiting`, never dropped silently, and a part whose lookup failed is
 * reported in `failed` rather than left out.
 */
export async function verifyProjectParts(
  project: Project,
  source: SupplierPartsSource,
  { only, signal, limit = 10 }: { only?: string[]; signal?: AbortSignal; limit?: number } = {},
): Promise<VerifyOutcome> {
  // By default the parts nobody has checked yet, so repeated calls work through a large project.
  const wanted = (project.parts ?? []).filter((s) => (only ? only.includes(s.id) : needsCheck(s)))
  const lately = (id: string) => {
    const at = recentFailures.get(id)
    return at !== undefined && Date.now() - at < FAILURE_MEMORY_MS ? 1 : 0
  }
  // Failed lately last, then unchecked before already checked, otherwise the project's order.
  const ordered = wanted
    .map((spec, i) => ({ spec, i }))
    .sort((a, b) => lately(a.spec.id) - lately(b.spec.id) || Number(!needsCheck(a.spec)) - Number(!needsCheck(b.spec)) || a.i - b.i)
    .map((x) => x.spec)
  const specs = ordered.slice(0, limit)
  const results = new Map<string, PartCheckResult>()
  const failed = new Map<string, string>()
  await Promise.all(
    specs.map(async (spec) => {
      // A stored or imported part's land is its own, drawn with other pads than a supplier's: compared by pins only.
      const ownLand = spec.source?.pins === "database" || spec.source?.pins === "file" || spec.source?.land === "user"
      const got = await supplierVerdict(source, spec, { lands: !ownLand, signal })
      if ("failed" in got) {
        recentFailures.set(spec.id, Date.now())
        failed.set(spec.id, got.failed)
        return
      }
      recentFailures.delete(spec.id)
      results.set(spec.id, got.result)
    }),
  )
  signal?.throwIfAborted()
  return { results, failed, waiting: ordered.length - specs.length }
}

/** What a verification did, in plain words: "Checked 3, couldn't check 7: <why>". Empty when there was nothing to do. */
export function describeVerify({ results, failed, waiting }: VerifyOutcome): string {
  if (!results.size && !failed.size && !waiting) return ""
  const why = [...new Set(failed.values())].slice(0, 2).map((t) => t.replace(/\.$/, ""))
  const parts = [`Checked ${results.size}`]
  if (failed.size) parts.push(`couldn't check ${failed.size}${why.length ? `: ${why.join("; ")}` : ""}`)
  const head = `${parts.join(", ")}.`
  return waiting ? `${head} ${waiting} more ${waiting === 1 ? "was" : "were"} not tried yet: run it again for the rest.` : head
}

/** Record check results on the project's parts. */
export function withPartChecks(project: Project, results: Map<string, PartCheckResult>): Project {
  if (!results.size) return project
  const parts = (project.parts ?? []).map((s) => {
    const check = results.get(s.id)
    if (!check) return s
    const base: PartSource = s.source ?? { pins: "memory", land: "memory" }
    return { ...s, source: { ...base, check } }
  })
  return { ...project, parts, updatedAt: Date.now() }
}

type VerifyPrepared = { outcome: VerifyOutcome } | { error: string }

export const verifyPartsTool: ToolSpec<VerifyPrepared> = {
  name: "verify_parts",
  description:
    "Check this project's own parts against supplier data: each part's MPN is looked up and its pins and footprint compared, role by pin role and pad by pad. Checks up to 10 parts per call, parts not checked yet first (all of them, or only part_ids), and says how many are left: call again for the rest. A part whose lookup failed is reported with the reason, not skipped. Parts built from supplier data are skipped unless named. Results show in run_checks and the Checks panel; rebuild a contradicted part with create_part lcsc and replaces.",
  input_schema: {
    type: "object",
    properties: { part_ids: { type: "array", items: { type: "string" }, description: "Only these parts; all unverified ones when left out" } },
  },
  async prepare(project, input, ctx) {
    if (!ctx.parts) return { error: `${UNAVAILABLE}.` }
    const only = Array.isArray(input.part_ids) ? (input.part_ids as string[]) : undefined
    try {
      return { outcome: await verifyProjectParts(project, ctx.parts, { only, signal: ctx.signal }) }
    } catch (e) {
      return { error: lookupMessage(e) }
    }
  },
  run(project, _input, prepared) {
    if (!prepared || "error" in prepared) return fail(project, prepared?.error ?? UNAVAILABLE)
    const { outcome } = prepared
    const { results, failed } = outcome
    const head = describeVerify(outcome)
    if (!head) return ok(project, "No unverified project parts to check.", "No parts to check")
    const name = (id: string) => project.parts?.find((s) => s.id === id)?.name ?? id
    const lines = [
      ...[...results].map(([id, r]) => `${name(id)} (${id}): ${r.verdict}${r.lcsc ? ` against LCSC ${r.lcsc}` : ""}${r.findings.length ? `. ${r.findings.join(" ")}` : ""}`),
      ...[...failed].map(([id, why]) => `${name(id)} (${id}): couldn't check. ${why}`),
    ]
    const bad = [...results.values()].filter((r) => r.verdict === "contradicted").length
    const text = `${head}\n${lines.join("\n")}${bad ? `\n${bad} part(s) contradict the supplier: rebuild each with create_part lcsc and replaces, then run_checks.` : ""}`
    // Nothing checked is a failure, said as one: never "nothing to check".
    if (!results.size) return { project, result: `Error: ${text}`, summary: head, isError: true }
    return ok(withPartChecks(project, results), text, `Checked ${results.size} part(s) against supplier data${failed.size ? `, couldn't check ${failed.size}` : ""}${bad ? `, ${bad} wrong` : ""}`)
  },
}
