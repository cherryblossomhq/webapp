// An independent oracle for a board's text objects: every `gr_text`, `gr_text_box`, `fp_text` and `property` of the raw
// file as it is on the board (KiCad's frame, y down, millimetres), with the census's own reader (`sexpr.mjs`) and no code
// from `src/model` or `src/lib`. The importer's project is compared with it text by text, to 0.001 mm: the same texts on the
// same layers, at the same places, size, angle, justification and content; and, with a stroke font, stroke by stroke.
//
// The layout is KiCad's, written here again from its source (docs/kicad-import.md, section 10, "What the source settled for
// X9"): `FONT::getLinePositions` and `STROKE_FONT::GetTextAsGlyphs` in common/font/font.cpp and stroke_font.cpp,
// `EDA_TEXT::GetLinePositions` and `GetEffectiveTextPenWidth` in common/eda_text.cpp, `PCB_TEXT::GetDrawRotation` in
// pcbnew/pcb_text.cpp, `BRDITEMS_PLOTTER::PlotText` in pcbnew/plot_brditems_plotter.cpp, the parser's text rules
// (`parseEDA_TEXT`, `parsePCB_TEXT_effects`). It works in floating millimetres where KiCad works in integer nanometres, so
// the two agree to a few nanometres, not exactly; the tests compare to a micrometre.
//
// The glyph data is KiCad's (`common/newstroke_font.cpp`, GPL-2.0-or-later with the SIL OFL 1.1 notice of its CJK glyphs) and is
// shipped in `src/lib/kicadFont/`; the oracle reads it from a copy of KiCad's own file (KICAD_NEWSTROKE), parsed here by its own
// code, so the check of the shipped data against the source is independent. Ported from KiCad as the layout is (see
// `src/lib/kicadText.ts` for the files and the notice): Copyright The KiCad Developers, GNU General Public License, version 2 or
// (at your option) any later version.

import { readFileSync } from "node:fs"
import { atoms, kid, kids, numAt, parseSexpr } from "./sexpr.mjs"

const D2R = Math.PI / 180
const UNIT = 21

// ---------- the font ----------

/** The oracle's own decoding of KiCad's glyph strings: `<left><right>` then pairs of letters, ` R` lifting the pen; the glyph of code point c is entry c - 32. */
export function fontFromGlyphStrings(strings) {
  const glyphs = strings.map((s) => {
    const left = s.charCodeAt(0) - 82
    const right = s.charCodeAt(1) - 82
    const strokes = [[]]
    for (let i = 2; i + 1 < s.length; i += 2) {
      if (s[i] === " " && s[i + 1] === "R") {
        strokes.push([])
        continue
      }
      strokes[strokes.length - 1].push([s.charCodeAt(i) - 82 - left, s.charCodeAt(i + 1) - 82 - 8])
    }
    return { width: right - left, strokes: strokes.filter((st) => st.length) }
  })
  return { glyphs }
}

/** The glyph strings of the text of `newstroke_font.cpp`, in table order. */
export function glyphStringsOf(sourceText) {
  const start = sourceText.indexOf("newstroke_font[] =")
  const out = []
  for (const m of sourceText.slice(start).matchAll(/^\s*"((?:[^"\\]|\\.)*)",?\s*(?:\/\*.*\*\/)?\s*$/gm)) out.push(m[1].replace(/\\(.)/g, "$1"))
  return out
}

/** KiCad's stroke font from the text of `newstroke_font.cpp`. */
export const loadFont = (sourceText) => fontFromGlyphStrings(glyphStringsOf(sourceText))

export const loadFontFile = (path) => loadFont(readFileSync(path, "utf8"))

function glyphFor(font, code) {
  const i = code - 32
  return font.glyphs[i >= 0 && i < font.glyphs.length ? i : "?".charCodeAt(0) - 32]
}

// ---------- markup ----------

const isIdStart = (c) => /[A-Za-z_]/.test(c)
const isIdPart = (c) => /[A-Za-z0-9_]/.test(c)

/** The markup of a line as runs: `{ s, sub, sup, over }`; an overbar covers the runs inside it, so it is a range of runs. */
export function markupRuns(line) {
  const chars = [...line]
  const runs = []
  const bars = []
  const opener = (i) => (chars[i + 1] === "{" && "~_^".includes(chars[i]) ? chars[i] : null)
  // Reads one braced group opened at `i` (at the marker); returns the index after its `}` or -1 when it is never closed. Fills runs as it goes.
  const group = (i, sub, sup) => {
    const kind = opener(i)
    const subNow = sub || kind === "_"
    const supNow = sup || kind === "^"
    const runStart = runs.length
    let j = i + 2
    let text = ""
    const flush = () => {
      if (text) runs.push({ s: text, sub: subNow, sup: supNow })
      text = ""
    }
    const mark = runs.length
    for (;;) {
      if (j >= chars.length) {
        runs.length = mark
        return -1
      }
      if (chars[j] === "}") {
        flush()
        if (kind === "~" && runs.length > runStart) bars.push({ from: runStart, to: runs.length })
        return j + 1
      }
      if (opener(j)) {
        const save = runs.length
        flush()
        const k = group(j, subNow, supNow)
        if (k >= 0) {
          j = k
          continue
        }
        runs.length = save
      }
      if (chars[j] === "{" && isIdStart(chars[j + 1] ?? "")) {
        let k = j + 2
        while (k < chars.length && isIdPart(chars[k])) k++
        if (chars[k] === "}") {
          text += chars.slice(j, k + 1).join("")
          j = k + 1
          continue
        }
      }
      text += chars[j]
      j++
    }
  }
  let i = 0
  let plain = ""
  const isUrl = (k) => {
    const rest = chars.slice(k, k + 8).join("")
    const len = rest.startsWith("https://") ? 8 : rest.startsWith("http://") ? 7 : 0
    return len > 0 && k + len < chars.length && chars[k + len] !== " "
  }
  const flushPlain = () => {
    if (plain) runs.push({ s: plain, sub: false, sup: false })
    plain = ""
  }
  while (i < chars.length) {
    if (opener(i)) {
      const keep = plain
      flushPlain()
      const before = runs.length
      const barsBefore = bars.length
      const k = group(i, false, false)
      if (k >= 0) {
        i = k
        continue
      }
      // not a marker after all (it never closes): the text before it and the marker are one run, as KiCad's grammar has them
      runs.length = before - (keep ? 1 : 0)
      bars.length = barsBefore
      plain = keep
    }
    if (isUrl(i)) {
      flushPlain()
      let k = i
      while (k < chars.length && chars[k] !== " ") k++
      runs.push({ s: chars.slice(i, k).join(""), sub: false, sup: false })
      i = k
      continue
    }
    plain += chars[i]
    i++
  }
  flushPlain()
  return { runs, bars }
}

// ---------- layout of one line, in millimetres ----------

/** Lays one line of text out from x = 0 with the baseline at y = 0; returns the strokes (glyph strokes and overbar bars) and the line's advance. */
function layoutLine(font, line, size, italic) {
  const { runs, bars } = markupRuns(line)
  const tilt = italic ? 1 / 8 : 0
  const space = glyphFor(font, 32).width / UNIT
  const strokes = []
  const starts = []
  let x = 0
  for (const run of runs) {
    starts.push(x)
    const k = run.sub || run.sup ? 0.8 : 1
    const sw = size.w * k
    const sh = size.h * k
    const dy = run.sub ? sh * 0.15 : run.sup ? -sh * 0.35 : 0
    let col = 0
    const x0 = x
    for (const ch of run.s) {
      const code = ch.codePointAt(0)
      if (code === 9) {
        col = (Math.floor(col / 4) + 1) * 4 - 1
        let next = x0 + size.w * col + size.w * space
        while (next <= x) {
          col += 4
          next += size.w * 4
        }
        x = next
      } else if (code === 32) {
        x += sw * space
      } else {
        const g = glyphFor(font, code)
        for (const st of g.strokes) {
          strokes.push(
            st.map(([gx, gy]) => {
              const px = (gx / UNIT) * sw
              const py = (gy / UNIT) * sh
              return [x + px - py * tilt, dy + py]
            }),
          )
        }
        x += (g.width / UNIT) * sw
      }
      col++
    }
  }
  starts.push(x)
  for (const b of bars) {
    const a = starts[b.from]
    const e = starts[b.to]
    const trim = size.w * 0.1
    const y = -size.h * 1.23
    strokes.push([[a + trim, y], [e - trim, y]])
  }
  return { strokes, advance: x }
}

const turn = ([x, y], deg) => {
  const a = ((deg % 360) + 360) % 360
  if (a === 0) return [x, y]
  if (a === 90) return [y, -x]
  if (a === 180) return [-x, -y]
  if (a === 270) return [-y, x]
  const c = Math.cos(a * D2R)
  const s = Math.sin(a * D2R)
  return [x * c + y * s, -x * s + y * c]
}

/** The width of a pen as KiCad works it out (`GetEffectiveTextPenWidth`), in millimetres. `thickness` is the base width after the bold migration. */
export function penWidth(t) {
  let pen = t.thickness
  if (pen <= 0.000001) pen = t.bold ? t.w / 5 : t.w / 8
  else if (t.bold) pen *= 1.6
  return Math.min(pen, Math.min(Math.abs(t.w), Math.abs(t.h)) * 0.25)
}

/** The rotation a text is drawn at: a footprint's text that keeps upright is brought into ]-90, 90], any other into [0, 360). */
export function drawAngle(angle, keepUpright) {
  let a = ((angle % 360) + 360) % 360
  if (keepUpright) {
    while (a > 90) a -= 180
    while (a <= -90) a += 180
  }
  return a
}

/**
 * The strokes KiCad plots for a text, as polylines of [x, y] on the board in millimetres (y down) and the pen: the text
 * anchored at (t.x, t.y), turned by `angle`, justified by `hj` and `vj` (-1, 0, 1), mirrored when `mirror`; `shown` is the
 * text with its variables resolved; `multiline` is how the plotter lays out lines (board text and boxes, not a footprint's).
 */
export function inkOf(font, shown, t, angle, multiline) {
  const pen = penWidth(t)
  const out = []
  if (!shown) return { strokes: out, pen }
  const lines = []
  let tmp = ""
  for (const ch of shown) {
    if (ch === "\n") {
      lines.push(tmp)
      tmp = ""
    } else tmp += ch
  }
  if (tmp) lines.push(tmp)
  const size = { w: t.w, h: t.h }
  const interline = t.h * 1.68 * 0.9583 * t.spacing
  // Where one line's text starts, before it is turned: justified about the anchor, with KiCad's own fudge factors.
  const drawLines = (texts, anchorAt) => {
    const heights = texts.map((_, i) => (i === 0 ? t.h * 1.17 : interline))
    const total = heights.reduce((a, b) => a + b, 0)
    texts.forEach((line, i) => {
      const { strokes, advance } = layoutLine(font, line, size, t.italic)
      let oy = t.h - pen * 0.052
      if (t.vj === 0) oy -= total / 2
      else if (t.vj === 1) oy -= total
      let ox = pen / 1.52
      if (t.hj === 0) ox = -advance / 2
      else if (t.hj === 1) ox = -(advance + ox)
      const [ax, ay] = anchorAt(i)
      for (const st of strokes) {
        out.push(
          st.map(([px, py]) => {
            let x = ax + ox + px
            const y = ay + oy + i * interline + py
            // mirror about the anchor's vertical line, then turn about the anchor
            if (t.mirror) x = ax - (x - ax)
            const [rx, ry] = turn([x - ax, y - ay], angle)
            return [ax + rx, ay + ry]
          }),
        )
      }
    })
  }
  if (multiline) {
    // the plotter places each line on its own: the first line's place moves for the vertical justification of the block, and is turned about the anchor
    const n = lines.length
    // KiCad 9 and 10: `EDA_TEXT::GetInterline` has no line spacing (eda_text.cpp:715-717 in 9.0.0, 749-751 in 10.0.0)
    const step = t.h * 1.68 * 0.9583
    let shift = 0
    if (n > 1) shift = t.vj === 0 ? -((n - 1) * step) / 2 : t.vj === 1 ? -(n - 1) * step : 0
    lines.forEach((line, i) => {
      const [dx, dy] = turn([0, shift + i * step], angle)
      const at = [t.x + dx, t.y + dy]
      // a single line, drawn from `at` with no extra line offset
      const one = { ...t }
      const sub = []
      const save = out.length
      drawOne(font, line, one, at, angle, pen, size, sub)
      for (const s of sub) out.push(s)
      void save
    })
  } else drawLines(lines, () => [t.x, t.y])
  return { strokes: out, pen }
}

function drawOne(font, line, t, at, angle, pen, size, out) {
  const { strokes, advance } = layoutLine(font, line, size, t.italic)
  const height = t.h * 1.17
  let oy = t.h - pen * 0.052
  if (t.vj === 0) oy -= height / 2
  else if (t.vj === 1) oy -= height
  let ox = pen / 1.52
  if (t.hj === 0) ox = -advance / 2
  else if (t.hj === 1) ox = -(advance + ox)
  for (const st of strokes) {
    out.push(
      st.map(([px, py]) => {
        let x = at[0] + ox + px
        const y = at[1] + oy + py
        if (t.mirror) x = at[0] - (x - at[0])
        const [rx, ry] = turn([x - at[0], y - at[1]], angle)
        return [at[0] + rx, at[1] + ry]
      }),
    )
  }
}

// ---------- the file's texts ----------

const TRANSLATED = {
  "Serigrafia.Retro": "B.SilkS", "Serigrafia.Fronte": "F.SilkS", "Adesivo.Retro": "B.Adhes", "Adesivo.Fronte": "F.Adhes", "Pasta.Retro": "B.Paste", "Pasta.Fronte": "F.Paste",
  "Maschera.Retro": "B.Mask", "Maschera.Fronte": "F.Mask", Grafica: "Dwgs.User", Commenti: "Cmts.User", Eco1: "Eco1.User", Eco2: "Eco2.User", "Contorno.scheda": "Edge.Cuts",
  Opisowa_Dolna: "B.SilkS", Opisowa_Gorna: "F.SilkS", Kleju_Dolna: "B.Adhes", Kleju_Gorna: "F.Adhes", Pasty_Dolna: "B.Paste", Pasty_Gorna: "F.Paste",
  Maski_Dolna: "B.Mask", Maski_Gorna: "F.Mask", Rysunkowa: "Dwgs.User", Komentarzy: "Cmts.User", ECO1: "Eco1.User", ECO2: "Eco2.User", Krawedziowa: "Edge.Cuts",
  "Dessous.SilkS": "B.SilkS", "Dessus.SilkS": "F.SilkS", "Dessous.Adhes": "B.Adhes", "Dessus.Adhes": "F.Adhes", "Dessous.Pate": "B.Paste", "Dessus.Pate": "F.Paste",
  "Dessous.Masque": "B.Mask", "Dessus.Masque": "F.Mask", "Dessin.User": "Dwgs.User", "Contours.Ci": "Edge.Cuts",
}
const DRAWING = /^(?:[FB]\.(?:SilkS|Mask|Paste|Fab|CrtYd|Adhes)|Dwgs\.User|Cmts\.User|Eco[12]\.User|Margin|User\.\d+)$/

/** The old overbar notation `~DSS~` as the new `~{DSS}` (string_utils.cpp:87). */
export function newOverbar(old) {
  if (old === "~") return old
  let out = ""
  let open = false
  for (let i = 0; i < old.length; i++) {
    const c = old[i]
    if (c === "~") {
      if (old[i + 1] === "~") {
        if (old[i + 2] === "{") {
          out += "~~{}"
          continue
        }
        out += "~"
        i++
        continue
      }
      if (old[i + 1] === "{") return old
      out += open ? "}" : "~{"
      open = !open
      continue
    }
    if ((c === " " || c === "}" || c === ")") && open) {
      out += "}"
      open = false
    }
    out += c
  }
  return open ? out + "}" : out
}

const num = (v, d = 0) => {
  const x = typeof v === "string" ? Number(v) : NaN
  return Number.isFinite(x) ? x : d
}

/**
 * Every text object of a board as the file has it. Positions are on the board (KiCad's frame, y down, mm): a footprint's text
 * at `at + R(angle) * local`. `shown` is the content with `%R`, `%V`, the old overbar and the variables the file can resolve
 * applied, and `unresolved` lists the variables it cannot (the importer leaves those as written).
 */
export function textOracle(text) {
  const root = parseSexpr(text)
  const tree = Array.isArray(root[0]) && root[0][0] === "kicad_pcb" ? root[0] : root
  const version = num(kid(tree, "version")?.[1], null)
  const old = version !== null && version < 20210606
  const layersNode = kid(tree, "layers")
  const copper = (layersNode?.slice(1) ?? []).filter((r) => Array.isArray(r) && ["signal", "power", "mixed", "jumper"].includes(r[2]))
  const front = copper[0]?.[1] ?? "F.Cu"
  const back = copper[copper.length - 1]?.[1] ?? "B.Cu"
  const copperNames = copper.map((r) => r[1])
  const canon = (name) => {
    if (name === front) return "F.Cu"
    if (name === back) return "B.Cu"
    if (name === "Edge.Cuts") return "Edge.Cuts"
    if (DRAWING.test(name)) return name
    if (copperNames.includes(name) && copperNames.length > 2) return `In${copperNames.indexOf(name)}.Cu`
    if (/^In\d+\.Cu$/.test(name)) return "inner"
    return TRANSLATED[name] ?? "unknown"
  }
  const props = {}
  for (const c of kid(tree, "title_block")?.slice(1) ?? []) {
    if (!Array.isArray(c)) continue
    if (c[0] === "comment" && c[2]) props[`Comment ${c[1]}`] = c[2]
    else if (c[1]) props[c[0][0].toUpperCase() + c[0].slice(1)] = c[1]
  }
  for (const p of kids(tree, "property")) if (p[1]) props[p[1]] = p[2] ?? ""
  const name = props.Title

  const readText = (c, kindHint, fpCtx) => {
    const head = c[0]
    const isBox = head === "gr_text_box" || head === "fp_text_box"
    const first = c[1] === "locked" ? 2 : 1
    let raw = head === "fp_text" ? (c[2] ?? "") : head === "property" ? (c[2] ?? "") : (c[first] ?? "")
    if (head !== "property" && !isBox) raw = raw.replace(/%V/g, "${VALUE}").replace(/%R/g, "${REFERENCE}")
    if (old && head !== "property" && !isBox) raw = newOverbar(raw)
    else if (old) raw = newOverbar(raw)
    const at = kid(c, "at")
    const eff = kid(c, "effects")
    const font = kid(eff, "font")
    const sz = kid(font, "size")
    const just = atoms(kid(eff, "justify"))
    const layerNode = kid(c, "layer")
    const fa = atoms(font)
    const has = (n) => fa.includes(n) || (kid(font, n) && (kid(font, n)[1] === undefined || kid(font, n)[1] === "yes"))
    const clampSz = (v) => Math.min(250, Math.max(0.001, v))
    const bold = !!has("bold")
    let thick = num(kid(font, "thickness")?.[1], 0)
    // the bold migration of files older than 20260826: the stored width is divided by the 1.6 bold multiplier (master parser line 898)
    const nm = Math.round(thick * 1e6)
    if (bold && nm > 1 && !(version !== null && version >= 20260826)) thick = Math.max(2, Math.round(nm / 1.6)) / 1e6
    const hideTop = c.includes("hide") || kids(c, "hide").some((h) => h[1] === undefined || h[1] === "yes")
    const hideEff = !!eff && (atoms(eff).includes("hide") || kids(eff, "hide").some((h) => h[1] === undefined || h[1] === "yes"))
    const lk = c.includes("locked") || kids(c, "locked").some((h) => h[1] === undefined || h[1] === "yes")
    const unl = atoms(at).includes("unlocked") || kids(c, "unlocked").some((h) => h[1] === undefined || h[1] === "yes")
    const out = {
      kind: kindHint,
      head,
      raw,
      layerName: layerNode?.[1] ?? "",
      layer: canon(layerNode?.[1] ?? ""),
      // the file's place, unturned: absolute for a board text, in the footprint's frame for a footprint's
      lx: num(at?.[1]),
      ly: num(at?.[2]),
      angle: isBox ? num(kid(c, "angle")?.[1]) : num(at?.[3]),
      mirror: just.includes("mirror"),
      h: sz ? clampSz(num(sz[1])) : 1.524,
      w: sz ? clampSz(num(sz[2])) : 1.524,
      thickness: thick,
      // the width as the file stores it: KiCad 9 and 10 wrap a text box with it (`GetTextThickness`)
      rawThickness: num(kid(font, "thickness")?.[1], 0),
      bold,
      italic: !!has("italic"),
      hj: just.includes("left") ? -1 : just.includes("right") ? 1 : 0,
      vj: just.includes("top") ? -1 : just.includes("bottom") ? 1 : 0,
      spacing: kid(font, "line_spacing") ? num(kid(font, "line_spacing")[1], 1) : 1,
      // a text: `(layer "F.Cu" knockout)`; a text box: its own `(knockout yes)` node, and nothing after its layer name
      knockout: isBox ? (kid(c, "knockout") ? ["yes", "true", undefined].includes(kid(c, "knockout")[1]) : false) : !!layerNode && (layerNode.includes("knockout") || kids(layerNode, "knockout").length > 0),
      hide: hideTop || hideEff,
      locked: lk,
      keepUpright: fpCtx ? !unl : false,
      face: kid(font, "face")?.[1] ?? null,
      renderCache: !!kid(c, "render_cache"),
      isBox,
    }
    if (isBox) {
      const s = kid(c, "start")
      const e = kid(c, "end")
      const stroke = kid(c, "stroke")
      const m = kid(c, "margins")
      out.box = {
        sx: num(s?.[1]),
        sy: num(s?.[2]),
        ex: num(e?.[1]),
        ey: num(e?.[2]),
        outline: !!kid(c, "pts"),
        strokeWidth: stroke && kid(stroke, "width") ? num(kid(stroke, "width")[1]) : null,
        border: kid(c, "border") ? kid(c, "border")[1] === undefined || kid(c, "border")[1] === "yes" : version !== null && version < 20230825 ? !!stroke && !!kid(stroke, "width") && num(kid(stroke, "width")[1]) >= 0 : true,
        margins: m ? [num(m[1]), num(m[2]), num(m[3]), num(m[4])] : null,
      }
    }
    return out
  }

  const fpOut = []
  for (const fp of tree) {
    if (!Array.isArray(fp) || (fp[0] !== "footprint" && fp[0] !== "module")) continue
    const atNode = kid(fp, "at")
    const tr = kid(fp, "transform")
    const at = atNode ? [num(atNode[1]), num(atNode[2])] : [num(kid(tr, "translate")?.[1]), num(kid(tr, "translate")?.[2])]
    const angle = atNode ? num(atNode[3]) : num(kid(tr, "rotate")?.[1])
    const layer = kid(fp, "layer")?.[1] ?? ""
    const bottom = layer === back || layer === "B.Cu"
    const texts = []
    let ref = ""
    let value = ""
    const fields = {}
    for (const c of fp) {
      if (!Array.isArray(c)) continue
      if (c[0] === "fp_text") {
        const t = readText(c, c[1] ?? "user", true)
        texts.push(t)
        if (c[1] === "reference") ref = t.raw
        else if (c[1] === "value") value = t.raw
      } else if (c[0] === "fp_text_box") texts.push(readText(c, "user", true))
      else if (c[0] === "property") {
        const key = c[1] ?? ""
        fields[key] = c[2] ?? ""
        if (key === "Reference") ref = c[2] ?? ""
        else if (key === "Value") value = c[2] ?? ""
        if (kid(c, "at") || kid(c, "layer") || kid(c, "effects")) texts.push(readText(c, key === "Reference" ? "reference" : key === "Value" ? "value" : "user", true))
      }
    }
    for (const t of texts) {
      const [dx, dy] = turn([t.lx, t.ly], angle)
      t.x = at[0] + dx
      t.y = at[1] + dy
      t.fpRef = ref
    }
    fpOut.push({ ref, value, at, angle, bottom, name: fp[1] ?? "", fields, texts })
  }
  const boardTexts = []
  for (const c of tree) {
    if (!Array.isArray(c)) continue
    if (c[0] === "gr_text" || c[0] === "gr_text_box") {
      const t = readText(c, "board", false)
      if (t.isBox) {
        const b = t.box
        t.x = (b.sx + b.ex) / 2
        t.y = (b.sy + b.ey) / 2
      } else {
        t.x = t.lx
        t.y = t.ly
      }
      boardTexts.push(t)
    }
  }
  // variables: the part's reference and value, the title block, the board's properties; the rest stay as written
  const unresolvedNames = new Set()
  const itemName = (fpName) => (fpName.includes(":") ? fpName.slice(fpName.indexOf(":") + 1) : fpName)
  const libraryName = (fpName) => (fpName.includes(":") ? fpName.slice(0, fpName.indexOf(":")) : "")
  const expand = (s, fp, layerName, depth = 0) => {
    if (!s.includes("${") || depth > 10) return s.replace(/\\\$\{/g, "${")
    let out = ""
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "\\" && s[i + 1] === "$" && s[i + 2] === "{") {
        let d = 1
        let j = i + 3
        while (j < s.length && d > 0) d += s[j] === "{" ? 1 : s[j] === "}" ? -1 : 0, j++
        out += "${" + s.slice(i + 3, j)
        i = j - 1
        continue
      }
      if (s[i] === "$" && s[i + 1] === "{") {
        let d = 1
        let j = i + 2
        let token = ""
        for (; j < s.length; j++) {
          if (s[j] === "{") d++
          else if (s[j] === "}" && --d === 0) break
          token += s[j]
        }
        i = j
        if (!token) continue
        if (token.includes("${")) token = expand(token, fp, layerName, depth + 1)
        let v = null
        // a text object's `${LAYER}` is its own layer (pcb_text.cpp, pcb_field.cpp); a footprint answers the rest (footprint.cpp ResolveTextVar)
        if (token === "LAYER" && layerName) v = layerName
        else if (fp && token === "REFERENCE") v = expand(fp.ref, fp, layerName, depth + 1)
        else if (fp && token === "VALUE") v = expand(fp.value, fp, layerName, depth + 1)
        else if (fp && token === "FOOTPRINT_LIBRARY") v = libraryName(fp.name)
        else if (fp && token === "FOOTPRINT_NAME") v = itemName(fp.name)
        else if (token.includes(":")) {
          const [r, rest] = [token.slice(0, token.indexOf(":")), token.slice(token.indexOf(":") + 1)]
          const other = fpOut.find((f) => f.ref.toLowerCase() === r.toLowerCase())
          if (other && rest === "REFERENCE") v = other.ref
          else if (other && rest === "VALUE") v = other.value
          else if (other && rest === "LAYER") v = other.bottom ? back : front
          else if (other && rest === "FOOTPRINT_LIBRARY") v = libraryName(other.name)
          else if (other && rest === "FOOTPRINT_NAME") v = itemName(other.name)
          else v = `<Unresolved: ${other?.ref ?? r}:${rest}>`
        } else {
          const map = { TITLE: "Title", ISSUE_DATE: "Date", REVISION: "Rev", COMPANY: "Company" }
          const cm = /^COMMENT([1-9])$/.exec(token)
          const key = map[token] ?? (cm ? `Comment ${cm[1]}` : token)
          v = props[key] ?? (token === "TITLE" ? (name ?? null) : null)
        }
        if (v === null) unresolvedNames.add(token)
        out += v === null ? "${" + token + "}" : v
      } else out += s[i]
    }
    return out
  }
  const all = [...boardTexts.map((t) => [t, null]), ...fpOut.flatMap((f) => f.texts.map((t) => [t, f]))]
  for (const [t, fp] of all) {
    t.fp = fp
    t.shown = t.kind === "reference" || t.kind === "value" ? t.raw : expand(t.raw, fp, TRANSLATED[t.layerName] ?? t.layerName)
    // `${FILENAME}` is the name of the board's file, which a file does not say: the importer shows the project's name
    t.usesFilename = /\$\{FILENAME\}/.test(t.raw)
    // a text that uses a variable a board file cannot resolve, or whose content KiCad evaluates, is outside what the importer takes
    t.hasExpression = /@\{/.test(t.raw)
  }
  return { version, front, back, board: boardTexts, footprints: fpOut, props, unresolved: unresolvedNames }
}

/** The text of a board's reference and value as a part shows them (a text with a variable of its own resolves against the part). */
export const shownText = (t) => t.shown

/**
 * A text box's corners, top left, top right, bottom right, bottom left of the text's own frame, in KiCad's frame (millimetres,
 * y down), by the file's version. A file of stamp 20260616 or later (lib-frame storage, master) stores the rectangle of the
 * text's own frame and the angle turns it about its centre; an older file (KiCad 7 to 10.0) stores the rectangle as it is drawn
 * and `EDA_SHAPE::GetCornersInSequence` of 10.0.0 only re-sequences its corners by a quarter turn. Another angle of an older file
 * is a polygon in KiCad (`pts`), which the importer refuses, so there are no corners (null).
 */
export function boxCornersOracle(box, angleDeg, version) {
  const L = Math.min(box.sx, box.ex)
  const R = Math.max(box.sx, box.ex)
  const T = Math.min(box.sy, box.ey)
  const B = Math.max(box.sy, box.ey)
  const a = ((angleDeg % 360) + 360) % 360
  if (version !== null && version >= 20260616) {
    const cx = (L + R) / 2
    const cy = (T + B) / 2
    return [[L, T], [R, T], [R, B], [L, B]].map(([x, y]) => {
      const [rx, ry] = turn([x - cx, y - cy], a)
      return [cx + rx, cy + ry]
    })
  }
  if (a === 0) return [[L, T], [R, T], [R, B], [L, B]]
  if (a === 90) return [[L, B], [L, T], [R, T], [R, B]]
  if (a === 180) return [[R, B], [L, B], [L, T], [R, T]]
  if (a === 270) return [[R, T], [R, B], [L, B], [L, T]]
  return null
}

/** The margins of a box: the file's, or KiCad's legacy default (half the stroke width, a nanometre for none, plus three quarters of the text height). */
const boxMargins = (t) => {
  const b = t.box
  if (b.margins) return b.margins
  const legacy = Math.round((b.strokeWidth === null ? -1 : Math.round(b.strokeWidth * 1e6)) / 2) / 1e6 + Math.round(t.h * 1e6 * 0.75) / 1e6
  return [legacy, legacy, legacy, legacy]
}

/** `PCB_TEXTBOX::GetDrawPos` of KiCad 10.0.0 (pcb_textbox.cpp:313-405): where the text starts, from the box's corners, the justification and the margins. */
export function boxAnchorOracle(t, corners, drawAng) {
  const [c0, c1, c2, c3] = corners
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]
  const centre = [(c0[0] + c1[0] + c2[0] + c3[0]) / 4, (c0[1] + c1[1] + c2[1] + c3[1]) / 4]
  const hj = t.mirror ? -t.hj : t.hj
  const table = {
    "-1,-1": c0, "0,-1": mid(c0, c1), "1,-1": c1,
    "-1,0": mid(c0, c3), "0,0": centre, "1,0": mid(c1, c2),
    "-1,1": c3, "0,1": mid(c3, c2), "1,1": c2,
  }
  const [ml, mt, mr, mb] = boxMargins(t)
  const off = [hj === -1 ? ml : hj === 1 ? -mr : 0, t.vj === -1 ? mt : t.vj === 1 ? -mb : 0]
  const [ox, oy] = turn(off, drawAng)
  const a = table[`${hj},${t.vj}`]
  return [a[0] + ox, a[1] + oy]
}

/** `FONT::LinebreakText` (font.cpp), for a text of plain words: no markup, tabs or variables. Widths are the oracle's own advances. */
export function linebreakOracle(font, text, column, t, thickness) {
  const size = { w: t.w, h: t.h }
  const width = (str) => layoutLine(font, str, size, t.italic).advance
  const space = width(" ")
  const lines = text.split("\n")
  let out = ""
  lines.forEach((line, ii) => {
    // wxStringTokenizer with " " and wxTOKEN_RET_DELIMS: each word keeps the space that ends it, a further space is a word of its own
    const words = []
    let cur = ""
    for (const ch of line) {
      cur += ch
      if (ch === " ") {
        words.push(cur)
        cur = ""
      }
    }
    if (cur) words.push(cur)
    let bury = false
    let lineWidth = 0
    let pending = 0
    for (const word of words) {
      const chars = word.trim()
      const w = width(chars === "" ? word : chars)
      const pendingWidth = pending * space
      const overflow = lineWidth + pendingWidth + w > column - thickness
      let pw = pendingWidth
      if (overflow && pending > 0) {
        out += "\n"
        lineWidth = 0
        pending = 0
        pw = 0
        bury = true
      }
      if (word === " ") pending++
      else {
        if (bury) bury = false
        else {
          out += " ".repeat(pending)
          lineWidth += pw
        }
        if (word.endsWith(" ")) {
          out += word.slice(0, -1)
          pending = 1
        } else {
          out += word
          pending = 0
        }
        lineWidth += w
      }
    }
    if (ii !== lines.length - 1) out += "\n"
  })
  return out
}

/** Whether a box's text is plain enough for `linebreakOracle`: no markup, variables or tabs. */
export const boxTextIsPlain = (shown) => !/[~_^]\{|\t|\$\{/.test(shown)

/** What `inkOf` needs of an oracle text: the world anchor, angle and flags (a footprint's text keeps upright unless it says it does not). A box is placed, wrapped and anchored as KiCad 10.0 does; null when its corners are not defined for the file's version. */
export function oracleInk(font, t, version = null) {
  if (t.isBox) {
    const corners = boxCornersOracle(t.box, t.angle, version)
    if (!corners || !boxTextIsPlain(t.shown)) return null
    const drawAng = drawAngle(t.angle, false)
    const [ml, mt, mr, mb] = boxMargins(t)
    const a = ((t.angle % 360) + 360) % 360
    const horizontal = a === 0 || a === 180
    const column = Math.hypot(corners[1][0] - corners[0][0], corners[1][1] - corners[0][1]) - (horizontal ? ml + mr : mt + mb)
    const wrapped = linebreakOracle(font, t.shown, column, t, t.rawThickness)
    const [ax, ay] = boxAnchorOracle(t, corners, drawAng)
    return inkOf(font, wrapped, { ...t, x: ax, y: ay }, drawAng, true)
  }
  const angle = drawAngle(t.angle, t.fp ? t.keepUpright : false)
  const multiline = t.kind === "board"
  return inkOf(font, t.shown, t, angle, multiline)
}
