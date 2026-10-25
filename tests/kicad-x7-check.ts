import { componentFootprint, maskSides, pasteSides, pcbPads, slotEnds } from "../src/model/instances"
import { holeCentre, padBox, pointPadDistance } from "../src/model/padDistance"
import type { Project } from "../src/model/types"
import type { OracleFootprint } from "./kicad-census/pads.mjs"

// Every pad of a built project against the oracle's reading of the raw file (`tests/kicad-census/pads.mjs` and `pad-detail.mjs`, which share no code
// with `src`): the copper's shape, size and turn as a distance field (the same point is as far from the copper in the project as the file's own
// rules say), the layers it is plotted on, its margins, clearance and pour settings, its hole (place, size, slot, offset, plated or not) and its number.

export interface X7Check {
  /** Pads compared, and those with something wrong. */
  pads: number
  wrong: number
  /** Points of the board whose distance to a pad's copper was compared. */
  samples: number
  /** What differs, in words (the first few). */
  notes: string[]
  /** How many pads have each feature, for the report. */
  features: Record<string, number>
}

const TOL = 0.002

/** A small deterministic generator, so a run is the same every time. */
function lcg(seed: number) {
  let s = seed >>> 0 || 1
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

const ZONE = ["none", "thermal", "solid", "tht"] as const
const same = (a: number | undefined, b: number | undefined, eps = 1e-6) => (a === undefined || b === undefined ? a === b : Math.abs(a - b) <= eps)
const setEq = (a: Iterable<string>, b: Iterable<string>) => {
  const x = [...a].sort().join()
  return x === [...b].sort().join()
}

export function checkPads(o: OracleFootprint[], project: Project): X7Check {
  const out: X7Check = { pads: 0, wrong: 0, samples: 0, notes: [], features: {} }
  const refCount = new Map<string, number>()
  for (const f of o) refCount.set(f.ref, (refCount.get(f.ref) ?? 0) + 1)
  const feature = (k: string) => (out.features[k] = (out.features[k] ?? 0) + 1)
  for (const comp of project.components) {
    const f = o.find((q) => q.ref === comp.ref)
    if (!f || refCount.get(f.ref) !== 1 || !f.pads.length) continue
    const land = componentFootprint(comp)
    const world = pcbPads(comp)
    if (!land || world.length !== f.pads.length) continue
    const rand = lcg(f.pads.length * 7919 + comp.ref.length)
    for (let j = 0; j < world.length; j++) {
      const p = f.pads[j]
      const w = world[j]
      const d = p.detail
      const bad: string[] = []
      out.pads++
      feature(`shape:${d.eff}`)
      if ((((p.angle - f.angle) % 90) + 90) % 90 > 1e-6 && ((((p.angle - f.angle) % 90) + 90) % 90) < 90 - 1e-6) feature("turned within its part")
      if (d.hole && (p.type === "thru_hole" || p.type === "np_thru_hole")) {
        feature(d.hole.plated ? "plated hole" : "non-plated hole")
        if (d.hole.slot) feature("slot")
      }
      if (Math.hypot(p.cx - p.x, p.cy - p.y) > 1e-9) feature("hole off the copper's centre")
      if (d.margins.mask !== undefined) feature("mask margin")
      if (d.margins.paste !== undefined || d.margins.ratio !== undefined) feature("paste margin")
      if (d.margins.clearance !== undefined) feature("clearance")
      if (d.margins.zone !== undefined) feature("zone connection")
      if (d.margins.thermalGap !== undefined || d.margins.thermalWidth !== undefined || d.margins.thermalAngle !== undefined) feature("thermal settings")
      if (d.property) feature("fabrication property")
      if (p.number === "" ) feature("unnumbered")
      // ---- the copper: a distance field, from the file and from the project ----
      const noCopper = w.plated === false && !w.ring
      const box = padBox(w)
      const around = Math.max(box.maxX - box.minX, box.maxY - box.minY, 0.5)
      const centre = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 }
      let worst = 0
      let at = ""
      for (let n = 0; n < 48; n++) {
        const x = centre.x + (rand() * 2 - 1) * (around * 0.75 + 0.4)
        const y = centre.y + (rand() * 2 - 1) * (around * 0.75 + 0.4)
        // the project is y up, the file y down
        const mine = pointPadDistance({ x, y }, w)
        const ref = noCopper ? (d.holeSd ? d.holeSd(x, -y) : Infinity) : d.sd(x, -y)
        out.samples++
        const diff = Math.abs(Math.max(0, ref) - mine)
        if (diff > worst) {
          worst = diff
          at = `(${x.toFixed(3)}, ${y.toFixed(3)}): project ${mine.toFixed(4)}, file ${Math.max(0, ref).toFixed(4)}`
        }
      }
      if (worst > TOL) bad.push(`copper differs by ${worst.toFixed(4)} at ${at} (${d.eff})`)
      // ---- the layers ----
      const sides = (set: Iterable<string>) => [...set].map((s) => (s === "F" ? "top" : "bottom"))
      if (w.plated === false) {
        // a non-plated hole's `layers` are the obstacle's (both sides); the copper it flashes is its ring
        if (!setEq(w.ring ?? [], sides(d.faces.flashed))) bad.push(`copper layers of a hole ${(w.ring ?? []).join("+") || "none"} against the file's ${sides(d.faces.flashed).join("+") || "none"}`)
      } else if (!setEq(w.layers, sides(d.faces.flashed))) bad.push(`copper layers ${w.layers.join("+")} against the file's ${sides(d.faces.flashed).join("+")}`)
      if (!setEq(maskSides(w), sides(d.faces.mask))) bad.push(`mask layers ${maskSides(w).join("+")} against the file's ${sides(d.faces.mask).join("+")}`)
      if (!setEq(pasteSides(w), sides(d.faces.paste))) bad.push(`paste layers ${pasteSides(w).join("+")} against the file's ${sides(d.faces.paste).join("+")}`)
      // ---- the settings ----
      const m = d.margins
      if (!same(w.maskMargin, m.mask)) bad.push(`mask margin ${w.maskMargin} against ${m.mask}`)
      if (!same(w.pasteMargin, m.paste)) bad.push(`paste margin ${w.pasteMargin} against ${m.paste}`)
      if (!same(w.pasteRatio, m.ratio)) bad.push(`paste ratio ${w.pasteRatio} against ${m.ratio}`)
      if (!same(w.clearance, m.clearance)) bad.push(`clearance ${w.clearance} against ${m.clearance}`)
      if (w.zoneConnect !== (m.zone === undefined ? undefined : ZONE[m.zone])) bad.push(`pour connection ${w.zoneConnect} against ${m.zone}`)
      if (!same(w.thermalGap, m.thermalGap) || !same(w.thermalWidth, m.thermalWidth) || !same(w.thermalAngle, m.thermalAngle)) bad.push("thermal settings")
      if ((w.property ? `pad_prop_${w.property}` : undefined) !== d.property) bad.push(`fabrication property ${w.property} against ${d.property}`)
      // ---- the hole ----
      if (!d.hole) {
        if (w.holeDiameter !== undefined) bad.push("the project has a hole the file has not")
      } else if (w.holeDiameter === undefined) bad.push("the file has a hole the project has not")
      else {
        const h = holeCentre(w)
        if (Math.hypot(h.x - d.hole.x, h.y + d.hole.y) > 0.001) bad.push(`hole at (${h.x}, ${h.y}) against (${d.hole.x}, ${-d.hole.y})`)
        if (!same(w.holeDiameter, d.hole.d, 1e-6)) bad.push(`drill ${w.holeDiameter} against ${d.hole.d}`)
        const ends = slotEnds(w)
        if (!!ends !== !!d.hole.ends) bad.push("slot against round hole")
        else if (ends && d.hole.ends) {
          const [a, b] = d.hole.ends
          const direct = Math.hypot(ends[0].x - a[0], ends[0].y + a[1]) + Math.hypot(ends[1].x - b[0], ends[1].y + b[1])
          const swapped = Math.hypot(ends[0].x - b[0], ends[0].y + b[1]) + Math.hypot(ends[1].x - a[0], ends[1].y + a[1])
          if (Math.min(direct, swapped) > 0.002) bad.push("slot ends differ")
          if (!same(w.slotLength, d.hole.slot ?? undefined, 1e-6)) bad.push(`slot length ${w.slotLength} against ${d.hole.slot}`)
        }
        if ((w.plated === false) === d.hole.plated) bad.push("plated against non-plated")
      }
      // ---- the number ----
      if ((w.padNumber ?? "") !== d.numberKicad) bad.push(`number ${JSON.stringify(w.padNumber)} against ${JSON.stringify(d.numberKicad)}`)
      if (bad.length) {
        out.wrong++
        if (out.notes.length < 6) out.notes.push(`${comp.ref} pad ${j} (${p.number || "no number"}, ${p.shape}): ${bad.join("; ")}`)
      }
    }
  }
  return out
}
