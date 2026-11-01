import type { DefaultNetClass, DesignRules, NetClass } from "./types"

// Net classes (X10): which class a net is in, what the class sets, and the clearance two nets are
// checked at. The rules are KiCad's:
//
//  - Every net is in exactly one class. A net that is listed in a class (`NetClass.nets`) is in the
//    first class that lists it; one that no class lists is in the first class whose pattern it matches
//    (`NetClass.patterns`); every other net, and copper that has no net, is in Default, which is the
//    design rules themselves (`DesignRules.clearance`, `traceWidth`, `viaDiameter`, `viaDrill`, with
//    `DesignRules.defaultClass` for what only a class has). KiCad 9 and later let a net be in several
//    classes and combine them by priority (`NET_SETTINGS::GetEffectiveNetClass`); the reader of a
//    project file makes that combined class a class of its own and lists the net in it
//    (`mapKicadProjectNetClasses`), so a net is still in one class here.
//  - A class field that is absent is the Default class's.
//  - Two items on different nets are checked at the larger of their two classes' clearances, never
//    below the board's own minimum (`DesignRules.minClearance`). KiCad: `DRC_ENGINE::EvalRules` for a
//    clearance constraint looks up the class of each item and keeps the larger (the fast path at
//    drc_engine.cpp:1927 to 1990 of 10.0; `loadImplicitRules`, lines 262 to 300, makes one rule per class
//    and sorts them by clearance so the largest wins), then raises the result to the board minimum
//    (lines 2141 to 2155). An item with no net is in Default (`NET_SETTINGS::GetEffectiveNetClass`:
//    "<no net> is forced to be part of the default netclass").
//  - A class's width and via size are what new copper on its nets starts with, never a constraint: KiCad
//    checks no trace against its class's width, only against the board's minimum.
//
// A board with no classes behaves exactly as before: every function here returns the rules' own
// numbers when `netClasses` is absent or empty.

/** KiCad's name for the class every net is in unless it is put in another. */
export const DEFAULT_CLASS_NAME = "Default"
/** The description KiCad gives the Default class in English. */
export const DEFAULT_CLASS_DESCRIPTION = "This is the default net class."

/** What a class sets once each field it leaves out is taken from Default. */
export interface ClassValues {
  name: string
  clearance: number
  traceWidth: number
  viaDiameter: number
  viaDrill: number
  microViaDiameter?: number
  microViaDrill?: number
  diffPairWidth?: number
  diffPairGap?: number
}

export const hasNetClasses = (rules: DesignRules): boolean => !!rules.netClasses?.length

/** Whether a class carries a value of its own for each field, for showing what it overrides. */
export const CLASS_FIELDS = ["clearance", "traceWidth", "viaDiameter", "viaDrill", "microViaDiameter", "microViaDrill", "diffPairWidth", "diffPairGap"] as const
export type ClassField = (typeof CLASS_FIELDS)[number]

/** The name the Default class goes by in this project. */
export const defaultClassName = (rules: DesignRules): string => rules.defaultClass?.name || DEFAULT_CLASS_NAME

/** The Default class as values: the rules' sizes, and the class-only ones of `defaultClass`. */
export function defaultValues(rules: DesignRules): ClassValues {
  const d = rules.defaultClass
  return {
    name: defaultClassName(rules),
    clearance: rules.clearance,
    traceWidth: rules.traceWidth,
    viaDiameter: rules.viaDiameter,
    viaDrill: rules.viaDrill,
    ...(d?.microViaDiameter !== undefined ? { microViaDiameter: d.microViaDiameter } : {}),
    ...(d?.microViaDrill !== undefined ? { microViaDrill: d.microViaDrill } : {}),
    ...(d?.diffPairWidth !== undefined ? { diffPairWidth: d.diffPairWidth } : {}),
    ...(d?.diffPairGap !== undefined ? { diffPairGap: d.diffPairGap } : {}),
  }
}

/** A class's values with every field it leaves out taken from `base`. */
function resolved(cls: NetClass, base: ClassValues): ClassValues {
  return {
    name: cls.name,
    clearance: cls.clearance ?? base.clearance,
    traceWidth: cls.traceWidth ?? base.traceWidth,
    viaDiameter: cls.viaDiameter ?? base.viaDiameter,
    viaDrill: cls.viaDrill ?? base.viaDrill,
    ...((cls.microViaDiameter ?? base.microViaDiameter) !== undefined ? { microViaDiameter: cls.microViaDiameter ?? base.microViaDiameter } : {}),
    ...((cls.microViaDrill ?? base.microViaDrill) !== undefined ? { microViaDrill: cls.microViaDrill ?? base.microViaDrill } : {}),
    ...((cls.diffPairWidth ?? base.diffPairWidth) !== undefined ? { diffPairWidth: cls.diffPairWidth ?? base.diffPairWidth } : {}),
    ...((cls.diffPairGap ?? base.diffPairGap) !== undefined ? { diffPairGap: cls.diffPairGap ?? base.diffPairGap } : {}),
  }
}

// ---------- Patterns ----------

/** The longest pattern read as a regular expression, and the longest net name it is tried on: a pattern is user text, and a regular expression has no time limit. */
const MAX_REGEX_PATTERN = 120
const MAX_REGEX_NAME = 256

/**
 * Whether a pattern is safe to run as a regular expression: it is short, has no back reference, and repeats no group (`(a+)+` and `(a|a)*` take
 * exponential time to fail). A pattern that is not safe has only the wildcard matcher, which takes linear time whatever it says.
 */
function regexIsSafe(pattern: string): boolean {
  // `a*a*a*a*b` fails in time that grows with the name to the power of the repeats, so a pattern with more than two is not run
  const repeats = (pattern.match(/[*+]|\{\d/g) ?? []).length
  return pattern.length <= MAX_REGEX_PATTERN && repeats <= 2 && !/\\[1-9]/.test(pattern) && !/\)[*+{]/.test(pattern)
}

/** `?` is one character and `*` any run (also none), everything else itself, over the whole name: a linear scan with one place to go back to, as in any glob matcher. */
function wildcardMatches(pattern: string[], name: string[]): boolean {
  let p = 0
  let n = 0
  let star = -1
  let mark = 0
  while (n < name.length) {
    if (p < pattern.length && pattern[p] === "*") {
      star = p++
      mark = n
    } else if (p < pattern.length && (pattern[p] === "?" || pattern[p] === name[n])) {
      p++
      n++
    } else if (star >= 0) {
      p = star + 1
      n = ++mark
    } else return false
  }
  while (p < pattern.length && pattern[p] === "*") p++
  return p === pattern.length
}

/**
 * KiCad's net class pattern (`EDA_COMBINED_MATCHER` in `CTX_NETCLASS`, eda_pattern_match.cpp:413 of 9.0.0 and 10.0.0): two
 * matchers, and a net matches if either does. The wildcard one reads `?` as one character and `*` as any
 * run and everything else literally, anchored at both ends; the other reads the pattern as a regular
 * expression, anchored at both ends. A pattern that is not a valid regular expression only has the first
 * matcher, as in KiCad, and so has one that is not safe to run (`regexIsSafe`). (KiCad's expressions are
 * wxWidgets' advanced ones and these are JavaScript's: they agree on the classes, groups, alternations and
 * repeats that net names use.)
 */
export function patternMatcher(pattern: string): (net: string) => boolean {
  const wild = Array.from(pattern)
  let re: RegExp | null = null
  if (regexIsSafe(pattern)) {
    try {
      re = new RegExp(`${pattern.startsWith("^") ? "" : "^"}${pattern}${pattern.endsWith("$") ? "" : "$"}`, "s")
    } catch {
      re = null
    }
  }
  return (net) => wildcardMatches(wild, Array.from(net)) || (re !== null && net.length <= MAX_REGEX_NAME && re.test(net))
}

// ---------- The index ----------

export interface ClassIndex {
  /** The class a net is in, or null for Default. */
  classOf(net: string | null | undefined): NetClass | null
  /** What the net starts with: its class's values, the Default class's where it leaves a field out. */
  values(net: string | null | undefined): ClassValues
  /** The clearance a net's class asks for. */
  clearanceOf(net: string | null | undefined): number
  /** The clearance two nets are checked at: the larger of their classes', never below the board minimum. */
  pair(a: string | null | undefined, b: string | null | undefined): number
  /** The largest clearance anything is checked at, for how far to look for neighbours. */
  worst: number
  /** The Default class's values. */
  base: ClassValues
}

const memo = new WeakMap<DesignRules, ClassIndex>()

/** The index of a set of rules, built once per rules object. */
export function classIndex(rules: DesignRules): ClassIndex {
  let index = memo.get(rules)
  if (!index) {
    index = buildIndex(rules)
    memo.set(rules, index)
  }
  return index
}

function buildIndex(rules: DesignRules): ClassIndex {
  const base = defaultValues(rules)
  const floor = rules.minClearance !== undefined && rules.minClearance > 0 ? rules.minClearance : 0
  const classes = rules.netClasses ?? []
  if (!classes.length) {
    const clearance = Math.max(rules.clearance, floor)
    return { classOf: () => null, values: () => base, clearanceOf: () => rules.clearance, pair: () => clearance, worst: clearance, base }
  }
  const byNet = new Map<string, NetClass>()
  for (const c of classes) for (const n of c.nets) if (!byNet.has(n)) byNet.set(n, c)
  // S8: the nets a directive label puts in a class are in it as the nets it lists are, after them.
  for (const c of classes) for (const n of c.labelNets ?? []) if (!byNet.has(n)) byNet.set(n, c)
  const patterns = classes.flatMap((c) => (c.patterns ?? []).map((p) => ({ c, match: patternMatcher(p) })))
  const cache = new Map<string, NetClass | null>()
  const values = new Map<NetClass, ClassValues>(classes.map((c) => [c, resolved(c, base)]))
  const classOf = (net: string | null | undefined): NetClass | null => {
    if (!net) return null
    const hit = byNet.get(net)
    if (hit) return hit
    if (!patterns.length) return null
    let found = cache.get(net)
    if (found === undefined) {
      found = patterns.find((p) => p.match(net))?.c ?? null
      cache.set(net, found)
    }
    return found
  }
  const clearanceOf = (net: string | null | undefined) => {
    const c = classOf(net)
    return c ? (values.get(c) as ClassValues).clearance : base.clearance
  }
  const worst = Math.max(base.clearance, floor, ...[...values.values()].map((v) => v.clearance))
  return {
    classOf,
    values: (net) => {
      const c = classOf(net)
      return c ? (values.get(c) as ClassValues) : base
    },
    clearanceOf,
    pair: (a, b) => Math.max(clearanceOf(a), clearanceOf(b), floor),
    worst,
    base,
  }
}

/** A class's values by its name (Default's for a name no class has). */
export function classValuesOfClass(rules: DesignRules, name: string): ClassValues {
  const base = defaultValues(rules)
  const c = (rules.netClasses ?? []).find((x) => x.name === name)
  return c ? resolved(c, base) : base
}

/** The clearance two nets are checked at (`ClassIndex.pair`, for one call). */
export const pairClearance = (rules: DesignRules, a: string | null | undefined, b: string | null | undefined): number => classIndex(rules).pair(a, b)

/** The sizes a net's new copper starts with. */
export const classValues = (rules: DesignRules, net: string | null | undefined): ClassValues => classIndex(rules).values(net)

/**
 * How far the clearance two nets ask for is above the pour's own default: only a class that names a
 * clearance raises a pour's gap (`zone_filler.cpp`: a zone's own clearance is a local override that wins
 * over classes, and with none the larger of the two classes' applies), and the Default class's, which
 * is the rules' own, does not: the pour has `pourClearance` for that.
 */
export function classPourClearance(rules: DesignRules, zoneNet: string | null | undefined, otherNet: string | null | undefined): number {
  if (!hasNetClasses(rules)) return 0
  const index = classIndex(rules)
  const own = (net: string | null | undefined) => {
    const c = index.classOf(net)
    return c && c.clearance !== undefined ? c.clearance : 0
  }
  return Math.max(own(zoneNet), own(otherNet))
}

/** Every net that two classes both claim (listed in both, or listed in one and matching a pattern of another), by name, for a reader of KiCad 9 and later files, whose classes combine by priority. */
export function overlappingNets(rules: Pick<DesignRules, "netClasses">, nets: Iterable<string>): string[] {
  const classes = rules.netClasses ?? []
  const matchers = classes.map((c) => ({ c, listed: new Set([...c.nets, ...(c.labelNets ?? [])]), match: (c.patterns ?? []).map(patternMatcher) }))
  const out: string[] = []
  for (const net of nets) {
    let claims = 0
    for (const m of matchers) if (m.listed.has(net) || m.match.some((f) => f(net))) claims++
    if (claims > 1) out.push(net)
  }
  return out
}

// ---------- Editing ----------

const clean = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n)
const positive = (n: unknown): n is number => clean(n) && n > 0

/** A class name that is free in these rules: `name`, or `name 2` and so on. */
export function freeClassName(rules: DesignRules, name: string): string {
  const taken = new Set([defaultClassName(rules), DEFAULT_CLASS_NAME, ...(rules.netClasses ?? []).map((c) => c.name)])
  const base = name.trim() || "Class"
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`
}

/** Whether `name` could name a class in these rules: it has text, and it is not the Default class's name or another class's. */
export function classNameProblem(rules: DesignRules, name: string, except?: string): string | null {
  const n = name.trim()
  if (!n) return "A net class needs a name."
  if (n === DEFAULT_CLASS_NAME || n === defaultClassName(rules)) return `"${n}" is the Default class, which is the design rules themselves.`
  if ((rules.netClasses ?? []).some((c) => c.name === n && c.name !== except)) return `A net class named "${n}" already exists.`
  return null
}

const withClasses = (rules: DesignRules, netClasses: NetClass[]): DesignRules => {
  const { netClasses: _old, ...rest } = rules
  return netClasses.length ? { ...rest, netClasses } : rest
}

/** A new class with no nets, taking the sizes of Default until it is given its own. */
export function addNetClass(rules: DesignRules, name: string, init: Partial<Omit<NetClass, "name" | "nets">> = {}): DesignRules {
  return withClasses(rules, [...(rules.netClasses ?? []), { ...init, name: freeClassName(rules, name), nets: [] }])
}

export function removeNetClass(rules: DesignRules, name: string): DesignRules {
  return withClasses(rules, (rules.netClasses ?? []).filter((c) => c.name !== name))
}

/** Rename a class (a name that is taken or empty changes nothing). */
export function renameNetClass(rules: DesignRules, from: string, to: string): DesignRules {
  const name = to.trim()
  if (classNameProblem(rules, name, from)) return rules
  return withClasses(rules, (rules.netClasses ?? []).map((c) => (c.name === from ? { ...c, name } : c)))
}

/** Set one field of a class; `undefined` gives the field back to Default. A size that is not a positive number (a clearance may be 0) changes nothing. */
export function setClassField(rules: DesignRules, name: string, field: ClassField, value: number | undefined): DesignRules {
  if (value !== undefined && !(field === "clearance" ? clean(value) && value >= 0 : positive(value))) return rules
  return withClasses(
    rules,
    (rules.netClasses ?? []).map((c) => {
      if (c.name !== name) return c
      const { [field]: _gone, implicit: _made, ...rest } = c
      return value === undefined ? rest : { ...rest, [field]: value }
    }),
  )
}

export function setClassDescription(rules: DesignRules, name: string, description: string): DesignRules {
  return withClasses(
    rules,
    (rules.netClasses ?? []).map((c) => {
      if (c.name !== name) return c
      const { description: _gone, implicit: _made, ...rest } = c
      return description ? { ...rest, description } : rest
    }),
  )
}

/** Set one of the fields that only the Default class has besides the rules' own (`DesignRules.defaultClass`); `undefined` clears it. */
export function setDefaultClassField(rules: DesignRules, field: "microViaDiameter" | "microViaDrill" | "diffPairWidth" | "diffPairGap", value: number | undefined): DesignRules {
  if (value !== undefined && !positive(value)) return rules
  const { [field]: _gone, ...rest } = rules.defaultClass ?? {}
  const next = value === undefined ? rest : { ...rest, [field]: value }
  const { defaultClass: _old, ...others } = rules
  return Object.keys(next).length ? { ...others, defaultClass: next } : others
}

/** Patterns from the one line the Inspector shows: separated by commas, except where a comma is inside brackets, braces or parentheses of a regular expression (`[0-9]{1,3}`). */
export function splitPatterns(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ""
  for (const c of text) {
    if ("([{".includes(c)) depth++
    else if (")]}".includes(c)) depth = Math.max(0, depth - 1)
    if (c === "," && depth === 0) {
      out.push(cur)
      cur = ""
    } else cur += c
  }
  out.push(cur)
  return out
}

/** Replace a class's patterns (empty text and repeats are dropped; none leaves the field out). */
export function setClassPatterns(rules: DesignRules, name: string, patterns: string[]): DesignRules {
  const list = [...new Set(patterns.map((p) => p.trim()).filter(Boolean))]
  return withClasses(
    rules,
    (rules.netClasses ?? []).map((c) => {
      if (c.name !== name) return c
      const { patterns: _gone, implicit: _made, ...rest } = c
      return list.length ? { ...rest, patterns: list } : rest
    }),
  )
}

/** Put a net in a class (null: back in Default). The net leaves every list it was in; a pattern that matches it is overruled, since a listed net is first. */
export function assignNet(rules: DesignRules, net: string, className: string | null): DesignRules {
  const classes = rules.netClasses ?? []
  if (className !== null && !classes.some((c) => c.name === className)) return rules
  return withClasses(
    rules,
    classes.map((c) => {
      const without = c.nets.filter((n) => n !== net)
      if (c.name === className) {
        const { implicit: _made, ...own } = c
        return { ...own, nets: [...without, net] }
      }
      return without.length === c.nets.length ? c : { ...c, nets: without }
    }),
  )
}

/** The class a net is listed in or matches, by name; Default's name for none. For showing. */
export function classNameOf(rules: DesignRules, net: string | null | undefined): string {
  return classIndex(rules).classOf(net)?.name ?? defaultClassName(rules)
}

/** Follow nets that were renamed: a class lists the new name where it listed the old one. Absent rules or no class: the very same object. */
export function renameClassNets(rules: DesignRules, renamed: Record<string, string>): DesignRules {
  const classes = rules.netClasses
  if (!classes?.length) return rules
  let changed = false
  const next = classes.map((c) => {
    if (!c.nets.some((n) => renamed[n] !== undefined && renamed[n] !== n)) return c
    changed = true
    return { ...c, nets: [...new Set(c.nets.map((n) => renamed[n] ?? n))] }
  })
  return changed ? { ...rules, netClasses: next } : rules
}

// ---------- Reading a file ----------

/**
 * Net classes from a stored project, with every field of them valid: a class with no name, or named like
 * Default or like an earlier class, is dropped; a size that is not a finite positive number is left out
 * (a clearance may be 0); nets and patterns are lists of non-empty text without repeats.
 */
export function normalizeNetClasses(raw: unknown): NetClass[] {
  if (!Array.isArray(raw)) return []
  const out: NetClass[] = []
  const names = new Set<string>([DEFAULT_CLASS_NAME])
  for (const r of raw) {
    if (!r || typeof r !== "object") continue
    const c = r as Partial<NetClass>
    if (typeof c.name !== "string" || !c.name.trim() || names.has(c.name)) continue
    names.add(c.name)
    const cls: NetClass = { name: c.name, nets: Array.isArray(c.nets) ? [...new Set(c.nets.filter((n): n is string => typeof n === "string" && n !== ""))] : [] }
    if (typeof c.description === "string" && c.description) cls.description = c.description
    if (clean(c.clearance) && c.clearance >= 0) cls.clearance = c.clearance
    for (const f of ["traceWidth", "viaDiameter", "viaDrill", "microViaDiameter", "microViaDrill", "diffPairWidth", "diffPairGap"] as const) if (positive(c[f])) cls[f] = c[f]
    const patterns = Array.isArray(c.patterns) ? [...new Set(c.patterns.filter((p): p is string => typeof p === "string" && p !== ""))] : []
    if (patterns.length) cls.patterns = patterns
    // S8: the nets a directive label puts in the class, and whether a label alone makes the class.
    const labelNets = Array.isArray(c.labelNets) ? [...new Set(c.labelNets.filter((n): n is string => typeof n === "string" && n !== ""))] : []
    if (labelNets.length) cls.labelNets = labelNets
    if (c.implicit === true) cls.implicit = true
    out.push(cls)
  }
  return out
}

/** The Default class's own fields from a stored project (absent when it has none). */
export function normalizeDefaultClass(raw: unknown): DefaultNetClass | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const d = raw as DefaultNetClass
  const out: DefaultNetClass = {}
  if (typeof d.name === "string" && d.name.trim() && d.name !== DEFAULT_CLASS_NAME) out.name = d.name
  if (typeof d.description === "string" && d.description) out.description = d.description
  for (const f of ["microViaDiameter", "microViaDrill", "diffPairWidth", "diffPairGap"] as const) if (positive(d[f])) out[f] = d[f]
  return Object.keys(out).length ? out : undefined
}

// ---------- What a `.kicad_pro` reader hands in ----------

/** One net class of a KiCad 6 or later project file (`net_settings.classes`), as the JSON has it (millimetres; a field the file leaves out is `undefined`). */
export interface KicadProjectNetClass {
  name: string
  description?: string
  clearance?: number
  track_width?: number
  via_diameter?: number
  via_drill?: number
  microvia_diameter?: number
  microvia_drill?: number
  diff_pair_width?: number
  diff_pair_gap?: number
  /** KiCad 9's priority: lower is first; only matters where a net is in more than one class. */
  priority?: number
}

/** What a KiCad 6 or later project file says about net classes: `net_settings.classes`, `netclass_patterns` and `netclass_assignments` (net name to class names). */
export interface KicadProjectNets {
  classes: KicadProjectNetClass[]
  patterns: { netclass: string; pattern: string }[]
  /** `net_settings.netclass_assignments`: a net name to one class name, or a list of them (KiCad 9). */
  assignments?: Record<string, string | string[] | null>
}

export interface MappedNetClasses {
  /** Where the Default class's own fields go. */
  rules: Pick<DesignRules, "clearance" | "traceWidth" | "viaDiameter" | "viaDrill" | "defaultClass" | "netClasses">
  /** What the project file says that the model cannot hold exactly, for the reader to report or refuse on; empty when nothing was lost. */
  problems: string[]
  /** What is held as KiCad holds it but not as the file writes it (a class the file names and does not define, a combined class), for the report. */
  notes: string[]
  /** Nets that two classes claim (KiCad 9 combines these by priority; see the head of this file). */
  overlapping: string[]
}

/** KiCad's priority for a class a net or pattern names and the file does not define: weaker than every class the file defines (`getOrAddImplicitNetclass`). */
const IMPLICIT_PRIORITY = 2147483646

const listOf = (names: string[], most = 3) => `${names.slice(0, most).map((n) => `"${n}"`).join(", ")}${names.length > most ? ` and ${names.length - most} more` : ""}`

/**
 * The mapping from a `.kicad_pro` to the model, for the schematic track's reader to call with `net_settings` as it parsed it and the
 * net names of the board. `base` supplies what the file leaves out of the Default class (the editor's own defaults, or the board's rules).
 * Only the clearance, track width and via size of the Default class are the design rules; its micro via size, differential pair and
 * any name or description go to `defaultClass`; every other class is a `NetClass` with the nets the file lists and its patterns. A
 * class with a priority is kept in priority order (lower first). A class a net or pattern names and the file does not define is an
 * empty class, as KiCad makes it, whose nets take Default's values. A net several classes claim in a KiCad 9 file is in the class KiCad
 * combines from them (named by them, joined with commas, in priority order; each value from the first that sets it), and in a KiCad 8 file
 * in the one class KiCad 8 picks. `problems` lists what could not be kept (two classes of one name, a net KiCad 8 keeps in Default while
 * a pattern of another class matches it); the reader refuses on them, since the editor does not guess.
 */
export function mapKicadProjectNetClasses(nets: KicadProjectNets, base: Pick<DesignRules, "clearance" | "traceWidth" | "viaDiameter" | "viaDrill">, netNames: Iterable<string> = []): MappedNetClasses {
  const problems: string[] = []
  const notes: string[] = []
  const def = nets.classes.find((c) => c.name === DEFAULT_CLASS_NAME)
  // KiCad 9 writes every class's priority, and is the first to let an assignment name several classes.
  const prioritized = nets.classes.some((c) => typeof c.priority === "number") || Object.values(nets.assignments ?? {}).some((a) => Array.isArray(a) && a.length > 1)
  const others = nets.classes.filter((c) => c !== def)
  const seen = new Set<string>()
  for (const c of others) {
    if (seen.has(c.name)) problems.push(`two net classes are named "${c.name}"`)
    seen.add(c.name)
  }
  // A class a net or a pattern names and the file does not define: KiCad 9 makes an empty one of that name, weaker than every class
  // the file defines, and KiCad 8 gives the net the Default class. Either way the net has Default's values, as it has in an empty class.
  const assigned = Object.entries(nets.assignments ?? {}).map(([net, cls]) => [net, Array.isArray(cls) ? cls : cls ? [cls] : []] as const)
  const named = [...assigned.flatMap(([, list]) => list), ...nets.patterns.map((p) => p.netclass)]
  const undefinedNames = [...new Set(named.filter((n) => n !== DEFAULT_CLASS_NAME && !seen.has(n)))]
  if (undefinedNames.length) {
    const one = undefinedNames.length === 1
    notes.push(`the class${one ? "" : "es"} ${listOf(undefinedNames)}, which nets or patterns name and the file does not define: KiCad gives ${one ? "its" : "their"} nets the Default class's values, and so does the project, in an empty class of ${one ? "that name" : "each name"}`)
  }
  const all = [...others, ...undefinedNames.map((name): KicadProjectNetClass => ({ name, ...(prioritized ? { priority: IMPLICIT_PRIORITY } : {}) }))]
  const listed = new Map<string, string[]>()
  for (const [net, list] of assigned) for (const cls of list) if (cls !== DEFAULT_CLASS_NAME) listed.set(cls, [...(listed.get(cls) ?? []), net])
  const patterns = new Map<string, string[]>()
  for (const p of nets.patterns) if (p.netclass !== DEFAULT_CLASS_NAME) patterns.set(p.netclass, [...(patterns.get(p.netclass) ?? []), p.pattern])
  const rank = (c: { priority?: number }) => c.priority ?? Number.MAX_SAFE_INTEGER
  const ordered = [...all].sort((a, b) => rank(a) - rank(b))
  const num = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined)
  const netClasses = normalizeNetClasses(
    ordered.map((c) => ({
      name: c.name,
      description: c.description,
      clearance: typeof c.clearance === "number" && Number.isFinite(c.clearance) && c.clearance >= 0 ? c.clearance : undefined,
      traceWidth: num(c.track_width),
      viaDiameter: num(c.via_diameter),
      viaDrill: num(c.via_drill),
      microViaDiameter: num(c.microvia_diameter),
      microViaDrill: num(c.microvia_drill),
      diffPairWidth: num(c.diff_pair_width),
      diffPairGap: num(c.diff_pair_gap),
      nets: listed.get(c.name) ?? [],
      patterns: patterns.get(c.name),
    })),
  )
  const defaultClass = normalizeDefaultClass(
    def && {
      description: def.description && def.description !== DEFAULT_CLASS_DESCRIPTION ? def.description : undefined,
      microViaDiameter: def.microvia_diameter,
      microViaDrill: def.microvia_drill,
      diffPairWidth: def.diff_pair_width,
      diffPairGap: def.diff_pair_gap,
    },
  )
  const rules: MappedNetClasses["rules"] = {
    clearance: def && typeof def.clearance === "number" && def.clearance >= 0 && Number.isFinite(def.clearance) ? def.clearance : base.clearance,
    traceWidth: num(def?.track_width) ?? base.traceWidth,
    viaDiameter: num(def?.via_diameter) ?? base.viaDiameter,
    viaDrill: num(def?.via_drill) ?? base.viaDrill,
    ...(defaultClass ? { defaultClass } : {}),
    ...(netClasses.length ? { netClasses } : {}),
  }
  const claimed = netClasses.length ? overlappingNets({ netClasses }, netNames) : []
  // A file of KiCad 8 or before gives its classes no priority, and puts a net in one class: the one an assignment names, else the one of the first pattern in the
  // file it matches (`NET_SETTINGS::GetEffectiveNetClass` of 8.0). That is the editor's rule too, so only where the two would pick different classes is the net
  // listed in KiCad 8's class (and taken out of the others' lists), which wins over every pattern.
  const overlapping = prioritized ? claimed : claimed.filter((net) => kicad8Class(nets, net) !== editorClass(netClasses, net))
  const unlist = (net: string) => {
    for (const c of netClasses) if (c.nets.includes(net)) c.nets = c.nets.filter((n) => n !== net)
  }
  if (prioritized) {
    // KiCad 9 combines every class that claims a net (its assignments and every pattern it matches), ordered by priority, lower first, and by name between equals;
    // each value comes from the first class that sets it, and Default's where none does (`makeEffectiveNetclass`). The combination is a class of its own here,
    // named as KiCad names it, with the net listed in it.
    const priorities = new Map(all.map((c) => [c.name, rank(c)]))
    const combined = new Map<string, NetClass>()
    for (const net of overlapping) {
      const members = netClasses
        .filter((c) => c.nets.includes(net) || (c.patterns ?? []).some((p) => patternMatcher(p)(net)))
        .sort((a, b) => (priorities.get(a.name) ?? 0) - (priorities.get(b.name) ?? 0) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      const name = members.map((c) => c.name).join(",")
      let made = combined.get(name)
      if (!made) {
        made = { name, nets: [] }
        for (const f of CLASS_FIELDS) {
          const from = members.find((c) => c[f] !== undefined)
          if (from) made[f] = from[f]
        }
        combined.set(name, made)
      }
      unlist(net)
      made.nets.push(net)
    }
    for (const c of combined.values()) if (!netClasses.some((x) => x.name === c.name)) netClasses.push(c)
    if (overlapping.length) {
      notes.push(`${overlapping.length} net${overlapping.length === 1 ? "" : "s"} that several classes claim (${listOf(overlapping)}): each is in the class KiCad 9 combines from them, a class of its own here (${listOf([...combined.keys()], 2)}), with each value from the first class by priority that sets it`)
    }
  } else {
    for (const net of overlapping) {
      const into = netClasses.find((c) => c.name === kicad8Class(nets, net))
      if (!into) {
        problems.push(`net "${net}" is in the Default class for KiCad 8, and a pattern of another class matches it`)
        continue
      }
      unlist(net)
      into.nets.push(net)
    }
  }
  return { rules, problems, notes, overlapping }
}

/** The class KiCad 8 puts a net in, by name (Default for none), or null when the file names more than one (a KiCad 9 list). */
function kicad8Class(nets: KicadProjectNets, net: string): string | null {
  const assigned = nets.assignments?.[net]
  const list = Array.isArray(assigned) ? assigned : assigned ? [assigned] : []
  if (list.length > 1) return null
  if (list.length === 1) return list[0]
  return nets.patterns.find((p) => patternMatcher(p.pattern)(net))?.netclass ?? DEFAULT_CLASS_NAME
}

/** The class the editor puts a net in, by name: `classIndex`'s rule (a class listing it, then the first class with a pattern it matches). */
function editorClass(classes: NetClass[], net: string): string {
  const listed = classes.find((c) => c.nets.includes(net) || c.labelNets?.includes(net))
  if (listed) return listed.name
  return classes.find((c) => (c.patterns ?? []).some((p) => patternMatcher(p)(net)))?.name ?? DEFAULT_CLASS_NAME
}
