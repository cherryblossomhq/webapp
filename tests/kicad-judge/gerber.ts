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

/** Lines of one aperture on the same infinite line that overlap or touch are one line (a trace or an outline written in pieces is the same copper). */
export function mergeLines(prims: Prim[]): Prim[] {
  const lines = new Map<string, { ux: number; uy: number; from: number; to: number; off: number }[]>()
  const out: Prim[] = []
  for (const p of prims) {
    if (!p.sig.startsWith("L|")) {
      out.push(p)
      continue
    }
    const [x1, y1, x2, y2] = p.nums
    const len = Math.hypot(x2 - x1, y2 - y1)
    if (len < 1e-9) {
      out.push(p)
      continue
    }
    let ux = (x2 - x1) / len
    let uy = (y2 - y1) / len
    if (ux < -1e-9 || (Math.abs(ux) <= 1e-9 && uy < 0)) {
      ux = -ux
      uy = -uy
    }
    // the line's offset from the origin along its normal, and the span of the piece along its direction
    const off = -uy * x1 + ux * y1
    const key = `${p.sig}|${Math.round(Math.atan2(uy, ux) * 1e5)}|${Math.round(off * 500)}`
    const a = ux * x1 + uy * y1
    const b = ux * x2 + uy * y2
    const list = lines.get(key) ?? lines.set(key, []).get(key)!
    list.push({ ux, uy, from: Math.min(a, b), to: Math.max(a, b), off })
  }
  for (const [key, spans] of lines) {
    const sig = key.split("|").slice(0, 3).join("|")
    spans.sort((x, y) => x.from - y.from)
    let cur = { ...spans[0] }
    const emit = (s: typeof cur) => {
      // back to end points: the point on the line at `s.from` and `s.to`; the offset is in the key
      const off = s.off
      const px = -s.uy * off
      const py = s.ux * off
      out.push({ sig, nums: [px + s.ux * s.from, py + s.uy * s.from, px + s.ux * s.to, py + s.uy * s.to] })
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
