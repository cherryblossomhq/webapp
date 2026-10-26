import { PARTS } from "./library"
import type { PartDef } from "./types"

// Parts search for the library panel and the copilot. Small enough to score every part on
// every keystroke, so it can afford to understand what people type into an EDA search box:
// values ("10k", "100nF", "4k7", "16MHz"), packages ("0805", "SOT-23"), pin counts ("6 pin"),
// part numbers ("555", "328p"), synonyms ("ldo", "op-amp") and typos ("regualtor").

export interface PartHit {
  part: PartDef
  score: number
  /** Properties the query named, e.g. { resistance: "10k" } for "10k". Placing the hit applies them. */
  props?: Record<string, string>
  /** A package the query named that the part comes in. */
  footprint?: string
  /** Only some of the query's words matched: the closest parts rather than real matches. */
  partial?: boolean
}

interface Indexed {
  part: PartDef
  name: string[]
  /** Id, MPN and keywords. */
  strong: string[]
  /** Description and category. */
  weak: string[]
  /** Footprints without separators, e.g. "to2203" for "to220_3". */
  packages: string[]
  compact: string[]
}

const STOP_WORDS = new Set(["a", "an", "the", "for", "with", "and", "of", "to", "in", "on", "part", "parts", "component", "components"])

/** Words people use for what the library calls something else. */
const SYNONYMS: Record<string, string[]> = {
  ic: ["ics"],
  chip: ["ics"],
  resistance: ["resistor"],
  elco: ["electrolytic"],
  ecap: ["electrolytic"],
  trimpot: ["potentiometer"],
  jumper: ["header"],
  conn: ["connector"],
  micro: ["microcontroller"],
  uc: ["microcontroller"],
  vreg: ["regulator"],
  ldo: ["regulator"],
  mosfet: ["fet"],
  transistor: ["bjt", "fet"],
  amp: ["amplifier"],
  osc: ["oscillator"],
  screen: ["display"],
  lcd: ["display"],
  ble: ["bluetooth"],
  tact: ["tactile"],
  pushbutton: ["button"],
  toggle: ["switch"],
  gnd: ["ground"],
  supply: ["power"],
  socket: ["header"],
}

const LED_COLORS = new Set(["red", "green", "blue", "yellow", "white", "orange", "amber", "pink", "purple", "uv", "rgb", "warm white"])

/** Lower-case, µ to u, Ω to ohm, and voltages as KiCad-style "3v3" / "5v". */
function normalize(text: string) {
  return text
    .toLowerCase()
    .replace(/[µμ]/g, "u")
    .replace(/Ω/g, "ohm")
    .replace(/(\d+)\.(\d+)\s*v\b/g, "$1v$2")
    .replace(/(\d+)\s*v\b/g, "$1v")
}

/**
 * Index words: each hyphenated or underscored word both joined ("sot23") and split ("sot", "23"),
 * and a row-by-column size ("1x4") with its numbers too, so "header 4" finds the 1x4.
 */
function words(text: string): string[] {
  const out: string[] = []
  for (const raw of normalize(text).split(/[^a-z0-9.+#_-]+/)) {
    const w = raw.replace(/^[.\-_]+|[.\-_]+$/g, "")
    if (!w) continue
    if (/[-_]/.test(w)) {
      out.push(w.replace(/[-_]/g, ""))
      out.push(...w.split(/[-_]+/).filter(Boolean))
    } else out.push(w)
    const grid = w.match(/^(\d+)x(\d+)$/)
    if (grid) out.push(grid[1], grid[2])
  }
  return out
}

const compactOf = (text: string) => normalize(text).replace(/[^a-z0-9]/g, "")

const indexCache = new WeakMap<PartDef, Indexed>()

function indexPart(part: PartDef): Indexed {
  const hit = indexCache.get(part)
  if (hit) return hit
  const entry: Indexed = {
    part,
    name: words(part.name),
    strong: [...words(part.id), ...words(part.mpn ?? ""), ...(part.keywords ?? []).flatMap(words)],
    weak: [...words(part.description), ...words(part.category)],
    packages: part.footprints.map(compactOf),
    compact: [compactOf(part.name), compactOf(part.id), compactOf(part.mpn ?? "")].filter(Boolean),
  }
  indexCache.set(part, entry)
  return entry
}

// ---------- Query tokens ----------

type ValueProp = "resistance" | "capacitance" | "inductance" | "frequency" | "voltage"

interface Token {
  text: string
  value?: { prop: ValueProp; value: string }
  /** A pin count, from "6pin" (exact) or a bare number (loose). */
  pins?: { n: number; exact: boolean }
}

const num = (s: string) => String(Number(s))

/** Read an engineering value the way it's written on schematics and in BOMs. */
export function parseValue(token: string): Token["value"] {
  let m: RegExpMatchArray | null
  if ((m = token.match(/^(\d+(?:\.\d+)?)([pnu])f?$/)) || (m = token.match(/^(\d+(?:\.\d+)?)(m)f$/))) {
    return { prop: "capacitance", value: `${num(m[1])}${m[2]}F` }
  }
  if ((m = token.match(/^(\d+)([pnu])(\d)f?$/))) return { prop: "capacitance", value: `${m[1]}.${m[3]}${m[2]}F` }
  if ((m = token.match(/^(\d+(?:\.\d+)?)([num])h$/))) return { prop: "inductance", value: `${num(m[1])}${m[2]}H` }
  if ((m = token.match(/^(\d+)([num])(\d)h$/))) return { prop: "inductance", value: `${m[1]}.${m[3]}${m[2]}H` }
  if ((m = token.match(/^(\d+(?:\.\d+)?)([kmg]?)hz$/))) {
    const unit = { "": "Hz", k: "kHz", m: "MHz", g: "GHz" }[m[2]]
    return { prop: "frequency", value: `${num(m[1])}${unit}` }
  }
  const ohms = (n: string, unit: string) => `${num(n)}${unit === "k" ? "k" : unit === "m" || unit === "meg" ? "M" : ""}`
  if ((m = token.match(/^(\d+(?:\.\d+)?)(r|k|m|meg)(?:ohms?)?$/)) || (m = token.match(/^(\d+(?:\.\d+)?)()ohms?$/))) {
    return { prop: "resistance", value: ohms(m[1], m[2]) }
  }
  if ((m = token.match(/^(\d+)([rkm])(\d)$/))) return { prop: "resistance", value: ohms(`${m[1]}.${m[3]}`, m[2]) }
  if ((m = token.match(/^(\d+)v(\d+)?$/))) return { prop: "voltage", value: `${m[1]}${m[2] ? `.${m[2]}` : ""}V` }
  return undefined
}

function tokenize(query: string): Token[] {
  const joined = normalize(query)
    // "220 ohm", "100 nF", "16 MHz", "6 pin": the number and its unit are one token.
    .replace(/(\d)\s+(ohms?|[pnum]?f|[num]?h|[kmg]?hz|pins?|pos|positions?|way)\b/g, "$1$2")
  const tokens: Token[] = []
  for (const raw of joined.split(/[\s,;/()"'+]+/)) {
    const text = raw.replace(/[-_]/g, "").replace(/^\.+|\.+$/g, "")
    if (!text || STOP_WORDS.has(text)) continue
    const token: Token = { text, value: parseValue(text) }
    const pins = text.match(/^(\d+)(pins?|pos|positions?|way|p)?$/)
    if (pins) token.pins = { n: Number(pins[1]), exact: !!pins[2] }
    tokens.push(token)
  }
  return tokens
}

// ---------- Matching ----------

/** Optimal string alignment distance, giving up past `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    let best = Infinity
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
      best = Math.min(best, d[i][j])
    }
    if (best > max) return max + 1
  }
  return d[a.length][b.length]
}

/** Best match of a word against a list: exact, prefix, inside a longer word, then a typo. */
function wordScore(t: string, list: string[], weights: [number, number, number, number]): number {
  const [exact, prefix, inner, typo] = weights
  let best = 0
  const fuzzy = t.length >= 4 && !/\d/.test(t) ? (t.length >= 7 ? 2 : 1) : 0
  for (const w of list) {
    if (w === t) return exact
    if (w.startsWith(t)) best = Math.max(best, prefix)
    else if (t.length >= 3 && w.includes(t)) best = Math.max(best, inner)
    else if (fuzzy && best < typo && editDistance(t, w, fuzzy) <= fuzzy) best = typo
  }
  return best
}

/** Letters and digits together, like "328p" or "hc595": a part number fragment, which beats reading it as a value. */
const PART_NUMBER = /^(?=.*\d)(?=.*[a-z])[a-z0-9.]{3,}$/

function textScore(t: string, e: Indexed): number {
  if (PART_NUMBER.test(t) && [...e.name, ...e.strong].some((w) => w !== t && w.includes(t))) return 9.5
  return Math.max(
    wordScore(t, e.name, [10, 7, 5, 4]),
    wordScore(t, e.strong, [8, 6, 4, 3]),
    wordScore(t, e.weak, [4, 3, 2, 1.5]),
  )
}

interface TokenMatch {
  score: number
  props?: Record<string, string>
  footprint?: string
}

function matchToken(token: Token, e: Indexed): TokenMatch {
  const { part } = e
  let best: TokenMatch = { score: 0 }
  const take = (m: TokenMatch) => {
    if (m.score > best.score) best = m
  }

  const v = token.value
  // A voltage alone says less about the part than "3v3" in a regulator's name does.
  if (v && (part.valueProp === v.prop || (v.prop === "voltage" && "voltage" in part.defaultProps))) {
    take({ score: v.prop === "voltage" ? 6 : 9, props: { [v.prop]: v.value } })
  }
  if (part.valueProp === "color" && LED_COLORS.has(token.text)) take({ score: 6, props: { color: token.text } })

  if (token.text.length >= 2) {
    const i = e.packages.findIndex((p) => p === token.text)
    const j = i >= 0 ? i : token.text.length >= 3 && /\d/.test(token.text) ? e.packages.findIndex((p) => p.startsWith(token.text)) : -1
    if (j >= 0) take({ score: i >= 0 ? 8 : 6, footprint: part.footprints[j] })
  }

  if (token.pins && part.footprints.length && part.pins.length === token.pins.n) take({ score: token.pins.exact ? 6 : 3 })

  take({ score: textScore(token.text, e) })
  for (const syn of SYNONYMS[token.text] ?? []) take({ score: 0.8 * Math.max(...words(syn).map((w) => textScore(w, e))) })
  if (!best.score && token.text.length > 3 && token.text.endsWith("s") && !token.text.endsWith("ss")) {
    take({ score: 0.9 * textScore(token.text.slice(0, -1), e) })
  }
  return best
}

/**
 * Rank parts for a query. Every word has to match for a real hit; when nothing does, parts
 * matching at least half the words come back marked `partial`. An empty query lists every part.
 */
export function searchLibrary(query: string, extraParts: PartDef[] = []): PartHit[] {
  const parts = [...extraParts, ...PARTS]
  const tokens = tokenize(query)
  if (!tokens.length) return parts.map((part) => ({ part, score: 0 }))

  const whole = compactOf(query)
  const full: PartHit[] = []
  const partial: (PartHit & { matched: number })[] = []
  for (const part of parts) {
    const e = indexPart(part)
    let score = 0
    let matched = 0
    let props: Record<string, string> | undefined
    let footprint: string | undefined
    for (const token of tokens) {
      const m = matchToken(token, e)
      if (!m.score) continue
      matched++
      score += m.score
      if (m.props) props = { ...props, ...m.props }
      if (m.footprint) footprint ??= m.footprint
    }
    if (!matched) continue
    if (e.compact.includes(whole)) score += 15
    else if (whole.length >= 2 && e.compact.some((c) => c.startsWith(whole))) score += 5
    const hit: PartHit = { part, score, ...(props && { props }), ...(footprint && { footprint }) }
    if (matched === tokens.length) full.push(hit)
    else if (matched >= Math.ceil(tokens.length / 2)) partial.push({ ...hit, partial: true, matched })
  }

  const order = new Map(parts.map((p, i) => [p, i]))
  const byScore = (a: PartHit, b: PartHit) => b.score - a.score || order.get(a.part)! - order.get(b.part)!
  if (full.length) return full.sort(byScore)
  return partial
    .sort((a, b) => b.matched - a.matched || byScore(a, b))
    .map((h): PartHit => ({ part: h.part, score: h.score, props: h.props, footprint: h.footprint, partial: true }))
}
