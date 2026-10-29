// A reader for the Gerber and Excellon files KiCad writes (format 4.6 or 4.5, millimetres), enough to compare two plots of the same board primitive by primitive:
// flashes, draws, arcs and regions, each with the definition of its aperture (the aperture's number is not compared, the number depends on the order).

export interface Prim {
  /** The kind and everything that is not a coordinate: `F|<aperture>|D`, `L|...`, `A|...`, `R|...`. */
  sig: string
  /** The coordinates in mm, in a fixed order, so two primitives of one sig can be matched within a tolerance. */
  nums: number[]
}

export interface Plot {
  /** `Copper,L1,Top` and so on, from the file's own function attribute; `unknown` without one. */
  fn: string
  prims: Prim[]
  /** The summed area of the regions (the pours), in mm squared, by polarity. */
  regionArea: number
  regions: number
}

const r3 = (n: number) => Math.round(n * 1000) / 1000

function areaOf(pts: [number, number][]): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]
    const [x2, y2] = pts[(i + 1) % pts.length]
    a += x1 * y2 - x2 * y1
  }
  return a / 2
}

/** A rounded rectangle macro lists its four corners in the order the pad's turn gives; the same shape is the same sorted corners. */
function canonAperture(def: string): string {
  // an obround with equal sides is a circle
  const ob = /^O,([\d.]+)X([\d.]+)$/.exec(def)
  if (ob && Math.abs(Number(ob[1]) - Number(ob[2])) < 1e-6) return `C,${ob[1]}`
  // an oval macro with no length is a circle
  const hv = /^(?:Horiz|Vert)Oval,([\d.]+)X0\.0+X0\.0+X0\.0+X0\.0+X0$/.exec(def)
  if (hv) return `C,${hv[1]}`
  // a rectangle turned by a quarter more is the rectangle with its sides swapped, and by a half more the same
  const rr = /^RotRect,([\d.]+)X([\d.]+)X(-?[\d.]+)$/.exec(def)
  if (rr) {
    let a = ((Number(rr[3]) % 180) + 180) % 180
    let [w, h] = [Number(rr[1]), Number(rr[2])]
    if (a >= 90) {
      a -= 90
      ;[w, h] = [h, w]
    }
    return `RotRect,${w.toFixed(6)}X${h.toFixed(6)}X${a.toFixed(3)}`
  }
  const m = /^RoundRect,(.*)$/.exec(def)
  if (!m) return def
  const v = m[1].split("X").map(Number)
  if (v.length < 9 || v.some((n) => Number.isNaN(n))) return def
  const corners: string[] = []
  for (let i = 1; i < 9; i += 2) corners.push(`${v[i].toFixed(4)},${v[i + 1].toFixed(4)}`)
  return `RoundRect,${v[0].toFixed(4)},${corners.sort().join(";")},${v[9] ?? 0}`
}

export function parseGerber(text: string): Plot {
  let fn = "unknown"
  let decimals = 6
  const aps = new Map<string, string>()
  const prims: Prim[] = []
  let regionArea = 0
  let regions = 0
  let cur = ""
  let pol = "D"
  let mode: "L" | "CW" | "CCW" = "L"
  let x = 0
  let y = 0
  let region: [number, number][] | null = null
  let regionSig = ""
  const body = text.split("\r").join("").split("\n").join("")
  const tokens: { block: boolean; text: string }[] = []
  const re = /%([^%]*)%|([^*%]*)\*/g
  for (let m = re.exec(body); m; m = re.exec(body)) tokens.push(m[1] !== undefined ? { block: true, text: m[1] } : { block: false, text: m[2] })
  for (const tok of tokens) {
    let raw = tok.text
    if (tok.block) {
      for (const w of raw.split("*")) {
        if (!w) continue
        if (w.startsWith("FSLA")) {
          const m = /X(\d)(\d)/.exec(w)
          if (m) decimals = Number(m[2])
        } else if (w.startsWith("TF.FileFunction,")) fn = w.slice("TF.FileFunction,".length)
        else if (w.startsWith("ADD")) {
          const m = /^ADD(\d+)(.*)$/.exec(w)
          if (m) aps.set(`D${m[1]}`, canonAperture(m[2]))
        } else if (w.startsWith("LP")) pol = w.slice(2) === "C" ? "C" : "D"
        if (w.startsWith("AM")) break
      }
      continue
    }
    if (!raw || raw.startsWith("G04")) continue
    const w = raw.replace(/\s+/g, "")
    if (w === "G36") {
      region = []
      regionSig = pol
      continue
    }
    if (w === "G37") {
      if (region && region.length > 2) {
        const a = Math.abs(areaOf(region))
        regionArea += pol === "C" ? -a : a
        regions++
        const xs = region.map((p) => p[0])
        const ys = region.map((p) => p[1])
        prims.push({ sig: `R|${regionSig}|${region.length}`, nums: [a, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] })
      }
      region = null
      continue
    }
    if (w === "G01") {
      mode = "L"
      continue
    }
    if (w === "G02") {
      mode = "CW"
      continue
    }
    if (w === "G03") {
      mode = "CCW"
      continue
    }
    if (w === "G75" || w === "G74" || w === "M02" || w === "G90" || w === "G91") continue
    const sel = /^(D\d+)$/.exec(w)
    if (sel && Number(sel[1].slice(1)) >= 10) {
      cur = sel[1]
      continue
    }
    const m = /^(?:G0[123])?(?:X(-?\d+))?(?:Y(-?\d+))?(?:I(-?\d+))?(?:J(-?\d+))?(?:D0([123]))?$/.exec(w)
    if (!m) continue
    const scale = 10 ** decimals
    const nx = m[1] !== undefined ? Number(m[1]) / scale : x
    const ny = m[2] !== undefined ? Number(m[2]) / scale : y
    const op = m[5]
    if (/^G0[123]/.test(w)) mode = w.startsWith("G01") ? "L" : w.startsWith("G02") ? "CW" : "CCW"
    if (op === "3") {
      prims.push({ sig: `F|${aps.get(cur) ?? cur}|${pol}`, nums: [nx, ny] })
    } else if (op === "1") {
      if (region) {
        if (!region.length) region.push([x, y])
        region.push([nx, ny])
      } else if (mode === "L") {
        const [a, b] = x < nx || (x === nx && y <= ny) ? [[x, y], [nx, ny]] : [[nx, ny], [x, y]]
        prims.push({ sig: `L|${aps.get(cur) ?? cur}|${pol}`, nums: [a[0], a[1], b[0], b[1]] })
      } else {
        const i = m[3] !== undefined ? Number(m[3]) / scale : 0
        const j = m[4] !== undefined ? Number(m[4]) / scale : 0
        // an arc is read as a clockwise one: a counter-clockwise arc is the same arc with its ends swapped
        const [sx, sy, ex, ey] = mode === "CW" ? [x, y, nx, ny] : [nx, ny, x, y]
        const cx = (mode === "CW" ? x : x) + i
        const cy = (mode === "CW" ? y : y) + j
        prims.push({ sig: `A|${aps.get(cur) ?? cur}|${pol}`, nums: [sx, sy, ex, ey, cx, cy] })
      }
    } else if (op === "2") {
      if (region && region.length) {
        // a region with a second contour: keep it as part of the polygon (rare in KiCad's plots)
        region.push([nx, ny])
      }
    }
    x = nx
    y = ny
  }
  return { fn, prims, regionArea, regions }
}

export interface Hole {
  sig: string
  nums: number[]
}

export interface Drill {
  fn: string
  holes: Hole[]
}

/** KiCad's Excellon: tools `T1C0.600`, hits `X1.0Y2.0`, routed slots `X1Y2` `G85` `X3Y4`. */
export function parseDrill(text: string): Drill {
  const tools = new Map<string, number>()
  const holes: Hole[] = []
  let fn = "unknown"
  let cur = 0
  let lastX = 0
  let lastY = 0
  const lines = text.replace(/\r/g, "").split("\n")
  let plain = true
  for (const line of lines) {
    const f = /TF\.FileFunction,(.*)$/.exec(line)
    if (f) fn = f[1]
    if (line.startsWith(";")) continue
    if (line.startsWith("%") || line.startsWith("M95")) plain = false
    if (!plain && !/^T\d|^X|^Y/.test(line)) continue
    const t = /^T(\d+)C([\d.]+)/.exec(line)
    if (t) {
      tools.set(t[1], Number(t[2]))
      continue
    }
    const sel = /^T(\d+)$/.exec(line)
    if (sel) {
      cur = Number(tools.get(sel[1]) ?? 0)
      continue
    }
    const slot = /^X(-?[\d.]+)Y(-?[\d.]+)G85X(-?[\d.]+)Y(-?[\d.]+)/.exec(line)
    if (slot) {
      const a = [Number(slot[1]), Number(slot[2])]
      const b = [Number(slot[3]), Number(slot[4])]
      const [p, q] = a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]) ? [a, b] : [b, a]
      holes.push({ sig: `S|${cur}`, nums: [p[0], p[1], q[0], q[1]] })
      continue
    }
    const hit = /^X(-?[\d.]+)Y(-?[\d.]+)$/.exec(line)
    if (hit) {
      lastX = Number(hit[1])
      lastY = Number(hit[2])
      holes.push({ sig: `H|${cur}`, nums: [lastX, lastY] })
    }
  }
  void lastX
  void lastY
  return { fn, holes }
}

/**
 * Lines of one aperture on the same infinite line that overlap or touch are one line (a trace or an outline written in pieces is the same copper). "The same line" is within a micrometre:
 * a file writes its numbers to a tenth of a micrometre, so the pieces of one straight track do not lie on one line to the last digit.
 */
export function mergeLines(prims: Prim[]): Prim[] {
  const TOL = 0.002
  const groups = new Map<string, { x: number; y: number; ux: number; uy: number; spans: { from: number; to: number }[] }[]>()
  const out: Prim[] = []
  // the longest pieces first: a line's axis is told by its longest piece, since a short piece's direction is only as good as the tenth of a micrometre its ends are written to
  const length = (p: Prim) => Math.hypot(p.nums[2] - p.nums[0], p.nums[3] - p.nums[1])
  for (const p of [...prims].sort((x, y) => (x.sig.startsWith("L|") && y.sig.startsWith("L|") ? length(y) - length(x) : 0))) {
    if (!p.sig.startsWith("L|")) {
      out.push(p)
      continue
    }
    const [x1, y1, x2, y2] = p.nums
    const len = Math.hypot(x2 - x1, y2 - y1)
    // a piece much shorter than its own width is a dot of the track's width inside the tracks it joins: a file keeps it or loses it, and the copper is the same
    const width = Number(/^L\|C,([\d.]+)/.exec(p.sig)?.[1] ?? 0)
    if (len < Math.max(0.002, width * 0.15)) continue
    const list = groups.get(p.sig) ?? groups.set(p.sig, []).get(p.sig)!
    // the group whose line both ends of this piece lie on
    let g = list.find((q) => Math.abs(-q.uy * (x1 - q.x) + q.ux * (y1 - q.y)) <= TOL && Math.abs(-q.uy * (x2 - q.x) + q.ux * (y2 - q.y)) <= TOL)
    if (!g) {
      let ux = (x2 - x1) / len
      let uy = (y2 - y1) / len
      if (ux < -1e-9 || (Math.abs(ux) <= 1e-9 && uy < 0)) {
        ux = -ux
        uy = -uy
      }
      g = { x: x1, y: y1, ux, uy, spans: [] }
      list.push(g)
    }
    const a = g.ux * (x1 - g.x) + g.uy * (y1 - g.y)
    const b = g.ux * (x2 - g.x) + g.uy * (y2 - g.y)
    g.spans.push({ from: Math.min(a, b), to: Math.max(a, b) })
  }
  for (const [sig, list] of groups) {
    for (const g of list) {
      const spans = g.spans.sort((x, y) => x.from - y.from)
      let cur = { ...spans[0] }
      const emit = (s: { from: number; to: number }) => {
        const n = [g.x + g.ux * s.from, g.y + g.uy * s.from, g.x + g.ux * s.to, g.y + g.uy * s.to]
        // a piece is the same from either end: the end with the lower x (the lower y when they are a micrometre apart in x) comes first
        const swap = n[0] > n[2] + 0.001 || (Math.abs(n[0] - n[2]) <= 0.001 && n[1] > n[3])
        out.push({ sig, nums: swap ? [n[2], n[3], n[0], n[1]] : n })
      }
      for (const s of spans.slice(1)) {
        if (s.from <= cur.to + 0.002) cur.to = Math.max(cur.to, s.to)
        else {
          emit(cur)
          cur = { ...s }
        }
      }
      emit(cur)
    }
  }
  return out
}

export interface MatchResult {
  /** Primitives only the first file has / only the second has, after matching within the tolerance. */
  onlyA: { sig: string; nums: number[] }[]
  onlyB: { sig: string; nums: number[] }[]
}

/** Multiset difference of two lists of primitives: equal when the signatures match and every coordinate is within `tol` mm. */
export function matchPrims(a: { sig: string; nums: number[] }[], b: { sig: string; nums: number[] }[], tol = 0.0025): MatchResult {
  const key = (p: { sig: string; nums: number[] }) => `${p.sig}|${p.nums.map((n) => r3(n)).join(",")}`
  const bag = new Map<string, { sig: string; nums: number[] }[]>()
  for (const p of b) (bag.get(key(p)) ?? bag.set(key(p), []).get(key(p))!).push(p)
  const restA: typeof a = []
  for (const p of a) {
    const list = bag.get(key(p))
    if (list?.length) list.pop()
    else restA.push(p)
  }
  const restB = [...bag.values()].flat()
  // second pass: the same signature and every coordinate within the tolerance (a coordinate on the edge of a rounding step)
  const bySig = new Map<string, { sig: string; nums: number[] }[]>()
  for (const p of restB) (bySig.get(p.sig) ?? bySig.set(p.sig, []).get(p.sig)!).push(p)
  const onlyA: typeof a = []
  for (const p of restA) {
    const list = bySig.get(p.sig)
    const i = list ? list.findIndex((q) => q.nums.length === p.nums.length && q.nums.every((n, k) => Math.abs(n - p.nums[k]) <= tol * (p.sig.startsWith("R|") && k === 0 ? 1000 : 1))) : -1
    if (i >= 0) list!.splice(i, 1)
    else onlyA.push(p)
  }
  return { onlyA, onlyB: [...bySig.values()].flat() }
}
