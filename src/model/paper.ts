import { emptyBox, expandBox, round, type Box } from "../lib/geometry"
import { blockFrames } from "./blocks"
import { drawingBounds, SCH_UNIT_MM } from "./drawings"
import { schematicBounds } from "./instances"
import { labelBox } from "./labels"
import { ROOT_SHEET, sheetsOf, sheetUses, symbolsOnSheet, useAt } from "./sheets"
import type { PaperSize, Project, SheetPaper } from "./types"

// The page each sheet of the schematic is drawn on, as in Altium and KiCad: a paper size and orientation, a border with zones (1, 2, 3...
// across, A, B, C... down) and a title block in the bottom-right corner that fills itself in. The page is stored on the sheet
// (`SchematicSheet.paper`) and never moves or grows by itself: the user picks a size, Fit to drawing places it around the drawing, and
// a whole-sheet Tidy lays the drawing out on it and grows it a size when it must.
//
// Everything here is in KiCad's numbers, so the canvas shows what KiCad shows for the exported file: KiCad's sizes, and its default
// drawing sheet's border (a 10 mm margin, a frame there and another 2 mm inside it, a zone every 50 mm) and title block (108 by 32 mm
// against the inner frame's bottom-right corner). Boxes are in sheet units (12.7 mm), y up.

/** The named sizes in mm, landscape: KiCad's table. */
export const PAPER_MM: Record<Exclude<PaperSize, "User">, { width: number; height: number }> = {
  A5: { width: 210, height: 148 },
  A4: { width: 297, height: 210 },
  A3: { width: 420, height: 297 },
  A2: { width: 594, height: 420 },
  A1: { width: 841, height: 594 },
  A0: { width: 1189, height: 841 },
  A: { width: 279.4, height: 215.9 },
  B: { width: 431.8, height: 279.4 },
  C: { width: 558.8, height: 431.8 },
  D: { width: 863.6, height: 558.8 },
  E: { width: 1117.6, height: 863.6 },
  USLetter: { width: 279.4, height: 215.9 },
  USLegal: { width: 355.6, height: 215.9 },
  USLedger: { width: 431.8, height: 279.4 },
}

/** Every size, in the order a menu lists them. */
export const PAPER_SIZES: PaperSize[] = ["A5", "A4", "A3", "A2", "A1", "A0", "A", "B", "C", "D", "E", "USLetter", "USLegal", "USLedger", "User"]

/** What a size is called on screen and in the title block. */
export const PAPER_LABEL: Record<PaperSize, string> = {
  A5: "A5",
  A4: "A4",
  A3: "A3",
  A2: "A2",
  A1: "A1",
  A0: "A0",
  A: "ANSI A",
  B: "ANSI B",
  C: "ANSI C",
  D: "ANSI D",
  E: "ANSI E",
  USLetter: "US Letter",
  USLegal: "US Legal",
  USLedger: "US Ledger",
  User: "Custom",
}

export const isPaperSize = (v: unknown): v is PaperSize => typeof v === "string" && (PAPER_SIZES as string[]).includes(v)

/** The smallest and largest side of a custom page the Inspector takes, in mm: KiCad's largest schematic page is 120 inches. */
export const USER_PAPER_RANGE = { min: 100, max: 3048 }

const ISO: PaperSize[] = ["A5", "A4", "A3", "A2", "A1", "A0"]
const ANSI: PaperSize[] = ["A", "B", "C", "D", "E"]
// US Ledger is ANSI B, so the US sizes grow into ANSI's: Letter (or Legal) to Ledger, then C, D and E.
const US_LETTER: PaperSize[] = ["USLetter", "USLedger", "C", "D", "E"]
const US_LEGAL: PaperSize[] = ["USLegal", "USLedger", "C", "D", "E"]

/** The sizes a page grows through, smallest first: the one its size is in. `User` has none (it grows to just big enough). */
function paperFamily(size: PaperSize): PaperSize[] {
  if (ISO.includes(size)) return ISO
  if (ANSI.includes(size)) return ANSI
  if (size === "USLegal") return US_LEGAL
  if (size === "USLetter" || size === "USLedger") return US_LETTER
  return []
}

/** The next size up in a page's family, or null when it is the largest (or a custom page). */
export function nextSize(paper: Pick<SheetPaper, "size">): PaperSize | null {
  const family = paperFamily(paper.size)
  const i = family.indexOf(paper.size)
  return i >= 0 && i < family.length - 1 ? family[i + 1] : null
}

/** The page's width and height in mm, as it is turned. */
export function paperMm(paper: Pick<SheetPaper, "size" | "width" | "height" | "portrait">): { width: number; height: number } {
  if (paper.size === "User") return { width: paper.width ?? PAPER_MM.A4.width, height: paper.height ?? PAPER_MM.A4.height }
  const s = PAPER_MM[paper.size]
  return paper.portrait ? { width: s.height, height: s.width } : s
}

/** Whether a page stands upright: a named size turned, or a custom one taller than it is wide. */
export const isPortrait = (paper: Pick<SheetPaper, "size" | "width" | "height" | "portrait">) => {
  const mm = paperMm(paper)
  return mm.height > mm.width
}

/** The size as the title block says it: `A4`, or `Custom 300 × 200 mm`. */
export function paperName(paper: Pick<SheetPaper, "size" | "width" | "height" | "portrait">): string {
  if (paper.size !== "User") return PAPER_LABEL[paper.size]
  const mm = paperMm(paper)
  return `Custom ${round(mm.width, 1)} × ${round(mm.height, 1)} mm`
}

const GRID = 0.1
const snapGrid = (v: number) => round(Math.round(v / GRID) * GRID, 4)
const units = (mm: number) => mm / SCH_UNIT_MM

/** KiCad's default drawing sheet: the margin to the outer frame, the strip of zones between it and the inner frame, the zone pitch and the title block, in mm. */
export const BORDER = { margin: 10, strip: 2, zone: 50, zoneText: 1.3, titleWidth: 108, titleHeight: 32 }

/** A page for every new sheet: A4 landscape, centred on the origin. A constant, never worked out from a drawing, so a page never moves by itself. */
export const DEFAULT_PAPER: SheetPaper = { size: "A4", x: snapGrid(-units(PAPER_MM.A4.width) / 2), y: snapGrid(units(PAPER_MM.A4.height) / 2) }

/** The whole page, in sheet units. */
export function paperBox(paper: SheetPaper): Box {
  const mm = paperMm(paper)
  return { minX: paper.x, maxX: round(paper.x + units(mm.width), 6), maxY: paper.y, minY: round(paper.y - units(mm.height), 6) }
}

const inset = (b: Box, mm: number): Box => ({ minX: b.minX + units(mm), maxX: b.maxX - units(mm), minY: b.minY + units(mm), maxY: b.maxY - units(mm) })

/** The outer frame of the border, on the page's margin. */
export const outerBox = (paper: SheetPaper): Box => inset(paperBox(paper), BORDER.margin)

/** The inner frame: what a drawing stays inside. */
export const innerBox = (paper: SheetPaper): Box => inset(paperBox(paper), BORDER.margin + BORDER.strip)

/** The title block, against the inner frame's bottom-right corner. */
export function titleBlockBox(paper: SheetPaper): Box {
  const inner = innerBox(paper)
  return { minX: inner.maxX - units(BORDER.titleWidth), maxX: inner.maxX, minY: inner.minY, maxY: inner.minY + units(BORDER.titleHeight) }
}

interface ZoneMark {
  /** A tick across the strip between the frames: from the outer frame to the inner one. */
  ticks: { a: { x: number; y: number }; b: { x: number; y: number } }[]
  /** The zone names, in the middle of their stretch of the strip. */
  labels: { text: string; x: number; y: number }[]
}

const letter = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : `${String.fromCharCode(65 + Math.floor(i / 26) - 1)}${String.fromCharCode(65 + (i % 26))}`)

/** The zones of the border, as KiCad's default drawing sheet has them: a tick every 50 mm from the frame's top-left, numbered across the top and bottom strips and lettered down the left and right ones. */
export function zones(paper: SheetPaper): ZoneMark {
  const outer = outerBox(paper)
  const strip = units(BORDER.strip)
  const pitch = units(BORDER.zone)
  const width = outer.maxX - outer.minX
  const height = outer.maxY - outer.minY
  const ticks: ZoneMark["ticks"] = []
  const labels: ZoneMark["labels"] = []
  for (let i = 1; i * pitch < width - 1e-6; i++) {
    const x = outer.minX + i * pitch
    ticks.push({ a: { x, y: outer.maxY }, b: { x, y: outer.maxY - strip } }, { a: { x, y: outer.minY }, b: { x, y: outer.minY + strip } })
  }
  for (let i = 0; (i + 0.5) * pitch < width - 1e-6; i++) {
    const x = outer.minX + (i + 0.5) * pitch
    labels.push({ text: String(i + 1), x, y: outer.maxY - strip / 2 }, { text: String(i + 1), x, y: outer.minY + strip / 2 })
  }
  for (let i = 1; i * pitch < height - 1e-6; i++) {
    const y = outer.maxY - i * pitch
    ticks.push({ a: { x: outer.minX, y }, b: { x: outer.minX + strip, y } }, { a: { x: outer.maxX, y }, b: { x: outer.maxX - strip, y } })
  }
  for (let i = 0; (i + 0.5) * pitch < height - 1e-6; i++) {
    const y = outer.maxY - (i + 0.5) * pitch
    labels.push({ text: letter(i), x: outer.minX + strip / 2, y }, { text: letter(i), x: outer.maxX - strip / 2, y })
  }
  return { ticks, labels }
}

const EPS = 1e-6

/** Whether a box is on the page: inside the inner frame, and clear of the title block (above it or left of it). */
export function holds(paper: SheetPaper, box: Box): boolean {
  const inner = innerBox(paper)
  if (box.minX < inner.minX - EPS || box.maxX > inner.maxX + EPS || box.minY < inner.minY - EPS || box.maxY > inner.maxY + EPS) return false
  const title = titleBlockBox(paper)
  return box.minY >= title.maxY - EPS || box.maxX <= title.minX + EPS
}

/** The two rectangles of a page a drawing may fill whole: above the title block (the inner frame's width) and left of it (its height). */
function freeRegions(paper: SheetPaper): Box[] {
  const inner = innerBox(paper)
  const title = titleBlockBox(paper)
  return [
    { ...inner, minY: title.maxY },
    { ...inner, maxX: title.minX },
  ]
}

const fitsIn = (w: number, h: number, region: Box) => w <= region.maxX - region.minX + EPS && h <= region.maxY - region.minY + EPS

/** A page of a size placed so that `box` is centred in the first free region it fits, its corner on the grid; null when it fits neither. */
function placedAround(size: Omit<SheetPaper, "x" | "y">, box: Box): SheetPaper | null {
  const w = box.maxX - box.minX
  const h = box.maxY - box.minY
  const at0: SheetPaper = { ...size, x: 0, y: 0 }
  for (const region of freeRegions(at0)) {
    if (!fitsIn(w, h, region)) continue
    // The region's centre lands on the box's, then the corner goes to the grid.
    const dx = (box.minX + box.maxX) / 2 - (region.minX + region.maxX) / 2
    const dy = (box.minY + box.maxY) / 2 - (region.minY + region.maxY) / 2
    const paper: SheetPaper = { ...size, x: snapGrid(dx), y: snapGrid(dy) }
    if (holds(paper, box)) return paper
  }
  return null
}

/** A page centred on a box, its corner on the grid: where a page too small for a drawing goes. */
export function centredOn(size: Omit<SheetPaper, "x" | "y">, box: Box): SheetPaper {
  const b = paperBox({ ...size, x: 0, y: 0 })
  return { ...size, x: snapGrid((box.minX + box.maxX) / 2 - (b.maxX - b.minX) / 2), y: snapGrid((box.minY + box.maxY) / 2 + (b.maxY - b.minY) / 2) }
}

/** The size of a custom page just big enough for a box (whole mm): above the title block or beside it, whichever is smaller. */
function userSizeFor(box: Box): { width: number; height: number } {
  const frame = 2 * (BORDER.margin + BORDER.strip)
  const w = (box.maxX - box.minX) * SCH_UNIT_MM
  const h = (box.maxY - box.minY) * SCH_UNIT_MM
  const above = { width: Math.max(w, BORDER.titleWidth) + frame, height: h + BORDER.titleHeight + frame }
  const beside = { width: w + BORDER.titleWidth + frame, height: Math.max(h, BORDER.titleHeight) + frame }
  const pick = above.width * above.height <= beside.width * beside.height ? above : beside
  // A whole mm more than the sum, so the corner's snap to the grid can never push the box out.
  return { width: Math.ceil(pick.width + 1), height: Math.ceil(pick.height + 1) }
}

/** What a fitted page keeps of the page it replaces: its family and orientation, or that it is custom. */
type PaperLike = Pick<SheetPaper, "size" | "portrait">

/**
 * The smallest page of a family that holds a box, placed so the box is centred in the region it fits (above the title block, else
 * left of it), its corner on the grid. A box too big for the family's largest gets that size centred on it. A custom page is made
 * just big enough. `sizes` limits the sizes tried (the migration tries A4 to A0); the family of `like` by default.
 */
export function fitPaper(box: Box, like: PaperLike, sizes: PaperSize[] = paperFamily(like.size)): SheetPaper {
  if (like.size === "User") {
    const mm = userSizeFor(box)
    return placedAround({ size: "User", ...mm }, box) ?? centredOn({ size: "User", ...mm }, box)
  }
  const portrait = like.portrait ? ({ portrait: true } as const) : {}
  for (const size of sizes) {
    const placed = placedAround({ size, ...portrait }, box)
    if (placed) return placed
  }
  return centredOn({ size: sizes[sizes.length - 1] ?? like.size, ...portrait }, box)
}

/**
 * The page one size up in its family with its top-left corner kept, for a drawing laid out on it that it does not hold (`boxes`); a custom page is made
 * just big enough for them above its title block instead. Null when the page is the largest of its family, or a custom one can't grow to hold them.
 */
export function grownPaper(paper: SheetPaper, boxes: Box[]): SheetPaper | null {
  if (paper.size !== "User") {
    const size = nextSize(paper)
    return size ? { size, ...(paper.portrait ? { portrait: true as const } : {}), x: paper.x, y: paper.y } : null
  }
  const frame = BORDER.margin + BORDER.strip
  const now = paperMm(paper)
  const maxX = Math.max(...boxes.map((b) => b.maxX))
  const minY = Math.min(...boxes.map((b) => b.minY))
  const width = Math.max(now.width, Math.ceil((maxX - paper.x) * SCH_UNIT_MM + frame + 1))
  const height = Math.max(now.height, Math.ceil((paper.y - minY) * SCH_UNIT_MM + frame + BORDER.titleHeight + 1))
  return width === now.width && height === now.height ? null : { size: "User", width, height, x: paper.x, y: paper.y }
}

/** The page a drawing that has none is given (one imported, or from before pages): the smallest landscape A4 to A0 that holds it, around it. */
export const pageFor = (box: Box): SheetPaper => fitPaper(box, { size: "A4" }, ISO.slice(1))

/** The sheet's page: the stored one, or the default for a sheet that has none. */
export function paperOf(project: Pick<Project, "sheets">, sheetId: string = ROOT_SHEET): SheetPaper {
  return sheetsOf(project).find((s) => s.id === sheetId)?.paper ?? DEFAULT_PAPER
}

/** The box of each thing drawn on the sheet a view shows: parts, wires, labels, sheet symbols, block frames and drawings. */
function sheetItemBoxes(view: Project): Box[] {
  const out: Box[] = []
  for (const c of view.components) out.push(schematicBounds(c))
  for (const w of view.wires) {
    const b = emptyBox()
    for (const p of w.points) expandBox(b, p)
    if (Number.isFinite(b.minX)) out.push(b)
  }
  for (const l of view.labels) out.push(labelBox(l))
  if (view.sheetSymbols?.length) for (const s of symbolsOnSheet(view, useAt(view, view.scope ?? "").sheet)) out.push({ minX: s.x, minY: s.y, maxX: s.x + s.w, maxY: s.y + s.h })
  for (const f of blockFrames(view)) out.push(f.box)
  for (const d of view.drawings ?? []) out.push(drawingBounds(d))
  return out
}

/**
 * Everything drawn on the sheet a view shows, as one box (`sheetItemBoxes`). The one definition of "the drawing" for fitting the view,
 * Fit to drawing and the migration's estimate. Null for an empty sheet.
 */
export function sheetDrawingBox(view: Project): Box | null {
  const b = emptyBox()
  for (const box of sheetItemBoxes(view)) {
    expandBox(b, { x: box.minX, y: box.minY })
    expandBox(b, { x: box.maxX, y: box.maxY })
  }
  return Number.isFinite(b.minX) ? b : null
}

/** Whether the sheet a view shows is on its page: everything drawn on it inside the inner frame and clear of the title block, each thing on its own (a drawing may fill the room beside the title block). */
export function drawingOnPage(view: Project): boolean {
  const paper = paperOf(view, useAt(view, view.scope ?? "").sheet)
  return sheetItemBoxes(view).every((b) => holds(paper, b))
}

/** What a view fits to: the page, and any of the drawing that is off it. */
export function pageView(view: Project): Box {
  const page = paperBox(paperOf(view, useAt(view, view.scope ?? "").sheet))
  const drawing = sheetDrawingBox(view)
  if (!drawing) return page
  return { minX: Math.min(page.minX, drawing.minX), minY: Math.min(page.minY, drawing.minY), maxX: Math.max(page.maxX, drawing.maxX), maxY: Math.max(page.maxY, drawing.maxY) }
}

// ---------- the title block ----------

export interface TitleBlock {
  /** The project's name, or a KiCad sub-sheet's own Title. */
  title: string
  /** The name of the use shown. */
  sheet: string
  /** `Sheet N of M`: the use's page number in tree order, and how many uses there are. */
  number: string
  count: number
  /** `A4`, or `Custom 300 × 200 mm`. */
  size: string
  date?: string
  revision?: string
  company?: string
  drawnBy?: string
  /** Comment1, Comment2...: the description and the project's other properties, or a sub-sheet's own comments. KiCad's title block shows the first four. */
  comments: { index: number; text: string }[]
}

const REVISION = /^rev(ision)?$/i
const COMPANY = /^(company|organi[sz]ation)$/i
const DRAWN_BY = /^(author|drawn by)$/i

/** The title block's own fields that edit the project's properties, with the keys they match and the key a new one gets. */
export const TITLE_PROPERTIES = {
  revision: { pattern: REVISION, key: "Revision", kicad: "Rev" },
  company: { pattern: COMPANY, key: "Company", kicad: "Company" },
  drawnBy: { pattern: DRAWN_BY, key: "Author", kicad: null },
} as const

/** The project property a title block field shows: the first with a value whose key matches. */
export const titleProperty = (project: Pick<Project, "properties">, pattern: RegExp) => (project.properties ?? []).find((p) => p.value && pattern.test(p.key.trim()))

/** A KiCad sub-sheet's own title block entries, which it shows instead of the project's: null for a sheet that has none. */
export const ownTitleBlock = (project: Pick<Project, "sheets">, sheetId: string) => {
  const entries = sheetsOf(project).find((s) => s.id === sheetId)?.titleBlock
  return entries?.length ? entries : null
}

/**
 * What the title block of the use at `path` says. From the project: its name, the Revision, Company and Author properties, the date it was
 * last saved, and the description and the other properties as comments. From the sheet: its name, `Sheet N of M` and the page size. A sheet
 * imported from KiCad with a title block of its own shows its own Title, Rev, Company, Date and comments instead. The KiCad export writes it.
 */
export function titleBlockOf(project: Project, path: string): TitleBlock {
  const use = useAt(project, path)
  const sheet = { sheet: use.name, number: use.page, count: sheetUses(project).length, size: paperName(paperOf(project, use.sheet)) }
  const drawn = titleProperty(project, DRAWN_BY)
  const drawnBy = drawn ? { drawnBy: drawn.value } : {}
  const own = ownTitleBlock(project, use.sheet)
  if (own) {
    const get = (key: string) => own.find((e) => e.key === key)?.value || undefined
    const comments = own.flatMap((e) => {
      const m = /^Comment(\d+)$/.exec(e.key)
      return m ? [{ index: Number(m[1]), text: e.value }] : []
    })
    const date = get("Date")
    const revision = get("Rev")
    const company = get("Company")
    return { title: get("Title") ?? "", ...sheet, ...(date ? { date } : {}), ...(revision ? { revision } : {}), ...(company ? { company } : {}), ...drawnBy, comments }
  }
  const revision = titleProperty(project, REVISION)
  const company = titleProperty(project, COMPANY)
  const rest = (project.properties ?? []).filter((p) => p.value && p !== revision && p !== company).map((p) => `${p.key}: ${p.value}`)
  const lines = [...(project.description ? [project.description] : []), ...rest].slice(0, 9)
  const saved = Number.isFinite(project.updatedAt) && project.updatedAt > 0 ? new Date(project.updatedAt) : null
  const date = saved && Number.isFinite(saved.getTime()) ? saved.toISOString().slice(0, 10) : undefined
  return {
    title: project.name,
    ...sheet,
    ...(date ? { date } : {}),
    ...(revision ? { revision: revision.value } : {}),
    ...(company ? { company: company.value } : {}),
    ...drawnBy,
    comments: lines.map((text, i) => ({ index: i + 1, text })),
  }
}

// ---------- reading ----------

/** A stored page, checked: a known size, a finite corner, and for a custom page a positive finite width and height. Anything else is null, and `paperOf` gives the default. */
export function readPaper(raw: unknown): SheetPaper | null {
  if (!raw || typeof raw !== "object") return null
  const p = raw as Record<string, unknown>
  if (!isPaperSize(p.size) || typeof p.x !== "number" || typeof p.y !== "number" || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null
  if (p.size === "User") {
    const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0
    if (!ok(p.width) || !ok(p.height)) return null
    return { size: "User", width: p.width, height: p.height, x: p.x, y: p.y }
  }
  return { size: p.size, ...(p.portrait === true ? { portrait: true as const } : {}), x: p.x, y: p.y }
}
