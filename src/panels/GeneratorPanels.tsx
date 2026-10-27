import { useMemo } from "react"
import { netLengths, padDieTimes, tuningPatterns } from "../model/netLengths"
import { formatLength } from "../model/rules"
import { layerLabel } from "../model/stack"
import type { GenValue, PcbGroup, Project } from "../model/types"
import { useConnectivity, usePcbAnalysis } from "../store/analysis"
import { projectApi } from "../store/projectStore"
import { Field } from "../ui/controls"
import { LengthInput, Row, Section, useLengthUnit } from "../ui/form"
import { TUNING_KEYS, updateGeneratorProps, type TuningKey } from "./generatorEdits"

// X21: what the panels say of a generated item (a tuning pattern, a via stack, via stitching), of the board's net chains, and of a net's length.

/** A generator's kind in words. */
export const GENERATOR_NAMES: Record<string, string> = { tuning_pattern: "Tuning pattern", via_stack: "Via stack", via_stitch: "Via stitching" }
export const generatorName = (kind: string) => GENERATOR_NAMES[kind] ?? kind

const TUNING_FIELDS: { key: TuningKey; label: string; hint: string }[] = [
  { key: "target_length", label: "Target length", hint: "The length the net is tuned to" },
  { key: "target_length_min", label: "Shortest length", hint: "The least length the net may have" },
  { key: "target_length_max", label: "Longest length", hint: "The most length the net may have" },
  { key: "min_spacing", label: "Spacing", hint: "The least gap between two bends of the pattern" },
  { key: "max_amplitude", label: "Largest bend", hint: "The most a bend of the pattern may reach out" },
]

const isPoint = (v: GenValue) => typeof v === "object"

/** A parameter's value as a person reads it. */
const valueText = (v: GenValue): string => (typeof v === "number" ? String(Number(v.toFixed(4))) : typeof v === "boolean" ? (v ? "yes" : "no") : typeof v === "string" ? v : "")

/** What a selected generated group is, and its parameters; a tuning pattern's numbers can be changed. Nothing for a group that is not generated. */
export function GeneratorBlock({ group, project }: { group: PcbGroup; project: Project }) {
  const gen = group.gen
  if (!gen) return null
  const tuning = gen.kind === "tuning_pattern"
  const rows = Object.entries(gen.props).filter(([k, v]) => !isPoint(v) && !(tuning && (TUNING_KEYS as readonly string[]).includes(k)))
  const num = (k: string) => (typeof gen.props[k] === "number" ? (gen.props[k] as number) : null)
  return (
    <div className="space-y-2" aria-label="Generated item">
      <Row label="Made by" value={generatorName(gen.kind)} />
      <Row label="Layer" value={layerLabel(project.board, gen.layer)} />
      {tuning &&
        TUNING_FIELDS.map((f) => (
          <Field key={f.key} label={f.label}>
            <LengthInput
              ariaLabel={f.label}
              optional
              placeholder="Not set"
              value={num(f.key)}
              onCommit={(mm) => projectApi().commit((p) => updateGeneratorProps(p, group.id, { [f.key]: mm }))}
            />
          </Field>
        ))}
      {tuning && <p className="text-[12px] text-ink-3">The numbers are kept for the next tuning; the tracks are not drawn again. Checks compares the net with the range.</p>}
      {rows.length > 0 && (
        <table className="w-full text-[12.5px]" aria-label="Parameters">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <td className="mono pr-3 align-top text-ink-3">{k}</td>
                <td className="mono break-all text-right text-ink">{valueText(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/** The board's net chains, by name, with the nets each runs through. Nothing when the project has none. */
export function NetChainsSection({ project }: { project: Project }) {
  const chains = project.netChains
  if (!chains?.length) return null
  return (
    <Section title="Net chains" id="net-chains">
      <ul className="space-y-1.5" aria-label="Net chains">
        {chains.map((c) => (
          <li key={c.name} className="text-[12.5px]">
            <div className="text-ink">{c.name}</div>
            <div className="mono break-words text-ink-2">{c.nets.join(" > ")}</div>
          </li>
        ))}
      </ul>
    </Section>
  )
}

/**
 * The length report of a trace's net, when the project has something to add to the copper: a pad with a length inside its package, or a tuning pattern.
 * Other projects do not even look for it.
 */
export function NetLengthSection({ project, net }: { project: Project; net: string }) {
  const needed = useMemo(() => tuningPatterns(project).length > 0 || padDieTimes(project).length > 0, [project])
  return needed ? <NetLengthReport project={project} net={net} /> : null
}

function NetLengthReport({ project, net }: { project: Project; net: string }) {
  const unit = useLengthUnit()
  const conn = useConnectivity()
  const pcb = usePcbAnalysis()
  const l = useMemo(() => (conn && pcb ? netLengths(project, conn, pcb.traceNet, pcb.viaNet).find((n) => n.net === net) : undefined), [project, conn, pcb, net])
  if (!l) return null
  return (
    <div className="space-y-1" aria-label="Net length">
      <Row label="Net tracks" value={formatLength(l.tracks, unit, true)} />
      <Row label={`Net vias (${l.viaCount})`} value={formatLength(l.vias, unit, true)} />
      <Row label="Net in package" value={formatLength(l.package, unit, true)} />
      <Row label="Net total" value={formatLength(l.total, unit, true)} />
      {l.packageDelay > 0 && <Row label="Delay in package" value={`${l.packageDelay} ps`} />}
    </div>
  )
}
