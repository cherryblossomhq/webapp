// Pin numbers as KiCad writes them: `[1-3]` and `[A1,A2]` stand for several pads at one place.
// Shared by the symbol drawings the editor holds (`symbolDrawing.ts`) and the KiCad importer.

/** The most pads one drawn pin may stand for: KiCad has no limit, a file that asks for more is not a schematic. */
export const MAX_STACKED_PADS = 10000

const isSpecial = (c: string) => c === "[" || c === "]" || c === "," || c === "-" || c === "\\"
/** A backslash is an escape only before one of the notation's own characters (`ExpandStackedPinNotation`, common/string_utils.cpp). */
const isEscapeAt = (t: string, i: number) => t[i] === "\\" && i + 1 < t.length && isSpecial(t[i + 1])

function splitUnescaped(inner: string): string[] {
  const parts: string[] = []
  let current = ""
  for (let i = 0; i < inner.length; i++) {
    if (isEscapeAt(inner, i)) {
      current += inner[i] + inner[i + 1]
      i++
    } else if (inner[i] === ",") {
      parts.push(current)
      current = ""
    } else current += inner[i]
  }
  parts.push(current)
  return parts
}

function unescapeItem(item: string): string {
  let out = ""
  for (let i = 0; i < item.length; i++) {
    if (isEscapeAt(item, i)) out += item[++i]
    else out += item[i]
  }
  return out
}

function findUnescaped(text: string, ch: string): number {
  for (let i = 0; i < text.length; i++) {
    if (isEscapeAt(text, i)) i++
    else if (text[i] === ch) return i
  }
  return -1
}

/** A pin number as a prefix and its trailing digits, or -1 when it has none: `A12` is `A` and 12. */
function alphaNumeric(pin: string): [string, number] {
  let numStart = pin.length
  for (let i = pin.length - 1; i >= 0; i--) {
    if (!/[0-9]/.test(pin[i])) {
      numStart = i + 1
      break
    }
    if (i === 0) numStart = 0
  }
  if (numStart < pin.length) return [pin.slice(0, numStart), Number(pin.slice(numStart))]
  return [pin.slice(0, 0), -1]
}

/**
 * The pad numbers one drawn pin stands for: KiCad's `ExpandStackedPinNotation`. KiCad 9 lets a pin
 * be `[1,2,3]`, `[1-5]` or `[6,7,9-11]`, and `[A1-A4]` for a run with a common prefix; a dash, comma or
 * bracket inside one number is written with a backslash. A notation KiCad cannot read (a bracket with
 * no partner, a range whose ends have other prefixes or run backwards, an empty list) is the one pin
 * that has the text as its number, and so is anything not in brackets.
 */
export function expandPinNumber(raw: string): string[] {
  const open = raw.includes("[")
  const close = raw.includes("]")
  const bracketed = raw.startsWith("[") && raw.endsWith("]")
  if ((open || close) && !bracketed) return [raw]
  if (!bracketed) return [raw]
  const out: string[] = []
  for (let part of splitUnescaped(raw.slice(1, -1))) {
    part = part.trim()
    if (part === "") continue
    const dash = findUnescaped(part, "-")
    if (dash < 0) {
      out.push(unescapeItem(part))
      continue
    }
    const start = unescapeItem(part.slice(0, dash)).trim()
    const end = unescapeItem(part.slice(dash + 1)).trim()
    const [sp, sv] = alphaNumeric(start)
    const [ep, ev] = alphaNumeric(end)
    if (sp !== ep || sv === -1 || ev === -1 || sv > ev || out.length + (ev - sv + 1) > MAX_STACKED_PADS) return [raw]
    for (let n = sv; n <= ev; n++) out.push(`${sp}${n}`)
  }
  return out.length ? out : [raw]
}
