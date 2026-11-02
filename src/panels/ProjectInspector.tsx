import { ChevronDown, Plus, Trash2 } from "lucide-react"
import { resolvedComponents } from "../model/ruleAreas"
import { useMemo, useState } from "react"
import { uid } from "../lib/id"
import { KicadReportDialog } from "../kicadImport/ReportDialog"
import { loadReport } from "../kicadImport/reportStore"
import { boardColors, boardFinish, DEFAULT_MASK_COLOR, defaultSilkColor, MOUNTING_HOLE_PRESETS, SURFACE_FINISHES } from "../model/board"
import { boardAreaMm2, describeOutline } from "../model/outline"
import { resetOutline } from "../model/outlineOps"
import { clearImportedNoConnect, importedNoConnectCount } from "../model/importMarks"
import { valueText } from "../model/instances"
import { classIndex, classNameOf, hasNetClasses } from "../model/netClasses"
import { bareName } from "../model/connectivity"
import { isMadeUpName, setNetStyle } from "../model/netEdit"
import { findPart } from "../model/library"
import { netTraceWidth } from "../model/ops"
import {
  applyCapability,
  BOARD_THICKNESSES,
  boardStackup,
  FAB_CAPABILITIES,
  formatLength,
  fromUnit,
  matchCapability,
  THERMAL_RELIEF_OPTIONS,
  zoneClearance,
} from "../model/rules"
import { copperLayers, layerLabel } from "../model/stack"
import { removeStitching, STITCH_PITCHES, stitchCount, stitchPitch, stitchVias } from "../model/stitch"
import type { CopperLayer, CopperWeight, DesignRules, NetStyle, Project, SurfaceFinish } from "../model/types"
import { getConnectivity, getLiveAnalysis, useFillTick } from "../store/analysis"
import { projectApi } from "../store/projectStore"
import { uiApi, useUi } from "../store/uiStore"
import { shapeLayerInfo } from "../model/shapeLayers"
import { isOtherZone, isWholeBoardPour, keepoutFlags, zoneLayers, zoneOtherLayers } from "../model/zones"
import { placementWords } from "../model/placementAreas"
import { Button, Field, IconButton, Segmented } from "../ui/controls"
import { NetClassesSection, NetClassField } from "./NetClassesSection"
import { ColorField, CommitInput, Group, LengthInput, Row, RuleGroup, RuleRow, Section, Switch, useLengthUnit } from "../ui/form"
import { onBoard } from "../model/partFlags"
import { LayersSection } from "./LayersSection"
import { VariantsSection } from "./VariantPanels"
import { ViaProtectRules } from "./MachiningPanels"
import { NetChainsSection } from "./GeneratorPanels"

const commitProject = (fn: (p: Project) => Project) => projectApi().commit((p) => ({ ...fn(p), updatedAt: Date.now() }))
const setBoard = (patch: Partial<Project["board"]>) => commitProject((p) => ({ ...p, board: { ...p.board, ...patch } }))
const setRules = (patch: Partial<DesignRules>) =>
  commitProject((p) => {
    const rules: DesignRules = { ...p.rules, ...patch }
    // A field set to undefined is a field cleared.
    for (const k of Object.keys(patch) as (keyof DesignRules)[]) if (patch[k] === undefined) delete rules[k]
    return { ...p, rules }
  })
/** The via tenting rule for each side: one for both sides is `tentVias` alone, any other is the sides as well. */
const tentRule = (t: { front: boolean; back: boolean }): Partial<DesignRules> => (t.front === t.back ? { tentVias: t.front, tentSides: undefined } : { tentVias: false, tentSides: t })

export function ProjectInspector({ project }: { project: Project }) {
  const imported = importedNoConnectCount(project)
  return (
    <div>
      <ProjectSection project={project} />
      {imported > 0 && (
        <Section title="Imported from KiCad" id="imported-marks">
          <Row label="No-connect pins" value={imported} />
          <p className="text-[12px] text-ink-2">The import marked these pins no connect because the file puts no net on them, so Checks does not list each. Hand them back to be checked.</p>
          <Button onClick={() => projectApi().commit((p) => clearImportedNoConnect(p))}>Check imported no-connect pins</Button>
        </Section>
      )}
      <PropertiesSection project={project} />
      <VariantsSection project={project} />
      <KicadReportSection projectId={project.id} file={project.kicad?.report} />
      <BoardSection project={project} />
      <LayersSection project={project} />
      <RulesSection project={project} />
      <PoursSection project={project} />
      <NetsSection project={project} />
      <NetClassesSection project={project} />
      <NetChainsSection project={project} />
    </div>
  )
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })

function ProjectSection({ project }: { project: Project }) {
  const fillTick = useFillTick((s) => s.tick)
  const stats = useMemo(() => {
    const conn = getConnectivity(project)
    const pcb = getLiveAnalysis(project)
    const parts = resolvedComponents(project).filter((c) => onBoard(c))
    const placed = new Set(parts.filter((c) => c.pcb.placed).map((c) => c.id))
    const lines = new Set(parts.map((c) => JSON.stringify([c.partId, valueText(c, findPart(c.partId)), c.footprint, c.props.mpn ?? ""])))
    // A net with n placed pins needs n - 1 connections; the ratsnest is the ones still open.
    let connections = 0
    for (const n of conn.nets) {
      const pins = new Set(n.pins.filter((p) => placed.has(p.componentId)).map((p) => `${p.componentId}:${p.pin}`))
      connections += Math.max(0, pins.size - 1)
    }
    const unrouted = pcb.ratsnest.length
    return {
      parts: parts.length,
      placed: placed.size,
      lines: lines.size,
      nets: conn.nets.filter((n) => n.pins.length > 0).length,
      routed: connections ? `${connections - unrouted} of ${connections}` : "None to route",
    }
  }, [project, fillTick])
  const b = project.board
  return (
    <Section title="Project" id="project">
      <Field label="Name">
        <CommitInput value={project.name} onCommit={(v) => v.trim() && commitProject((p) => ({ ...p, name: v.trim() }))} />
      </Field>
      <DescriptionField value={project.description} />
      <div className="space-y-1 pt-0.5">
        <Row label="Parts" value={stats.placed === stats.parts ? stats.parts : `${stats.parts} (${stats.placed} on the board)`} />
        <Row label="Unique parts" value={stats.lines} />
        <Row label="Nets" value={stats.nets} />
        <Row label="Connections routed" value={stats.routed} />
        <Row label="Vias" value={project.vias.length} />
        <Row label="Board area" value={`${(boardAreaMm2(b) / 100).toFixed(1)} cm²`} />
        <Row label="Created" value={dateFormat.format(project.createdAt)} />
        <Row label="Modified" value={dateFormat.format(project.updatedAt)} />
      </div>
    </Section>
  )
}

/** Multi-line description that commits on blur; Escape throws the edit away. */
function DescriptionField({ value }: { value: string }) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <Field label="Description">
      <textarea
        className="field scroll-thin block min-h-[60px] resize-y py-1.5 leading-[1.45]"
        rows={3}
        value={draft ?? value}
        placeholder="What the board does, for the next person to open it"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null && draft !== value) commitProject((p) => ({ ...p, description: draft }))
          setDraft(null)
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setDraft(null)
            requestAnimationFrame(() => (e.target as HTMLTextAreaElement).blur())
          }
        }}
      />
    </Field>
  )
}

/** The report of the KiCad import that made this project, from this browser or the file the project names; nothing shows for any other project. */
export function KicadReportSection({ projectId, file }: { projectId: string; file: string | undefined }) {
  const here = useMemo(() => !!loadReport(projectId), [projectId])
  const [open, setOpen] = useState(false)
  if (!here && !file) return null
  return (
    <Section title="KiCad import" id="kicad-import">
      <p className="text-[12.5px] text-ink-2">What came in from KiCad, what was left out and why.</p>
      <Button onClick={() => setOpen(true)}>View import report</Button>
      {open && <KicadReportDialog projectId={projectId} file={file} onClose={() => setOpen(false)} />}
    </Section>
  )
}

const SUGGESTED_PROPERTIES = ["Revision", "Author", "Company", "Licence"]

function PropertiesSection({ project }: { project: Project }) {
  const props = project.properties ?? []
  const setProps = (fn: (list: NonNullable<Project["properties"]>) => NonNullable<Project["properties"]>) =>
    commitProject((p) => {
      const next = fn(p.properties ?? [])
      return { ...p, properties: next.length ? next : undefined }
    })
  const add = (key: string) => setProps((list) => [...list, { key, value: "" }])
  const unused = SUGGESTED_PROPERTIES.filter((k) => !props.some((p) => p.key.toLowerCase() === k.toLowerCase()))
  const uniqueKey = () => {
    let n = 1
    while (props.some((p) => p.key === `Property ${n}`)) n++
    return `Property ${n}`
  }
  return (
    <Section
      title="Properties"
      id="properties"
      action={
        <IconButton label="Add property" className="-my-1 h-7 w-7" onClick={() => add(uniqueKey())}>
          <Plus size={14} />
        </IconButton>
      }
    >
      {props.length === 0 && <p className="text-[12.5px] text-ink-2">Revision, author, licence and anything else the fab or the next engineer should know. They go in the fabrication notes.</p>}
      {props.map((prop, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <CommitInput
            ariaLabel={`Property ${i + 1} name`}
            value={prop.key}
            className="w-[104px] shrink-0 text-ink-2"
            onCommit={(v) => v.trim() && setProps((list) => list.map((x, j) => (j === i ? { ...x, key: v.trim() } : x)))}
          />
          <CommitInput
            ariaLabel={prop.key}
            value={prop.value}
            placeholder="Value"
            className="min-w-0 flex-1"
            onCommit={(v) => setProps((list) => list.map((x, j) => (j === i ? { ...x, value: v.trim() } : x)))}
          />
          <IconButton label={`Remove ${prop.key}`} className="shrink-0" onClick={() => setProps((list) => list.filter((_, j) => j !== i))}>
            <Trash2 size={14} />
          </IconButton>
        </div>
      ))}
      {unused.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {unused.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => add(k)}
              className="inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-line px-2 text-[12px] text-ink-2 hover:border-ink-3 hover:text-ink"
            >
              <Plus size={11} /> {k}
            </button>
          ))}
        </div>
      )}
    </Section>
  )
}

function BoardSection({ project }: { project: Project }) {
  const b = project.board
  const colors = boardColors(b)
  const thicknesses = BOARD_THICKNESSES.includes(b.thickness) ? BOARD_THICKNESSES : [...BOARD_THICKNESSES, b.thickness].sort((x, y) => x - y)
  const holes = MOUNTING_HOLE_PRESETS.find((o) => o.holes.drill === b.mountingHoles?.drill)
  return (
    <Section title="Board" id="board">
      {b.outline ? (
        <div className="space-y-1.5 rounded-[8px] border border-line p-2 text-[12.5px]">
          <Row label="Outline" value={describeOutline(b)} />
          <Row label="Bounding box" value={`${Number(b.width.toFixed(3))} x ${Number(b.height.toFixed(3))} mm`} />
          <p className="text-ink-3">This board has an outline of its own, drawn on the Edge.Cuts layer, and its size follows it. Draw a closed shape inside it for a cutout, or pick the outline to move a corner or bend an edge into an arc.</p>
          <Button title="Remove the drawn outline: the board becomes the rectangle of its bounding box" onClick={() => commitProject((p) => resetOutline(p))}>
            Back to a rectangle
          </Button>
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        {!b.outline && (
          <>
            <Field label="Width">
              <LengthInput min={5} value={b.width} onCommit={(v) => v !== null && setBoard({ width: v })} />
            </Field>
            <Field label="Height">
              <LengthInput min={5} value={b.height} onCommit={(v) => v !== null && setBoard({ height: v })} />
            </Field>
          </>
        )}
        <Field label="Thickness">
          <select className="field h-8" value={b.thickness} onChange={(e) => setBoard({ thickness: Number(e.target.value) })}>
            {thicknesses.map((t) => (
              <option key={t} value={t}>
                {t} mm
              </option>
            ))}
          </select>
        </Field>
        {!b.outline && (
          <Field label="Corner radius">
            <LengthInput value={b.cornerRadius} onCommit={(v) => v !== null && setBoard({ cornerRadius: Math.min(v, b.width / 2, b.height / 2) })} />
          </Field>
        )}
        <Group label="Copper">
          <Segmented<string>
            size="sm"
            value={String(b.copperWeight ?? 1)}
            onChange={(v) => setBoard({ copperWeight: Number(v) as CopperWeight })}
            options={[
              { value: "1", label: "1 oz", title: "35 µm, the standard" },
              { value: "2", label: "2 oz", title: "70 µm, for high current" },
            ]}
          />
        </Group>
        <Field label="Surface finish">
          <select className="field h-8" value={boardFinish(b)} onChange={(e) => setBoard({ finish: e.target.value as SurfaceFinish })}>
            {SURFACE_FINISHES.map((f) => (
              <option key={f.value} value={f.value} title={f.title}>
                {f.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Group label="Solder mask">
        <ColorField label="Solder mask colour" value={b.maskColor} fallback={DEFAULT_MASK_COLOR} onCommit={(maskColor) => setBoard({ maskColor })} />
      </Group>
      <Group label="Silkscreen">
        <ColorField label="Silkscreen colour" value={b.silkColor} fallback={defaultSilkColor(colors.mask)} onCommit={(silkColor) => setBoard({ silkColor })} />
      </Group>
      {(!b.outline || b.outline.seed) && (
        <Group label="Mounting holes">
          <Segmented
            size="sm"
            value={holes?.id ?? "none"}
            onChange={(v) => setBoard({ mountingHoles: MOUNTING_HOLE_PRESETS.find((o) => o.id === v)?.holes ?? null })}
            options={[{ value: "none", label: "None" }, ...MOUNTING_HOLE_PRESETS.map((o) => ({ value: o.id, label: o.label, title: `${o.holes.drill} mm drill, ${o.holes.inset} mm from the edges` }))]}
          />
        </Group>
      )}
      <Stackup project={project} />
    </Section>
  )
}

function Stackup({ project }: { project: Project }) {
  const layers = boardStackup(project.board)
  const open = useUi((s) => !s.folded["stackup"])
  const unit = useLengthUnit()
  const swatch = { silk: boardColors(project.board).silk, mask: boardColors(project.board).mask, paste: "#b9bcc4", copper: "#c8803c", core: "#8f8358" }
  return (
    <div>
      <button type="button" className="flex w-full items-center justify-between text-[12px] text-ink-2 hover:text-ink" aria-expanded={open} onClick={() => uiApi().toggleFolded("stackup")}>
        <span>Stackup</span>
        <span className="flex items-center gap-1 text-ink-3">
          {copperLayers(project.board).length} layers, {project.board.thickness} mm
          <ChevronDown size={13} className={`transition-transform ${open ? "" : "-rotate-90"}`} />
        </span>
      </button>
      {open && (
        <table className="mt-1.5 w-full table-fixed text-[12px]">
          <thead>
            <tr className="text-left text-[11px] text-ink-3">
              <th className="w-[44%] pb-1 font-normal">Layer</th>
              <th className="pb-1 font-normal">Material</th>
              <th className="w-[56px] pb-1 text-right font-normal">{unit}</th>
            </tr>
          </thead>
          <tbody>
            {layers.map((l) => (
              <tr key={l.name} className="border-b border-chrome-2 last:border-0">
                <td className="py-[5px] pr-2">
                  <span className="flex min-w-0 items-center gap-2 whitespace-nowrap text-ink" title={l.name}>
                    <span className="h-2.5 w-2.5 shrink-0 rounded-[2px] shadow-[inset_0_0_0_1px_rgb(0_0_0/0.25)]" style={{ background: swatch[l.kind] }} />
                    <span className="min-w-0 truncate">{l.name}</span>
                  </span>
                </td>
                <td className="max-w-[90px] truncate whitespace-nowrap py-[5px] pr-2 text-ink-3" title={l.material}>{l.material}</td>
                <td className="mono py-[5px] text-right text-ink-2">{l.thickness === null ? "" : formatLength(l.thickness, unit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/** Space-separated widths in the current unit. */
function WidthsInput({ rules }: { rules: DesignRules }) {
  const unit = useLengthUnit()
  return (
    <CommitInput
      ariaLabel="Preferred trace widths"
      className="tabular-nums"
      value={rules.preferredWidths.map((w) => formatLength(w, unit)).join(" ")}
      onCommit={(v) => {
        const widths = v
          .split(/[\s,;]+/)
          .map((s) => Number(s))
          .filter((n) => Number.isFinite(n) && n > 0)
          .map((n) => Number(fromUnit(n, unit).toFixed(4)))
        if (widths.length) setRules({ preferredWidths: [...new Set(widths)].sort((a, b) => a - b) })
      }}
    />
  )
}

/** Via sizes offered while routing, as `0.8/0.4 1/0.5`: diameter and drill. */
function ViaSizesInput({ rules }: { rules: DesignRules }) {
  const unit = useLengthUnit()
  return (
    <CommitInput
      ariaLabel="Via sizes offered"
      mono
      className="tabular-nums"
      placeholder="none"
      value={(rules.viaSizes ?? []).map((v) => `${formatLength(v.diameter, unit)}/${formatLength(v.drill, unit)}`).join(" ")}
      onCommit={(text) => {
        const sizes = text
          .split(/[\s,;]+/)
          .map((pair) => pair.split("/").map((n) => Number(n)))
          .filter((pair) => pair.length === 2 && pair.every((n) => Number.isFinite(n) && n > 0) && pair[0] > pair[1])
          .map(([d, h]) => ({ diameter: Number(fromUnit(d, unit).toFixed(4)), drill: Number(fromUnit(h, unit).toFixed(4)) }))
        setRules({ viaSizes: sizes.length ? sizes : undefined })
      }}
    />
  )
}

function RulesSection({ project }: { project: Project }) {
  const r = project.rules
  const cap = matchCapability(r)
  const unit = useLengthUnit()
  const len = (key: keyof DesignRules, min = 0, label?: string) => (
    <LengthInput ariaLabel={label} min={min} value={r[key] as number} onCommit={(v) => v !== null && setRules({ [key]: v })} />
  )
  const ring = (r.viaDiameter - r.viaDrill) / 2
  return (
    <Section
      title="Design rules"
      id="rules"
      action={
        <Segmented<"mm" | "mil">
          size="sm"
          value={unit}
          onChange={(u) => uiApi().updateSettings({ units: u })}
          options={[
            { value: "mm", label: "mm", title: "Millimetres" },
            { value: "mil", label: "mil", title: "Thousandths of an inch" },
          ]}
        />
      }
    >
      <Field label="Fab capability" hint={cap?.description ?? "Set by hand. Pick a class to reset the limits the fab sets."}>
        <select
          className="field h-8"
          value={cap?.id ?? "custom"}
          onChange={(e) => {
            const next = FAB_CAPABILITIES.find((f) => f.id === e.target.value)
            if (next) commitProject((p) => ({ ...p, rules: applyCapability(p.rules, next) }))
          }}
        >
          {FAB_CAPABILITIES.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
          {!cap && <option value="custom">Custom</option>}
        </select>
      </Field>

      <RuleGroup title="Traces">
        <RuleRow label="Default width" hint="Width of new traces, and of signal traces the autorouter lays">
          {len("traceWidth", 0.05, "Default trace width")}
        </RuleRow>
        <RuleRow label="Minimum width" hint="Narrower traces fail the checks">
          {len("minTraceWidth", 0.01, "Minimum trace width")}
        </RuleRow>
        <div className="space-y-1">
          <span className="block text-[12.5px] text-ink-2" title="Offered for a selected trace, and cycled with W while routing">
            Preferred widths <span className="text-ink-3">({unit})</span>
          </span>
          <WidthsInput rules={r} />
        </div>
        <div className="space-y-1">
          <span className="block text-[12.5px] text-ink-2" title="Via sizes offered while routing besides the default, as diameter/drill; KiCad's user via sizes">
            Via sizes offered <span className="text-ink-3">(diameter/drill, {unit})</span>
          </span>
          <ViaSizesInput rules={r} />
        </div>
      </RuleGroup>

      <RuleGroup title="Clearance">
        <RuleRow label="Copper to copper" hint="Between traces, pads, vias and pours on different nets">
          {len("clearance", 0.01, "Copper clearance")}
        </RuleRow>
        <RuleRow label="Copper to board edge" hint="Traces, vias and pads keep this far from the outline; pours are inset by it">
          {len("edgeClearance", 0, "Copper to board edge")}
        </RuleRow>
        <RuleRow label="Hole to hole" hint="Drill edge to drill edge, between vias and the holes of different parts">
          {len("holeClearance", 0, "Hole to hole clearance")}
        </RuleRow>
        <RuleRow label="Minimum clearance" hint="No pair of nets is checked below this, whatever their net classes ask for; leave empty for none">
          <LengthInput ariaLabel="Minimum clearance" min={0} optional placeholder="none" value={r.minClearance ?? null} onCommit={(v) => setRules({ minClearance: v === null || v <= 0 ? undefined : v })} />
        </RuleRow>
      </RuleGroup>

      <RuleGroup title="Vias and holes">
        <RuleRow label="Via diameter" hint="Copper diameter of new vias">
          {len("viaDiameter", 0.1, "Via diameter")}
        </RuleRow>
        <RuleRow label="Via drill" hint="Drill of new vias">
          {len("viaDrill", 0.05, "Via drill")}
        </RuleRow>
        <RuleRow label="Minimum drill" hint="Smaller holes fail the checks">
          {len("minDrill", 0.01, "Minimum drill")}
        </RuleRow>
        <RuleRow label="Minimum via drill" hint="Vias drilled smaller than this fail the checks; leave empty to use the minimum drill, which then holds for vias as well as through holes">
          <LengthInput ariaLabel="Minimum via drill" min={0} optional placeholder="same" value={r.minViaDrill ?? null} onCommit={(v) => setRules({ minViaDrill: v === null || v <= 0 ? undefined : v })} />
        </RuleRow>
        <RuleRow label="Minimum annular ring" hint="Copper left around a plated hole: (pad - drill) / 2">
          {len("minAnnularRing", 0, "Minimum annular ring")}
        </RuleRow>
        <RuleRow label="Minimum via diameter" hint="Vias narrower than this fail the checks; leave empty for no minimum">
          <LengthInput ariaLabel="Minimum via diameter" min={0} optional placeholder="none" value={r.minViaDiameter ?? null} onCommit={(v) => setRules({ minViaDiameter: v === null || v <= 0 ? undefined : v })} />
        </RuleRow>
        <RuleRow label="Via in pad" hint="Let vias sit in SMD pads; the fab fills and caps them, usually at extra cost">
          <Switch label="Allow via in pad" checked={r.viaInPad} onChange={(viaInPad) => setRules({ viaInPad })} />
        </RuleRow>
        <p className={`text-[11.5px] ${ring < r.minAnnularRing - 1e-6 ? "text-danger" : "text-ink-3"}`}>
          New vias have a {formatLength(ring, unit, true)} ring{ring < r.minAnnularRing - 1e-6 ? `, below the ${formatLength(r.minAnnularRing, unit, true)} minimum` : ""}.
        </p>
      </RuleGroup>

      <RuleGroup title="Solder mask and paste">
        <RuleRow label="Mask expansion" hint="How far the mask opening reaches past each pad">
          {len("maskExpansion", 0, "Solder mask expansion")}
        </RuleRow>
        <RuleRow label="Paste expansion" hint="Stencil aperture past each SMD pad; negative shrinks it">
          <LengthInput ariaLabel="Paste expansion" min={-1} value={r.pasteExpansion} onCommit={(v) => v !== null && setRules({ pasteExpansion: v })} />
        </RuleRow>
        <RuleRow label="Mask web" hint="Mask openings closer than this are merged into one when the mask is plotted, as KiCad does; leave empty to plot each opening on its own">
          <LengthInput ariaLabel="Mask web" min={0} optional placeholder="none" value={r.maskMinWidth ?? null} onCommit={(v) => setRules({ maskMinWidth: v === null || v <= 0 ? undefined : v })} />
        </RuleRow>
        <RuleRow label="Paste ratio (%)" hint="Stencil aperture growth as a percentage of the pad, on each side, on top of the paste expansion; negative shrinks it">
          <CommitInput
            ariaLabel="Paste ratio"
            type="number"
            step={1}
            value={r.pasteRatio === undefined ? "" : Number((r.pasteRatio * 100).toFixed(4))}
            placeholder="0"
            onCommit={(v) => {
              const n = Number(v)
              setRules({ pasteRatio: v.trim() === "" || !Number.isFinite(n) || n === 0 || Math.abs(n) >= 1000 ? undefined : n / 100 })
            }}
          />
        </RuleRow>
        <RuleRow label="Tent vias" hint="Cover vias with solder mask; untented vias are left open like pads">
          <Switch label="Tent vias" checked={r.tentVias} onChange={(tentVias) => setRules({ tentVias, tentSides: undefined })} />
        </RuleRow>
        {(r.tentSides || project.board.stack !== undefined) && (
          <>
            <RuleRow label="Tent the front" hint="The rule for vias on the front side; a via can say its own">
              <Switch label="Tent the front" checked={r.tentSides ? r.tentSides.front : r.tentVias} onChange={(front) => setRules(tentRule({ front, back: r.tentSides ? r.tentSides.back : r.tentVias }))} />
            </RuleRow>
            <RuleRow label="Tent the back" hint="The rule for vias on the back side; a via can say its own">
              <Switch label="Tent the back" checked={r.tentSides ? r.tentSides.back : r.tentVias} onChange={(back) => setRules(tentRule({ front: r.tentSides ? r.tentSides.front : r.tentVias, back }))} />
            </RuleRow>
          </>
        )}
        <ViaProtectRules project={project} />
        {project.vias.some((v) => v.kind === "micro") || r.minMicroVia ? (
          <RuleRow label="Smallest micro via" hint="KiCad's minimum micro via diameter and drill, which Checks holds micro vias to">
            <span className="mono text-[12.5px] text-ink-2">{r.minMicroVia ? `${r.minMicroVia.diameter} / ${r.minMicroVia.drill} mm` : "not set"}</span>
          </RuleRow>
        ) : null}
      </RuleGroup>

      <RuleGroup title="Copper pours">
        <RuleRow label="Clearance" hint="Gap between a pour and copper on other nets">
          {len("pourClearance", 0.05, "Pour clearance")}
        </RuleRow>
        <RuleRow label="Minimum width" hint="Necks of pour thinner than this are removed">
          {len("pourMinWidth", 0.05, "Pour minimum width")}
        </RuleRow>
        <Group label="Thermal relief">
          <Segmented
            size="sm"
            value={r.thermalRelief}
            onChange={(thermalRelief) => setRules({ thermalRelief })}
            options={THERMAL_RELIEF_OPTIONS}
          />
        </Group>
        {r.thermalRelief !== "direct" && (
          <>
            <RuleRow label="Spokes">
              <Segmented<string>
                size="sm"
                value={String(r.thermalSpokes)}
                onChange={(v) => setRules({ thermalSpokes: v === "2" ? 2 : 4 })}
                options={[
                  { value: "2", label: "2" },
                  { value: "4", label: "4" },
                ]}
              />
            </RuleRow>
            <RuleRow label="Spoke angle">
              <Segmented<string>
                size="sm"
                value={String(r.thermalSpokeAngle)}
                onChange={(v) => setRules({ thermalSpokeAngle: v === "45" ? 45 : 0 })}
                options={[
                  { value: "0", label: "90°", title: "Square to the pad" },
                  { value: "45", label: "45°", title: "Diagonal" },
                ]}
              />
            </RuleRow>
            <RuleRow label="Spoke width">{len("thermalSpokeWidth", 0.1, "Thermal spoke width")}</RuleRow>
            <RuleRow label="Thermal gap">
              <LengthInput
                ariaLabel="Thermal gap"
                min={0}
                optional
                placeholder={formatLength(r.pourClearance, unit)}
                value={r.thermalGap ?? null}
                onCommit={(v) => setRules({ thermalGap: v === null || v <= 0 ? undefined : v })}
              />
            </RuleRow>
          </>
        )}
      </RuleGroup>
    </Section>
  )
}


function PoursSection({ project }: { project: Project }) {
  useFillTick((s) => s.tick)
  const conn = getConnectivity(project)
  const fills = getLiveAnalysis(project).zoneFills
  const named = conn.nets.filter((n) => n.pins.length > 0 && !n.name.startsWith("Net-")).map((n) => n.name)
  const [net, setNet] = useState("")
  const [layer, setLayer] = useState<CopperLayer>("bottom")
  const chosen = named.includes(net) ? net : (named.find((n) => n === "GND") ?? named[0] ?? "")
  const exists = project.zones.some((z) => isWholeBoardPour(z) && z.net === chosen && z.layer === layer)
  const [pitch, setPitch] = useState(() => String(stitchPitch(project.board)))
  const unit = useLengthUnit()
  // Stitching needs the same net poured on both layers.
  const whole = project.zones.filter(isWholeBoardPour)
  const stitchable = [...new Set(whole.map((z) => z.net))].filter((n) => (["top", "bottom"] as const).every((l) => whole.some((z) => z.net === n && z.layer === l)))
  return (
    <Section title="Copper pours" id="pours">
      {project.zones.length === 0 ? (
        <p className="text-[12.5px] text-ink-2">Fill unused copper with a net, usually GND, to shield signals and save routing.</p>
      ) : (
        <ul className="-mx-1.5">
          {project.zones.map((z) => {
            const fill = fills.find((f) => f.zoneId === z.id)
            const empty = !fill || fill.polygons.length === 0
            return (
              <li key={z.id} className="flex items-center justify-between rounded-[6px] px-1.5 py-0.5 hover:bg-chrome">
                <span className={`text-[12.5px] ${z.outline ? "cursor-pointer" : ""}`} onClick={z.outline ? () => uiApi().select([`z:${z.id}`]) : undefined}>
                  <span className="mono text-ink">{z.keepout ? (z.placement ? "Placement area" : "Keepout") : isOtherZone(z) ? "Zone" : z.net || "No net"}</span>
                  {z.name && <span className="text-ink-2"> {z.name}</span>}
                  <span className="text-ink-2"> on {[...zoneLayers(z).map((l) => layerLabel(project.board, l)), ...zoneOtherLayers(z).map((n) => shapeLayerInfo(n)?.label ?? n)].map((s) => s.toLowerCase()).join(" and ")}</span>
                  {z.outline && <span className="text-ink-3">, {z.keepout ? (z.placement ? `holds ${placementWords(z.placement)}${z.placement.off ? " (off)" : ""}` : "") + (keepoutFlags(z).length || !z.placement ? `${z.placement ? "; " : ""}keeps out ` + (keepoutFlags(z).map((f) => (f === "footprints" ? "parts" : f)).join(", ") || "nothing") : "") : "polygon"}</span>}
                  {z.clearance !== undefined && <span className="text-ink-3">, {formatLength(zoneClearance(project, z.clearance), unit, true)} gap</span>}
                  {empty && !z.keepout && !isOtherZone(z) && <span className="text-warn"> (no copper to fill)</span>}
                </span>
                <IconButton
                  label={`Remove ${z.net} pour on ${z.layer}`}
                  onClick={() => commitProject((p) => ({ ...p, zones: p.zones.filter((x) => x.id !== z.id) }))}
                >
                  <Trash2 size={14} />
                </IconButton>
              </li>
            )
          })}
        </ul>
      )}
      {named.length > 0 && (
        <div className="flex items-center gap-1.5">
          <select aria-label="Pour net" className="field mono h-8 min-w-0 flex-1" value={chosen} onChange={(e) => setNet(e.target.value)}>
            {named.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <select aria-label="Pour layer" className="field h-8 w-[96px]" value={layer} onChange={(e) => setLayer(e.target.value as CopperLayer)}>
            {copperLayers(project.board).map((l) => (
              <option key={l} value={l}>
                {layerLabel(project.board, l)}
              </option>
            ))}
          </select>
          <Button
            disabled={!chosen || exists}
            onClick={() => commitProject((p) => ({ ...p, zones: [...p.zones, { id: uid("z"), net: chosen, layer }] }))}
            className="px-2"
          >
            <Plus size={14} /> Add
          </Button>
        </div>
      )}
      {stitchable.map((n) => {
        const count = stitchCount(project, n)
        return (
          <div key={n} className="space-y-1.5 pt-1">
            <div className="flex items-center justify-between">
              <span className="text-[12.5px] text-ink-2">
                <span className="mono text-ink">{n}</span> stitching{count ? `: ${count} vias` : " is off"}
              </span>
              {count > 0 && (
                <IconButton label={`Remove ${n} stitching vias`} onClick={() => projectApi().commit((p) => removeStitching(p, n))}>
                  <Trash2 size={14} />
                </IconButton>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <Segmented
                size="sm"
                value={pitch}
                onChange={setPitch}
                options={STITCH_PITCHES.map(String).map((v) => ({ value: v, label: `${v} mm`, title: `One via every ${v} mm` }))}
              />
              <Button onClick={() => projectApi().commit((p) => stitchVias(p, n, Number(pitch)).project)} className="flex-1 px-2">
                {count ? "Restitch" : "Stitch layers"}
              </Button>
            </div>
          </div>
        )
      })}
    </Section>
  )
}

function NetsSection({ project }: { project: Project }) {
  const conn = getConnectivity(project)
  const highlightNet = useUi((s) => s.highlightNet)
  const unit = useLengthUnit()
  const nets = conn.nets.filter((n) => n.pins.length > 0)
  const highlighted = nets.find((n) => n.id === highlightNet)
  return (
    <Section title="Nets" id="nets" action={nets.length > 0 && <span className="text-[12px] text-ink-3">{nets.length}</span>}>
      {nets.length === 0 ? (
        <p className="text-[12.5px] text-ink-2">Wire pins together in the schematic to create nets.</p>
      ) : (
        <ul className="-mx-1.5 max-h-[280px] overflow-y-auto scroll-thin">
          {nets.map((n) => (
            <li key={n.id}>
              <button
                onClick={() => uiApi().setHighlightNet(highlightNet === n.id ? null : n.id)}
                className={`flex w-full items-center justify-between rounded-[6px] px-1.5 py-1 text-left text-[12.5px] ${highlightNet === n.id ? "bg-select-soft" : "hover:bg-chrome"}`}
              >
                <span className="mono truncate text-ink">{n.name}</span>
                <span className="flex items-center gap-2 text-ink-3">
                  {hasNetClasses(project.rules) && classIndex(project.rules).classOf(n.name) && <span className="text-[11.5px]">{classNameOf(project.rules, n.name)}</span>}
                  {project.rules.netWidths?.[n.name] !== undefined && <span className="mono">{formatLength(project.rules.netWidths[n.name], unit, true)}</span>}
                  {n.pins.length}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {highlighted && <NetClassField project={project} net={highlighted.name} />}
      {highlighted && <NetWidthField project={project} net={highlighted.name} />}
      {highlighted?.named && !isMadeUpName(bareName(highlighted)) && (
        <NetStyleField project={project} net={bareName(highlighted)} ports={highlighted.label?.kind !== "local" && highlighted.label?.kind !== "hierarchical"} />
      )}
    </Section>
  )
}

/**
 * How Tidy draws one named net: by its own judgement, or always with labels, or always with ports. A net a local or
 * hierarchical label names is never drawn with ports (a port would name it on every sheet), so it isn't offered.
 */
function NetStyleField({ project, net, ports }: { project: Project; net: string; ports: boolean }) {
  const style = project.netStyles?.[net] ?? "auto"
  return (
    <Field label={`${net} on the schematic`} hint="How Tidy draws it. Auto draws supplies and ground with ports and the rest with labels.">
      <Segmented<NetStyle | "auto">
        size="sm"
        value={style}
        onChange={(v) => commitProject((p) => setNetStyle(p, net, v === "auto" ? null : v))}
        options={[
          { value: "auto", label: "Auto" },
          { value: "label", label: "Labels", title: "Net labels, even for a supply" },
          ...(ports ? [{ value: "port" as const, label: "Ports", title: "Power or ground ports" }] : []),
        ]}
      />
    </Field>
  )
}

/** Trace width for one net; empty means the design-rule width. */
function NetWidthField({ project, net }: { project: Project; net: string }) {
  const unit = useLengthUnit()
  const own = project.rules.netWidths?.[net]
  const classed = hasNetClasses(project.rules) && classIndex(project.rules).classOf(net)?.traceWidth !== undefined
  const fallback = classed ? `the width of its net class, ${formatLength(netTraceWidth({ ...project.rules, netWidths: undefined }, net), unit, true)}` : `the default ${formatLength(project.rules.traceWidth, unit, true)}`
  const set = (mm: number | null) =>
    commitProject((p) => {
      const { [net]: _, ...rest } = p.rules.netWidths ?? {}
      const netWidths = mm === null ? rest : { ...rest, [net]: Math.max(p.rules.minTraceWidth, mm) }
      return { ...p, rules: { ...p.rules, netWidths } }
    })
  return (
    <Field label={`Trace width for ${net}`} hint={`Empty uses ${fallback}. Applies to new traces and the autorouter.`}>
      <LengthInput optional value={own ?? null} placeholder={formatLength(netTraceWidth({ ...project.rules, netWidths: undefined }, net), unit)} onCommit={set} />
    </Field>
  )
}
