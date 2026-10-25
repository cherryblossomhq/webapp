// The raw census of KiCad 5 files, sharing no code with `src`: how many records of each kind a
// legacy `.sch` has, which extensions it needs by the census's rules (`needs-sch.mjs`), and every
// symbol of a legacy `.lib` as plain numbers in millimetres (what the importer's drawings are
// checked against). Lines are counted by their first words, as the census counts a file's lines.

const MM = 0.0254

/** Records of a legacy schematic by the path the importer's accounting names them, counted from the raw lines. */
export function legacyRecordCounts(text) {
  const out = {}
  const bump = (k, n = 1) => (out[k] = (out[k] ?? 0) + n)
  const lines = text.replace(/^﻿/, "").split(/\r?\n/)
  let block = ""
  let version = 0
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const t = l.replace(/^ +/, "")
    const w = t.split(/\s+/)
    if (i === 0) {
      version = Number(/(\d+)\s*$/.exec(t)?.[1] ?? 0)
      continue
    }
    if (block === "comp") {
      if (/^L\s/.test(t)) bump("$Comp>L")
      else if (/^U\s/.test(t)) bump("$Comp>U")
      else if (/^P\s/.test(t)) bump("$Comp>P")
      else if (/^AR\s/.test(t)) bump("$Comp>AR")
      else if (/^F\s/.test(t)) bump("$Comp>F")
      else if (/^\$EndComp/.test(t)) {
        bump("$Comp>$EndComp")
        block = ""
      } else if (/^\s*\d+\s+-?\d+\s+-?\d+\s*$/.test(l)) bump("$Comp>orientation")
      continue
    }
    if (block === "sheet") {
      if (/^S\s/.test(t)) bump("$Sheet>S")
      else if (/^U\s/.test(t)) bump("$Sheet>U")
      else if (/^F0\s/.test(t)) bump("$Sheet>F0")
      else if (/^F1\s/.test(t)) bump("$Sheet>F1")
      else if (/^F\d+\s/.test(t)) bump("$Sheet>Fn")
      else if (/^\$EndSheet/.test(t)) {
        bump("$Sheet>$EndSheet")
        block = ""
      }
      continue
    }
    if (block === "bitmap") {
      if (/^Pos\s/.test(t)) bump("$Bitmap>Pos")
      else if (/^Scale\s/.test(t)) bump("$Bitmap>Scale")
      else if (/^Data/.test(t)) bump("$Bitmap>Data")
      else if (/^\$EndBitmap/.test(t) && !/^[0-9A-F]{2}\s/.test(t)) {
        bump("$Bitmap>$EndBitmap")
        block = ""
      }
      continue
    }
    if (block === "descr") {
      if (/^Sheet\s/.test(t)) bump("$Descr>Sheet")
      else if (/^Title\s/.test(t)) bump("$Descr>Title")
      else if (/^Date\s/.test(t)) bump("$Descr>Date")
      else if (/^Rev\s/.test(t)) bump("$Descr>Rev")
      else if (/^Comp\s/.test(t)) bump("$Descr>Comp")
      else if (/^Comment[1-9]/.test(t)) bump("$Descr>Comment")
      else if (/^encoding\s/.test(t)) bump("$Descr>encoding")
      else if (/^\$EndDescr/.test(t)) {
        bump("$Descr>$EndDescr")
        block = ""
      }
      continue
    }
    if (t.startsWith("$Descr")) {
      bump("$Descr")
      block = "descr"
    } else if (t.startsWith("$Comp")) {
      bump("$Comp")
      block = "comp"
    } else if (t.startsWith("$Sheet")) {
      bump("$Sheet")
      block = "sheet"
    } else if (t.startsWith("$Bitmap")) {
      bump("$Bitmap")
      block = "bitmap"
    } else if (/^Connection\s/.test(t)) bump("Connection")
    else if (/^NoConn\s/.test(t)) bump("NoConn")
    else if (/^Wire\s/.test(t)) {
      bump(`Wire>${w[1]}`)
      // a style after `Line`
      if (w.length > 3) bump("Wire>style")
      i++
    } else if (/^Entry\s/.test(t)) {
      bump(`Entry>${w[1]}`)
      i++
    } else if (/^Text\s/.test(t)) {
      bump(`Text>${w[1]}`)
      i++
    } else if (/^Kmarq\s/.test(t)) bump("Kmarq")
    else if (/^\$EndSCHEMATC/.test(t)) bump("$EndSCHEMATC")
  }
  void version
  return out
}

/** The extensions a legacy schematic needs by the census's rules (`needs-sch.mjs`), from the raw lines. */
export function legacyNeeds(text) {
  const c = legacyRecordCounts(text)
  const version = Number(/Version (\d+)/i.exec(text.slice(0, 80))?.[1] ?? 0)
  const lines = text.split(/\r?\n/)
  const power = lines.filter((l) => /^L\s+(?:power:|\S+\s+#(?:PWR|FLG))/.test(l)).length
  const get = (k) => c[k] ?? 0
  const n = new Set()
  const symbols = get("$Comp")
  if (symbols > 0) for (const x of ["S5", "S6", "S10"]) n.add(x)
  const hier = get("Text>HLabel") + (version === 1 ? get("Text>GLabel") : 0)
  if (get("$Sheet") > 0 || hier > 0) n.add("S1")
  if (version > 1 && get("Text>GLabel") > 0) n.add("S2")
  if (symbols - power > 0) n.add("S2")
  if (get("Wire>Bus") > 0 || get("Entry>Wire") > 0 || get("Entry>Bus") > 0) n.add("S3")
  if (get("Text>Notes") > 0 || get("Wire>Notes") > 0 || get("$Bitmap") > 0) n.add("S4")
  return n
}

const tokens = (s) => s.trim().split(/\s+/)
const fillOf = (c) => (c === "F" ? "outline" : c === "f" ? "background" : "none")

/**
 * Every symbol of a legacy library as plain numbers in millimetres: its shapes and pins in file order. A symbol is found by each
 * name it has (its own and its aliases). Arcs are given by their centre, radius and the two ends of the file, and the angles.
 */
export function rawLegacySymbols(text) {
  const out = new Map()
  let part = null
  let draw = false
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("DEF ")) {
      const t = tokens(line)
      part = { name: t[1], units: Math.max(1, Number(t[7])), power: t[9] === "P", offset: Number(t[4]) * MM, shapes: [], pins: [], fields: [], aliases: [t[1].replace(/^~/, "")] }
      draw = false
    } else if (!part) continue
    else if (line.startsWith("ALIAS ")) part.aliases.push(...tokens(line).slice(1))
    else if (/^F\d+\s/.test(line)) {
      const m = /^F(\d+)\s+"((?:[^"\\]|\\.)*)"\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+([HV])\s+([VI])/.exec(line)
      if (m) part.fields.push({ index: Number(m[1]), text: m[2], at: [Number(m[3]) * MM, Number(m[4]) * MM], size: Number(m[5]) * MM, vertical: m[6] === "V", visible: m[7] === "V" })
    } else if (line === "DRAW") draw = true
    else if (line === "ENDDRAW") draw = false
    else if (line.startsWith("ENDDEF")) {
      for (const a of part.aliases) if (!out.has(a)) out.set(a, part)
      part = null
    } else if (draw) {
      const t = tokens(line)
      const k = t[0]
      if (k === "X") part.pins.push({ name: t[1], number: t[2], at: [Number(t[3]) * MM, Number(t[4]) * MM], length: Number(t[5]) * MM, orient: t[6], unit: Number(t[9]), convert: Number(t[10]), type: t[11], attrs: t[12] ?? "" })
      else if (k === "A") part.shapes.push({ kind: "arc", c: [Number(t[1]) * MM, Number(t[2]) * MM], r: Number(t[3]) * MM, a1: Number(t[4]), a2: Number(t[5]), unit: Number(t[6]), convert: Number(t[7]), width: Number(t[8]) * MM, fill: fillOf(t[9]), ends: t.length >= 14 ? [Number(t[10]) * MM, Number(t[11]) * MM, Number(t[12]) * MM, Number(t[13]) * MM] : null })
      else if (k === "C") part.shapes.push({ kind: "circle", c: [Number(t[1]) * MM, Number(t[2]) * MM], r: Number(t[3]) * MM, unit: Number(t[4]), convert: Number(t[5]), width: Number(t[6]) * MM, fill: fillOf(t[7]) })
      else if (k === "S") part.shapes.push({ kind: "rect", a: [Number(t[1]) * MM, Number(t[2]) * MM], b: [Number(t[3]) * MM, Number(t[4]) * MM], unit: Number(t[5]), convert: Number(t[6]), width: Number(t[7]) * MM, fill: fillOf(t[8]) })
      else if (k === "P" || k === "B") {
        const n = Number(t[1])
        const pts = []
        for (let i = 0; i < n; i++) pts.push([Number(t[5 + 2 * i]) * MM, Number(t[6 + 2 * i]) * MM])
        part.shapes.push({ kind: k === "P" ? "poly" : "bezier", pts, unit: Number(t[2]), convert: Number(t[3]), width: Number(t[4]) * MM, fill: fillOf(t[5 + 2 * n]) })
      } else if (k === "T") part.shapes.push({ kind: "text", at: [Number(t[2]) * MM, Number(t[3]) * MM], unit: Number(t[6]), convert: Number(t[7]) })
    }
  }
  return out
}
