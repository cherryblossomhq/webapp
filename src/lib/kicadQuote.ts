// KiCad's quoted strings. The files differ in what they do with a line break and a tab, and each writer keeps the one it always had, so a
// string comes out the same as before; do not merge two of these.

const quoted = (escaped: string) => `"${escaped}"`

/** A quoted string with a line break written as a space: the board file's way (pads, drawings, zones, flags). */
export const quoteFlat = (text: string) => quoted(text.replace(/\r?\n/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"'))

/** A quoted string with a line break written as `\n`: the sheet files' way. */
export const quote = (text: string) => quoted(text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n"))

/** `quote`, and a tab written as `\t`: the texts of the board file. */
export const quoteTabs = (text: string) => quoted(text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n").replace(/\t/g, "\\t"))

/** `quoteTabs` for the symbol files made from KiCad's old formats, where a lone `\n` is the line break (a `\r` stays). */
export const quoteLegacy = (text: string) => quoted(text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t"))

/** KiCad escapes the characters a net name (or a bus alias's name or member) cannot hold: a `/` is `{slash}`, the label's own escape (which the reader undoes). */
export const escapeNetName = (text: string) => text.replace(/\//g, "{slash}")
