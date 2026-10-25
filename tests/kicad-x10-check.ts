import { classIndex } from "../src/model/netClasses"
import type { Project } from "../src/model/types"
import { classOf, KICAD_DEFAULTS, readable, rulesOracle } from "./kicad-census/rules.mjs"

// The net classes and design rules of a built project against the oracle's reading of the raw file (`tests/kicad-census/rules.mjs`, which shares
// no code with `src`): every class with every field, the nets each lists, the rules `setup` gives, and, for every net of the file, the class the
// project's own lookup puts it in against the class the file's lists put it in.

export interface X10Check {
  /** Classes of the file other than Default. */
  classes: number
  /** What differs, in words; empty when the project has what the file has. */
  wrong: string[]
  /** Nets of the file whose class was looked up in the project, and how many were not (a name two nets share once read). */
  netsChecked: number
  netsSkipped: number
  /** Whether the file has any rule of X10 at all. */
  uses: boolean
}

const positive = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n) && n > 0
const same = (a: number | undefined, b: number | undefined) => (a === undefined || b === undefined ? a === b : Math.abs(a - b) < 1e-9)

export function checkX10(text: string, project: Project, lossy: string[] = []): X10Check {
  const o = rulesOracle(text)
  const wrong: string[] = []
  const rules = project.rules
  const def = o.classes.find((c) => c.name === "Default")
  const others = o.classes.filter((c) => c !== def)
  const out: X10Check = { classes: others.length, wrong, netsChecked: 0, netsSkipped: 0, uses: others.length > 0 || o.classes.some((c) => c.description !== "" && c.description !== KICAD_DEFAULTS.description) || o.setup.userVias.length + o.setup.userDiffPairs.length > 0 || [o.setup.maskMin, o.setup.pasteRatio, o.setup.clearanceMin].some((v) => positive(v) || (v !== undefined && v < 0)) }
  // a board the build could not take exactly is refused, and its project is whatever the forced build made
  if (lossy.some((l) => /net class|user_via|user_diff_pair|paste ratio/.test(l))) return out

  // ---- the Default class is the rules ----
  if (def) {
    const n = def.nodes
    if (n.clearance !== undefined && n.clearance >= 0 && !same(rules.clearance, n.clearance)) wrong.push(`clearance ${rules.clearance} is not the Default class's ${n.clearance}`)
    if (positive(n.trace_width) && !same(rules.traceWidth, n.trace_width)) wrong.push(`track width ${rules.traceWidth} is not the Default class's ${n.trace_width}`)
    if (positive(n.via_dia) && !same(rules.viaDiameter, n.via_dia)) wrong.push(`via diameter ${rules.viaDiameter} is not the Default class's ${n.via_dia}`)
    if (positive(n.via_drill) && !same(rules.viaDrill, n.via_drill)) wrong.push(`via drill ${rules.viaDrill} is not the Default class's ${n.via_drill}`)
    const own = rules.defaultClass
    const wantDescription = def.description !== "" && def.description !== KICAD_DEFAULTS.description ? def.description : undefined
    if (own?.description !== wantDescription) wrong.push(`the Default class's description is ${JSON.stringify(own?.description)}, the file's ${JSON.stringify(def.description)}`)
    const wantDia = positive(n.uvia_dia) && Math.abs(n.uvia_dia - KICAD_DEFAULTS.uviaDia) > 1e-12 ? n.uvia_dia : undefined
    const wantDrill = positive(n.uvia_drill) && Math.abs(n.uvia_drill - KICAD_DEFAULTS.uviaDrill) > 1e-12 ? n.uvia_drill : undefined
    if (!same(own?.microViaDiameter, wantDia) || !same(own?.microViaDrill, wantDrill)) wrong.push("the Default class's micro via size differs")
    const wantW = positive(n.diff_pair_width) ? n.diff_pair_width : undefined
    const wantG = positive(n.diff_pair_gap) ? n.diff_pair_gap : undefined
    if (!same(own?.diffPairWidth, wantW) || !same(own?.diffPairGap, wantG)) wrong.push("the Default class's differential pair differs")
  } else if (rules.defaultClass) wrong.push("the project has Default class fields for a file with no Default class")

  // ---- every other class ----
  const have = rules.netClasses ?? []
  if (have.length !== others.length || have.some((c, i) => c.name !== others[i].name)) {
    wrong.push(`classes ${have.map((c) => c.name).join(",") || "none"} against the file's ${others.map((c) => c.name).join(",") || "none"}`)
  } else {
    // the decoded names that two nets of the file share: the project tells them apart by their raw spelling, which the check cannot see
    const decoded = new Map<string, number>()
    for (const raw of o.nets) decoded.set(readable(raw).trim(), (decoded.get(readable(raw).trim()) ?? 0) + 1)
    const ambiguous = (raw: string) => (decoded.get(readable(raw).trim()) ?? 0) > 1 || readable(raw) !== readable(raw).trim()
    const effDia = def && positive(def.nodes.uvia_dia) && Math.abs(def.nodes.uvia_dia - KICAD_DEFAULTS.uviaDia) > 1e-12 ? def.nodes.uvia_dia : KICAD_DEFAULTS.uviaDia
    const effDrill = def && positive(def.nodes.uvia_drill) && Math.abs(def.nodes.uvia_drill - KICAD_DEFAULTS.uviaDrill) > 1e-12 ? def.nodes.uvia_drill : KICAD_DEFAULTS.uviaDrill
    others.forEach((c, i) => {
      const p = have[i]
      const n = c.nodes
      const tag = `class ${c.name}`
      if (!same(p.clearance, n.clearance) || !same(p.traceWidth, n.trace_width) || !same(p.viaDiameter, n.via_dia) || !same(p.viaDrill, n.via_drill)) wrong.push(`${tag}: its four sizes differ`)
      if ((p.description ?? "") !== c.description) wrong.push(`${tag}: description ${JSON.stringify(p.description)} against ${JSON.stringify(c.description)}`)
      const wantDia = positive(n.uvia_dia) && Math.abs(n.uvia_dia - effDia) > 1e-12 ? n.uvia_dia : undefined
      const wantDrill = positive(n.uvia_drill) && Math.abs(n.uvia_drill - effDrill) > 1e-12 ? n.uvia_drill : undefined
      if (!same(p.microViaDiameter, wantDia) || !same(p.microViaDrill, wantDrill)) wrong.push(`${tag}: its micro via size differs`)
      if (!same(p.diffPairWidth, positive(n.diff_pair_width) ? n.diff_pair_width : undefined) || !same(p.diffPairGap, positive(n.diff_pair_gap) ? n.diff_pair_gap : undefined)) wrong.push(`${tag}: its differential pair differs`)
      if (p.patterns?.length) wrong.push(`${tag}: a KiCad 5 class has no patterns`)
      // members: those that name no net of the project and read like none are kept by their readable name; a name two nets share is not compared
      const want = [...new Set(c.members.filter((raw) => !ambiguous(raw)).map((raw) => readable(raw)))]
      const got = p.nets.filter((net) => want.includes(net))
      if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`${tag}: nets ${JSON.stringify(p.nets.slice(0, 4))} against the file's ${JSON.stringify(want.slice(0, 4))}`)
      else if (p.nets.length !== want.length + c.members.filter((raw) => ambiguous(raw)).length && !c.members.some((raw) => ambiguous(raw))) wrong.push(`${tag}: ${p.nets.length} nets against the file's ${want.length}`)
    })
    // the class every net of the file is in, by the project's own lookup against the file's lists
    const index = classIndex(rules)
    for (const raw of o.nets) {
      if (raw === "" || ambiguous(raw)) {
        out.netsSkipped++
        continue
      }
      out.netsChecked++
      const got = index.classOf(readable(raw))?.name ?? "Default"
      const want = classOf(o, raw)
      if (got !== want) wrong.push(`net ${JSON.stringify(raw)} is in ${got} in the project and ${want} in the file`)
    }
  }

  // ---- the rules of setup ----
  const s = o.setup
  const wantVias = s.userVias.filter((v) => v.every(positive)).filter((v, i, all) => all.findIndex((w) => w[0] === v[0] && w[1] === v[1]) === i)
  const gotVias = (rules.viaSizes ?? []).map((v) => [v.diameter, v.drill])
  if (JSON.stringify(gotVias) !== JSON.stringify(wantVias)) wrong.push(`via sizes ${JSON.stringify(gotVias)} against ${JSON.stringify(wantVias)}`)
  const wantPairs = s.userDiffPairs.filter((v) => v.length >= 2 && positive(v[0]) && positive(v[1])).filter((v, i, all) => all.findIndex((w) => w.join() === v.join()) === i)
  const gotPairs = (rules.diffPairSizes ?? []).map((v) => (v.viaGap === undefined ? [v.width, v.gap] : [v.width, v.gap, v.viaGap]))
  if (JSON.stringify(gotPairs) !== JSON.stringify(wantPairs)) wrong.push(`differential pair sizes ${JSON.stringify(gotPairs)} against ${JSON.stringify(wantPairs)}`)
  if (!same(rules.maskMinWidth, positive(s.maskMin) ? s.maskMin : undefined)) wrong.push(`mask web ${rules.maskMinWidth} against ${s.maskMin}`)
  if (!same(rules.pasteRatio, s.pasteRatio !== undefined && Number.isFinite(s.pasteRatio) && s.pasteRatio !== 0 ? s.pasteRatio : undefined)) wrong.push(`paste ratio ${rules.pasteRatio} against ${s.pasteRatio}`)
  if (!same(rules.minClearance, positive(s.clearanceMin) ? s.clearanceMin : undefined)) wrong.push(`minimum clearance ${rules.minClearance} against ${s.clearanceMin}`)
  if (!same(rules.maxError, positive(s.maxError) && Math.abs(s.maxError - KICAD_DEFAULTS.maxError) > 1e-12 ? s.maxError : undefined)) wrong.push(`max error ${rules.maxError} against ${s.maxError}`)
  if ((rules.maskBridgesInParts === true) !== (s.bridges === "yes" || s.bridges === "true")) wrong.push("mask bridges differ")
  const wantViaDrill = positive(s.throughHoleMin) && positive(s.viaMinDrill) && Math.abs(s.throughHoleMin - s.viaMinDrill) > 1e-9 ? s.viaMinDrill : undefined
  if (!same(rules.minViaDrill, wantViaDrill)) wrong.push(`minimum via drill ${rules.minViaDrill} against ${wantViaDrill}`)
  return out
}
