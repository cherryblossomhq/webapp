// S3: bus names. A label that names a bus is a vector, `D[0..7]` (the nets D0 to D7), or a group, `{A B}` or
// `USB{DP DM}` (the nets A and B, or USB.DP and USB.DM; a member may itself be a vector, a bus alias or a group).
// This is KiCad's own reading, `NET_SETTINGS::ParseBusVector` and `ParseBusGroup` (`common/project/net_settings.cpp`)
// and `SCH_CONNECTION::ConfigureFromLabel` (`eeschema/sch_connection.cpp`), which expand a bus label into the member nets
// it carries. The text is the label as the user reads it (`{slash}` already `/`), as KiCad unescapes it before parsing.
//
// KiCad 6, 7, 8 and 9 read these names with one grammar (the functions are identical in 6.0.11, 7.0.11, 8.0.9 and 9.0.6);
// KiCad 10 reads more: a quoted or backslash-escaped space in a name, a zero-padded range (`D[00..15]`), the suffixes
// `+ - P N` after a range, and formatting braces around the range (`D_{[1..2]}`). `gen` says which. A name the two read
// differently is `differsBetweenGenerations`, which the importer refuses rather than guess which KiCad drew the board.

export type BusGeneration = "kicad9" | "kicad10"

export interface BusName {
  kind: "vector" | "group"
  /** The member nets in order, as KiCad names them without a sheet path: `D0`, `USB.DP`. A vector inside a group is flattened into its members. */
  names: string[]
  /** Each member's own name without its group's prefix (`DP` for `USB.DP`, the name itself in a vector): how two groups' members are told to be the same (`matchBusMember`). */
  locals: string[]
}

/** The members a bus alias stands for; the lookup is the project's. */
export type AliasLookup = (name: string) => readonly string[] | undefined

/** The most member nets one bus label may carry, and the deepest a bus may nest through aliases and groups: a hostile name stops here. */
export const MAX_BUS_MEMBERS = 4096
const MAX_NESTING = 8

export class BusTooLarge extends Error {
  constructor(readonly label: string) {
    super(`The bus name "${label.length > 40 ? `${label.slice(0, 40)}...` : label}" carries more than ${MAX_BUS_MEMBERS} nets.`)
  }
}

const isSuperSubOverbar = (c: string) => c === "_" || c === "^" || c === "~"

function isEscaped(s: string, pos: number): boolean {
  let n = 0
  while (pos > 0 && s[pos - 1] === "\\") {
    n++
    pos--
  }
  return n % 2 === 1
}

/** `NET_SETTINGS::ParseBusVector`: the prefix and the members of `PREFIX[a..b]`, or null when the text is not a vector. */
export function parseBusVector(bus: string, gen: BusGeneration = "kicad10"): { prefix: string; members: string[] } | null {
  const v10 = gen === "kicad10"
  const len = bus.length
  let i = 0
  let prefix = ""
  let suffix = ""
  let tmp = ""
  let begin = 0
  let end = 0
  let braceNesting = 0
  let fmtWrapsName = false
  let inQuotes = false
  let padded = false
  let width = 0

  for (; i < len; i++) {
    const c = bus[i]
    if (v10) {
      if (c === '"' && !isEscaped(bus, i)) {
        inQuotes = !inQuotes
        continue
      }
      if (inQuotes) {
        if (c === "\\" && i + 1 < len) prefix += bus[++i]
        else prefix += c
        continue
      }
    }
    if (c === "{") {
      if (i > 0 && isSuperSubOverbar(bus[i - 1])) {
        braceNesting++
        prefix += "{"
        continue
      }
      return null
    } else if (c === "}") {
      braceNesting--
      prefix += "}"
      continue
    }
    if (v10 && c === "\\" && i + 1 < len && bus[i + 1] === " ") {
      prefix += bus[++i]
      continue
    }
    if (c === " " || c === "]") return null
    if (c === "[") {
      if (v10 && braceNesting > 0) {
        const fmtStart = prefix.lastIndexOf("{")
        if (fmtStart > 0 && isSuperSubOverbar(prefix[fmtStart - 1])) {
          if (fmtStart === prefix.length - 1) prefix = prefix.slice(0, fmtStart - 1)
          else fmtWrapsName = true
        }
      }
      break
    }
    prefix += c
  }

  // The start number.
  i++
  if (i >= len) return null
  for (; i < len; i++) {
    if (bus[i] === "." && i + 1 < len && bus[i + 1] === ".") {
      if (v10) {
        if (tmp === "") return null
        begin = Number(tmp)
        width = tmp.length
        padded = width > 1 && tmp[0] === "0"
      } else begin = tmp === "" ? 0 : Number(tmp)
      i += 2
      break
    }
    if (!/[0-9]/.test(bus[i])) return null
    tmp += bus[i]
  }

  // The end number.
  tmp = ""
  if (i >= len) return null
  let parsedEnd = false
  for (; i < len; i++) {
    if (bus[i] === "]") {
      if (v10) {
        if (tmp === "") return null
        padded ||= tmp.length > 1 && tmp[0] === "0"
        width = Math.max(width, tmp.length)
      }
      end = tmp === "" ? 0 : Number(tmp)
      parsedEnd = true
      i++
      break
    }
    if (!/[0-9]/.test(bus[i])) return null
    tmp += bus[i]
  }
  // KiCad 10 wants the closing bracket. KiCad 9 reads `D[1..5` with no bracket as a range from 0 to 1 (the end is only set at a bracket), which `differsBetweenGenerations` catches.
  if (v10 && !parsedEnd) return null

  // What follows the bracket.
  for (; i < len; i++) {
    const c = bus[i]
    if (c === "}") {
      braceNesting--
      if (!v10 || fmtWrapsName) suffix += c
    } else if (v10 && (c === "+" || c === "-" || c === "P" || c === "N")) suffix += c
    else return null
  }
  if (braceNesting !== 0) return null
  if (begin === end) return null
  if (begin > end) [begin, end] = [end, begin]
  if (end - begin + 1 > MAX_BUS_MEMBERS) throw new BusTooLarge(bus)
  const members: string[] = []
  for (let idx = begin; idx <= end; idx++) {
    let number = String(idx)
    if (v10 && padded && number.length < width) number = "0".repeat(width - number.length) + number
    members.push(`${prefix}${number}${suffix}`)
  }
  return { prefix, members }
}

/** `NET_SETTINGS::ParseBusGroup`: the prefix and the member texts of `PREFIX{A B}`, or null when the text is not a group. */
export function parseBusGroup(group: string, gen: BusGeneration = "kicad10"): { prefix: string; members: string[] } | null {
  const v10 = gen === "kicad10"
  const len = group.length
  let i = 0
  let prefix = ""
  let tmp = ""
  let braceNesting = 0
  let inQuotes = false

  for (; i < len; i++) {
    const c = group[i]
    if (v10) {
      if (c === '"' && !isEscaped(group, i)) {
        inQuotes = !inQuotes
        continue
      }
      if (inQuotes) {
        if (c === "\\" && i + 1 < len) prefix += group[++i]
        else prefix += c
        continue
      }
    }
    if (c === "{") {
      if (i > 0 && isSuperSubOverbar(group[i - 1])) {
        braceNesting++
        prefix += "{"
        continue
      }
      break
    } else if (c === "}") {
      braceNesting--
      prefix += "}"
      continue
    }
    if (v10 && c === "\\" && i + 1 < len && group[i + 1] === " ") {
      prefix += group[++i]
      continue
    }
    if (c === " " || c === "[" || c === "]") return null
    prefix += c
  }
  if (braceNesting !== 0) return null

  i++
  if (i >= len) return null
  const members: string[] = []
  inQuotes = false
  for (; i < len; i++) {
    const c = group[i]
    if (v10) {
      if (c === '"' && !isEscaped(group, i)) {
        inQuotes = !inQuotes
        continue
      }
      if (inQuotes) {
        if (c === "\\" && i + 1 < len) tmp += group[++i]
        else tmp += c
        continue
      }
    }
    if (c === "{") {
      if (i > 0 && isSuperSubOverbar(group[i - 1])) {
        braceNesting++
        tmp += "{"
        continue
      }
      return null
    } else if (c === "}") {
      if (braceNesting) {
        braceNesting--
        tmp += "}"
        continue
      }
      if (tmp !== "") members.push(tmp)
      return { prefix, members }
    }
    if (v10 && c === "\\" && i + 1 < len && group[i + 1] === " ") {
      tmp += group[++i]
      continue
    }
    // Commas are not strictly legal, but KiCad takes them as spaces.
    if (c === " " || c === ",") {
      if (tmp !== "") members.push(tmp)
      tmp = ""
      continue
    }
    tmp += c
  }
  return null
}

/**
 * The member nets of a label that names a bus, or null for a label that names a net. `SCH_CONNECTION::ConfigureFromLabel`: a vector
 * is its numbered nets; a group is the nets of its members (a bus alias by name expands to its members, a vector to its nets), each
 * behind the group's prefix and a dot; a group inside a group has its own prefix, not the outer one.
 */
export function parseBusName(text: string, aliases?: AliasLookup, gen: BusGeneration = "kicad10"): BusName | null {
  if (!text.includes("[") && !text.includes("{")) return null
  const vector = parseBusVector(text, gen)
  if (vector) return { kind: "vector", names: vector.members, locals: vector.members }
  const group = parseBusGroup(text, gen)
  if (!group) return null
  const names: string[] = []
  const locals: string[] = []
  const push = (prefix: string, local: string) => {
    names.push(`${prefix}${local}`)
    locals.push(local)
  }
  const add = (label: string, prefix: string, depth: number) => {
    if (depth > MAX_NESTING) throw new BusTooLarge(text)
    const v = parseBusVector(label, gen)
    if (v) {
      for (const m of v.members) push(prefix, m)
    } else {
      const g = parseBusGroup(label, gen)
      if (g) {
        const inner = g.prefix ? `${g.prefix}.` : ""
        for (const m of g.members) addMember(m, inner, depth + 1)
      } else push(prefix, label)
    }
    if (names.length > MAX_BUS_MEMBERS) throw new BusTooLarge(text)
  }
  const addMember = (member: string, prefix: string, depth: number) => {
    const alias = aliases?.(member)
    if (alias) for (const m of alias) add(m, prefix, depth + 1)
    else add(member, prefix, depth)
  }
  const prefix = group.prefix ? `${group.prefix}.` : ""
  for (const m of group.members) addMember(m, prefix, 0)
  return { kind: "group", names, locals }
}

/**
 * A net name as it is typed into a label: spaces become underscores (`VCC {3V3}` is `VCC_{3V3}`), except where KiCad's bus group syntax needs them, between the
 * members inside the braces of a name that is a bus group (`{A B}`, `USB{DP DM}`). A name with a brace that is no group keeps the old rule, so text markup
 * (`~{RESET N}`, `V_{IO 1}`) and a prefix with a space are as they were. While the name is being typed (`typing`) a group whose closing brace is not typed yet keeps the
 * spaces inside its open brace, or the member list could not be typed at all.
 */
export function typedNetName(text: string, typing = false): string {
  const plain = text.replace(/\s+/g, "_")
  if (!text.includes("{")) return plain
  if (parseBusGroup(text, "kicad10") || parseBusGroup(text, "kicad9")) return text
  if (!typing) return plain
  // An open group is a brace no text markup (`~`, `_`, `^`) introduces and no closing brace has met yet: its spaces are kept, every other space is an underscore.
  let open = 0
  let out = ""
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === "{" && !(i > 0 && "~_^".includes(text[i - 1]))) open++
    else if (c === "}" && open > 0) open--
    out += /\s/.test(c) ? (open > 0 ? c : "_") : c
  }
  return out
}

/**
 * The name a user typed for a label or a sheet entry, as the project keeps it: upper case in a project drawn here (so an entry `data` meets its port `DATA`),
 * the case kept in a project named as KiCad names its nets (`netNames`). A bus name keeps its spaces, one between members; anything else goes through
 * `typedNetName`. While the name is being typed (`typing`) nothing is trimmed.
 */
export function typedLabelName(project: { netNames?: unknown }, text: string, typing = false): string {
  const cased = project.netNames ? text : text.toUpperCase()
  if (typing) return typedNetName(cased, true)
  const name = cased.trim()
  return isBusName(name) ? name.replace(/\s+/g, " ") : typedNetName(name)
}

/** Whether a label names a bus at all (`SCH_CONNECTION::IsBusLabel`), whatever it carries. */
export function isBusName(text: string, gen: BusGeneration = "kicad10"): boolean {
  if (!text.includes("[") && !text.includes("{")) return false
  return !!parseBusVector(text, gen) || !!parseBusGroup(text, gen)
}

/** Whether KiCad 9 and KiCad 10 read the name as different buses (or one a bus and one a net): the importer cannot tell which drew the board, so it refuses. */
export function differsBetweenGenerations(text: string, aliases?: AliasLookup): boolean {
  if (!text.includes("[") && !text.includes("{")) return false
  try {
    const a = parseBusName(text, aliases, "kicad9")
    const b = parseBusName(text, aliases, "kicad10")
    if (!a || !b) return !!a !== !!b
    return a.kind !== b.kind || a.names.length !== b.names.length || a.names.some((n, i) => n !== b.names[i])
  } catch (e) {
    // a name too large for either is refused as that; it is not a difference between them
    if (e instanceof BusTooLarge) return false
    throw e
  }
}
