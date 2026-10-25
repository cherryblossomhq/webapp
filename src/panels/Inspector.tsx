import { CircuitBoard, Eye, EyeOff, FlipHorizontal2, FlipVertical2, Group, MousePointer2, Plus, RotateCw, Spline, Trash2, Ungroup } from "lucide-react"
import { useState } from "react"
import { groupSelected, ungroupSelected } from "../editor/schematic/blockActions"
import type { Box } from "../lib/geometry"
import { addToBlock, blockOf, createBlock, nextBlockName, removeFromBlocks, renameBlock } from "../model/blocks"
import { pinKey } from "../model/connectivity"
import { isValidFootprint } from "../model/footprints"
import { findPart } from "../model/library"
import { isPhysical, pcbCourtyard, pcbPads, schematicBounds, schematicPins } from "../model/instances"
import { clearImportedNoConnect, importedNoConnectCount } from "../model/importMarks"
import { cleanFlags, setFlags } from "../model/partFlags"
import { removeItems, updateComponent } from "../model/ops"
import { partSourceLine } from "../model/partSource"
import { addUnit, mirrorSelection, renameReference, rotateSelection, setFieldPlace, setSymbolVariant } from "../model/schematicEdit"
import { bodyStyleCount, fieldPlaceOf, hasFieldPlaces, unitCount, unitLetters } from "../model/symbolDrawing"
import { formatLength } from "../model/rules"
import type { ComponentInstance, CopperLayer, PartFlags, Project, Rotation, SchematicBlock, Trace, Vec2, Via } from "../model/types"
import { getConnectivity, getPcbAnalysis } from "../store/analysis"
import { projectApi, useProjectStore } from "../store/projectStore"
import { selectionIds, uiApi, useUi } from "../store/uiStore"
import { Button, Field } from "../ui/controls"
import { Tooltip } from "../ui/Tooltip"
import { CommitInput, LengthInput, Row, Section, Switch, useLengthUnit } from "../ui/form"
import { DrawingInspector } from "./DrawingInspector"
import { ModelSection } from "./ModelSection"
import { ProjectInspector } from "./ProjectInspector"

export function Inspector() {
  const project = useProjectStore((s) => s.project)!
  const selection = useUi((s) => s.selection)
  const view = useUi((s) => s.view)
  const comps = selectionIds(selection, "c")
  const wires = selectionIds(selection, "w")
  const labels = selectionIds(selection, "l")
  const traces = selectionIds(selection, "t")
  const vias = selectionIds(selection, "v")
  const blocks = selectionIds(selection, "b")
  const drawn = selectionIds(selection, "d")

  if (drawn.length && drawn.length === selection.length) {
    const list = drawn.flatMap((id) => project.drawings?.find((d) => d.id === id) ?? [])
    if (list.length) return <DrawingInspector drawings={list} />
  }
  if (selection.length === 1 && blocks.length === 1) {
    const b = project.blocks?.find((x) => x.id === blocks[0])
    if (b) return <BlockInspector block={b} project={project} />
  }
  if (selection.length === 1 && comps.length === 1) {
    const c = project.components.find((x) => x.id === comps[0])
    if (c) return <ComponentInspector c={c} project={project} />
  }
  if (selection.length === 1 && labels.length === 1) {
    const l = project.labels.find((x) => x.id === labels[0])
    if (l)
      return (
        <Section title="Net label">
          <Field label="Name">
            <CommitInput
              mono
              value={l.name}
              onCommit={(v) => {
                const name = v.trim().toUpperCase().replace(/\s+/g, "_")
                if (name) projectApi().commit((p) => ({ ...p, labels: p.labels.map((x) => (x.id === l.id ? { ...x, name } : x)) }))
              }}
            />
          </Field>
          <p className="text-[12px] text-ink-2">Every label with the same name is the same net.</p>
        </Section>
      )
  }
  if (selection.length === 1 && traces.length === 1) {
    const t = project.traces.find((x) => x.id === traces[0])
    if (t) {
      const netId = getPcbAnalysis(project).traceNet.get(t.id)
      const net = getConnectivity(project).nets.find((n) => n.id === netId)
      return <TraceInspector trace={t} net={netId === "short" ? "Short circuit" : (net?.name ?? "Not connected")} project={project} />
    }
  }
  if (selection.length === 1 && vias.length === 1) {
    const v = project.vias.find((x) => x.id === vias[0])
    if (v) {
      const netId = getPcbAnalysis(project).viaNet.get(v.id)
      const net = getConnectivity(project).nets.find((n) => n.id === netId)
      return <ViaInspector via={v} net={netId === "short" ? "Short circuit" : (net?.name ?? "Not connected")} project={project} />
    }
  }
  if (selection.length > 0) {

    const counts = [
      [comps.length, "part"],
      [wires.length, "wire"],
      [labels.length, "label"],
      [blocks.length, "block"],
      [drawn.length, "drawing"],
      [traces.length, "trace"],
      [vias.length, "via"],
    ].filter(([n]) => n) as [number, string][]
    // Blocks are drawn on the schematic, so they are only grouped there.
    const schematic = view === "schematic"
    const grouped = comps.some((id) => blockOf(project, id))
    return (
      <Section title={`${selection.length} selected`}>
        <p className="text-[13px] text-ink-2">{counts.map(([n, w]) => `${n} ${w}${n === 1 ? "" : "s"}`).join(", ")}</p>
        <div className="flex flex-wrap gap-1.5">
          {schematic && (comps.length > 0 || blocks.length > 0) && (
            <Button onClick={groupSelected} title={blocks.length ? "The parts join the first selected block (⌘G)" : "Draw a titled frame around these parts (⌘G)"}>
              <Group size={14} /> {blocks.length ? "Add to block" : "Group as block"}
            </Button>
          )}
          {schematic && (blocks.length > 0 || grouped) && (
            <Button onClick={ungroupSelected} title="Ungroup (⇧⌘G)">
              <Ungroup size={14} /> Ungroup
            </Button>
          )}
          <Button
            variant="danger"
            onClick={() => {
              projectApi().commit((p) => removeItems(p, { components: comps, wires, labels, traces, vias, blocks, drawings: drawn }))
              uiApi().clearSelection()
            }}
          >
            <Trash2 size={14} /> Delete selection
          </Button>
        </div>
      </Section>
    )
  }
  return <ProjectInspector project={project} />
}

function BlockInspector({ block, project }: { block: SchematicBlock; project: Project }) {
  // Power and ground ports are in a block like any part, but aren't worth listing.
  const refs = block.components
    .map((id) => project.components.find((c) => c.id === id)?.ref)
    .filter((ref): ref is string => !!ref && !ref.startsWith("#"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  return (
    <Section title="Block">
      <Field label="Name">
        <CommitInput value={block.name} onCommit={(v) => projectApi().commit((p) => renameBlock(p, block.id, v))} />
      </Field>
      <Row label="Parts" value={refs.length} />
      {refs.length > 0 && <p className="mono text-[12.5px] leading-relaxed text-ink">{refs.join(", ")}</p>}
      <div className="flex flex-wrap gap-1.5">
        <Button onClick={() => uiApi().select(block.components.map((id) => `c:${id}`))}>
          <MousePointer2 size={14} /> Select parts
        </Button>
        <Button onClick={ungroupSelected} title="The frame goes; the parts stay where they are (⇧⌘G)">
          <Ungroup size={14} /> Ungroup
        </Button>
      </div>
      <p className="text-[12px] text-ink-2">Drag the title to move the block. Its frame follows its parts.</p>
    </Section>
  )
}

const setTrace = (id: string, patch: Partial<Trace>) =>
  projectApi().commit((p) => ({ ...p, updatedAt: Date.now(), traces: p.traces.map((x) => (x.id === id ? { ...x, ...patch } : x)) }))

function TraceInspector({ trace: t, net, project }: { trace: Trace; net: string; project: Project }) {
  const unit = useLengthUnit()
  const { minTraceWidth, preferredWidths } = project.rules
  const length = t.points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - t.points[i].x, p.y - t.points[i].y), 0)
  return (
    <Section title="Trace">
      <Row label="Net" value={net} mono />
      {t.net && net === "Short circuit" && <p className="text-[12px] text-danger">This trace is on {t.net}, but it touches copper of another net. Checks lists the short.</p>}
      {t.net && net !== "Short circuit" && net !== t.net && <p className="text-[12px] text-ink-2">The board it came from puts this trace on {t.net}.</p>}
      <Row label="Length" value={formatLength(length, unit, true)} />
      <Field label="Width">
        <LengthInput min={0.05} value={t.width} onCommit={(v) => v !== null && setTrace(t.id, { width: v })} />
      </Field>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Preferred widths">
        {preferredWidths.map((w) => (
          <button
            key={w}
            type="button"
            aria-pressed={Math.abs(w - t.width) < 1e-6}
            onClick={() => setTrace(t.id, { width: w })}
            className={`mono h-6 rounded-full border px-2 text-[11.5px] transition-colors ${Math.abs(w - t.width) < 1e-6 ? "border-select bg-select-soft text-ink" : "border-line text-ink-2 hover:border-ink-3 hover:text-ink"}`}
          >
            {formatLength(w, unit)}
          </button>
        ))}
      </div>
      {t.width < minTraceWidth - 1e-6 && <p className="text-[12px] text-danger">Narrower than the {formatLength(minTraceWidth, unit, true)} minimum in the design rules.</p>}
      <Field label="Layer">
        <select className="field h-8" value={t.layer} onChange={(e) => setTrace(t.id, { layer: e.target.value as CopperLayer })}>
          <option value="top">Top copper</option>
          <option value="bottom">Bottom copper</option>
        </select>
      </Field>
      <div className="flex items-center justify-between">
        <span className="text-[12.5px] text-ink-2" title="A locked trace is kept when the board is routed again">
          Locked
        </span>
        <Switch label="Lock trace" checked={!!t.locked} onChange={(locked) => setTrace(t.id, { locked: locked || undefined })} />
      </div>
      {t.net && (
        <Button
          onClick={() => projectApi().commit((p) => ({ ...p, updatedAt: Date.now(), traces: p.traces.map((x) => { if (x.id !== t.id) return x; const { net: _n, ...rest } = x; return rest }) }))}
          title="Forget the net the board it came from put this trace on: its net is then the one it touches"
        >
          Use the net it touches
        </Button>
      )}
    </Section>
  )
}

/** A via with no net of its own: the one it touches. */
const commitVia = (id: string) =>
  projectApi().commit((p) => ({ ...p, updatedAt: Date.now(), vias: p.vias.map((x) => { if (x.id !== id) return x; const { routedNet: _n, ...rest } = x; return rest }) }))

const setVia = (id: string, patch: Partial<Via>) =>
  projectApi().commit((p) => ({ ...p, updatedAt: Date.now(), vias: p.vias.map((x) => (x.id === id ? { ...x, ...patch } : x)) }))

function ViaInspector({ via: v, net, project }: { via: Via; net: string; project: Project }) {
  const { minAnnularRing } = project.rules
  const minDrill = project.rules.minViaDrill ?? project.rules.minDrill
  const ring = (v.diameter - v.drill) / 2
  return (
    <Section title="Via">
      <Row label="Net" value={v.net ? `${v.net} (stitching)` : net} mono />
      {v.routedNet && net === "Short circuit" && <p className="text-[12px] text-danger">This via is on {v.routedNet}, but it touches copper of another net. Checks lists the short.</p>}
      {v.routedNet && net !== "Short circuit" && net !== v.routedNet && <p className="text-[12px] text-ink-2">The board it came from puts this via on {v.routedNet}.</p>}
      <div className="grid grid-cols-2 gap-2">
        <Field label="Diameter">
          <LengthInput min={0.1} value={v.diameter} onCommit={(d) => d !== null && setVia(v.id, { diameter: d })} />
        </Field>
        <Field label="Drill">
          <LengthInput min={0.05} value={v.drill} onCommit={(d) => d !== null && setVia(v.id, { drill: d })} />
        </Field>
      </div>
      {v.drill < minDrill - 1e-6 && <p className="text-[12px] text-danger">Drill is under the design rules' minimum.</p>}
      {ring < minAnnularRing - 1e-6 && <p className="text-[12px] text-danger">The copper ring is under the design rules' minimum.</p>}
      <div className="flex items-center justify-between">
        <span className="text-[12.5px] text-ink-2" title="A locked via is kept when the board is routed again">
          Locked
        </span>
        <Switch label="Lock via" checked={!!v.locked} onChange={(locked) => setVia(v.id, { locked: locked || undefined })} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {v.routedNet && (
          <Button onClick={() => commitVia(v.id)} title="Forget the net the board it came from put this via on: its net is then the one it touches">
            Use the net it touches
          </Button>
        )}
        <Button
          variant="danger"
          onClick={() => {
            projectApi().commit((p) => removeItems(p, { vias: [v.id] }))
            uiApi().clearSelection()
          }}
        >
          <Trash2 size={14} /> Delete selection
        </Button>
      </div>
    </Section>
  )
}

/** The flags a part can have in the Assembly section: the switch's label, what it does, and its key. */
const FLAG_SWITCHES: { key: Exclude<keyof PartFlags, "mount" | "netTies" | "jumperGroups">; label: string; hint: string }[] = [
  { key: "dnp", label: "Do not populate", hint: "Left out of the BOM and the position file (KiCad keeps it in both); its solder paste is still plotted" },
  { key: "excludeFromBom", label: "Not in the BOM", hint: "Left out of the bill of materials" },
  { key: "excludeFromPos", label: "Not in the position file", hint: "Left out of the pick and place file" },
  { key: "boardOnly", label: "Board only", hint: "Has no schematic symbol in KiCad; it stays in the BOM unless it is also not in the BOM" },
  { key: "virtual", label: "Virtual", hint: "A board feature, not a part to buy or place: left out of the BOM and the position file" },
  { key: "allowMissingCourtyard", label: "Missing courtyard allowed", hint: "KiCad's allow missing courtyard" },
  { key: "allowMaskBridges", label: "Mask bridges allowed", hint: "KiCad's allow solder mask bridges between this part's pads" },
]

const groupText = (groups: string[][] | undefined) => (groups ?? []).map((g) => g.join(",")).join("; ")

/** A footprint's KiCad attributes and net ties: what they do, and a way to change them. */
function AssemblySection({ c }: { c: ComponentInstance }) {
  const flags = c.flags
  const set = (patch: Parameters<typeof setFlags>[2]) => projectApi().commit((p) => setFlags(p, c.id, patch))
  const pads = new Set(pcbPads(c).flatMap((p) => (p.padNumber ? [p.padNumber] : [])))
  // "1,2; 3,4": groups of pad numbers, keeping the pads the footprint has.
  const parseGroups = (text: string) => cleanFlags({ netTies: text.split(";").map((g) => g.split(",").map((x) => x.trim()).filter((x) => pads.has(x))) })?.netTies
  return (
    <Section title="Assembly" id="assembly">
      <Field label="Mounting">
        <select className="field h-8" value={flags?.mount ?? ""} onChange={(e) => set({ mount: e.target.value === "smd" || e.target.value === "through_hole" ? e.target.value : false })} aria-label="Mounting">
          <option value="">Not set</option>
          <option value="smd">Surface mount</option>
          <option value="through_hole">Through-hole</option>
        </select>
      </Field>
      {FLAG_SWITCHES.map((f) => (
        <div key={f.key} className="flex items-center justify-between gap-3">
          <span className="text-[12.5px] text-ink-2" title={f.hint}>
            {f.label}
          </span>
          <Switch label={f.label} checked={!!flags?.[f.key]} onChange={(on) => set({ [f.key]: on || false })} />
        </div>
      ))}
      <Field label="Net tie pads">
        <CommitInput mono placeholder="e.g. 1,2; 3,4" value={groupText(flags?.netTies)} onCommit={(v) => set({ netTies: parseGroups(v) ?? false })} ariaLabel="Net tie pads" />
      </Field>
      <p className="text-[12px] text-ink-2">Pads of one group may be on different nets, and copper of those nets may touch them, without Checks calling it a short.</p>
      {flags?.jumperGroups?.length ? <Row label="Jumper pads" value={groupText(flags.jumperGroups)} mono /> : null}
      {flags?.jumperDuplicates ? <p className="text-[12px] text-ink-2">Pads that share a number are jumpers.</p> : null}
    </Section>
  )
}

/** The block picker's choice that puts a part in a block of its own. */
const NEW_BLOCK = "__new"

/** Where a project part's pins and land came from, with the credit its data asks for. */
function PartSourceLine({ spec }: { spec: Parameters<typeof partSourceLine>[0] }) {
  const line = partSourceLine(spec)
  if (!line) return null
  return (
    <p className="-mt-0.5 text-[11.5px] leading-snug text-ink-3" title={line.credit}>
      <span className="font-[600] text-ink-2">{line.label}</span>
      {line.detail ? `. ${line.detail}` : ""}
      {line.credit && <span className="mt-0.5 block text-[10.5px]">{line.credit}</span>}
    </p>
  )
}

function ComponentInspector({ c, project }: { c: ComponentInstance; project: Project }) {
  const part = findPart(c.partId)
  const conn = getConnectivity(project)
  const view = useUi((s) => s.view)
  const [customFp, setCustomFp] = useState("")
  const [fpError, setFpError] = useState(false)
  if (!part) return <Section title="Unknown part">This part isn't in the library.</Section>
  const physical = isPhysical(part)
  const update = (patch: Parameters<typeof updateComponent>[2]) => projectApi().commit((p) => updateComponent(p, c.id, patch))
  // The same turn as the R key: labels and wires follow the pins, or it is refused and says why.
  const turnSymbol = (id: string) => {
    uiApi().clearNotice()
    const res = rotateSelection(projectApi().project!, { components: [id], labels: [] }, { conn: getConnectivity })
    if (res.ok) {
      projectApi().commit(() => res.project)
      if (res.note) uiApi().showNotice(res.note)
    } else uiApi().showNotice(res.message)
  }
  const mirror = (axis: "x" | "y") => {
    uiApi().clearNotice()
    const res = mirrorSelection(projectApi().project!, { components: [c.id] }, axis, { conn: getConnectivity })
    if (res.ok) projectApi().commit(() => res.project)
    else uiApi().showNotice(res.message)
  }
  const setFunction = (pin: string, alternate: string | null) => {
    uiApi().clearNotice()
    const res = setSymbolVariant(projectApi().project!, c.id, { pinAlt: { pin, alternate } }, { conn: getConnectivity })
    if (res.ok) projectApi().commit(() => res.project)
    else uiApi().showNotice(res.message)
  }
  const pins = schematicPins(c, part)
  const isPower = !!part.powerNet
  const setNc = (pin: string, on: boolean) =>
    projectApi().commit((p) => ({
      ...p,
      updatedAt: Date.now(),
      components: p.components.map((x) => {
        if (x.id !== c.id) return x
        const nc = new Set(x.nc ?? [])
        if (on) nc.add(pin)
        else nc.delete(pin)
        return { ...x, nc: nc.size ? [...nc].sort((a, b) => Number(a) - Number(b)) : undefined }
      }),
    }))
  const setBlock = (value: string) =>
    projectApi().commit((p) =>
      value === NEW_BLOCK ? createBlock(p, nextBlockName(p), [c.id]).project : value ? addToBlock(p, value, [c.id]) : removeFromBlocks(p, [c.id]),
    )
  // Focus first: a change of view drops the selection, so select the part again after it.
  const focusOn = (target: "schematic" | "pcb", at: Vec2, box?: Box) => {
    uiApi().focus(target, at.x, at.y, box)
    uiApi().select([`c:${c.id}`])
  }

  return (
    <div>
      <Section
        title={part.name}
        action={
          <Tooltip label="Delete part" shortcut="Del">
            <button
              className="rounded p-1 text-ink-3 hover:bg-danger-soft hover:text-danger"
              aria-label={`Delete ${c.ref}`}
              onClick={() => {
                projectApi().commit((p) => removeItems(p, { components: [c.id] }))
                uiApi().clearSelection()
              }}
            >
              <Trash2 size={14} />
            </button>
          </Tooltip>
        }
      >
        <p className="-mt-1 text-[12px] text-ink-2">{part.description}</p>
        <PartSourceLine spec={project.parts?.find((s) => s.id === c.partId)} />
        {!isPower && (
          <Field label="Designator">
            <CommitInput
              mono
              value={c.ref}
              onCommit={(v) => {
                const ref = v.trim()
                // The units of one part share its designator, so they are not another part that has it.
                const mine = (x: ComponentInstance) => unitCount(part) > 1 && x.ref === c.ref && !!findPart(x.partId)?.units
                if (ref && !project.components.some((x) => x.ref === ref && x.id !== c.id && !mine(x))) projectApi().commit((p) => renameReference(p, c.id, ref))
              }}
            />
          </Field>
        )}
        {Object.entries(c.props).map(([key, value]) => (
          <Field key={key} label={propLabel(key)}>
            <CommitInput
              mono={key === "net" || key === "mpn"}
              value={value}
              onCommit={(v) => update({ props: { ...c.props, [key]: key === "net" ? v.trim().toUpperCase() : v.trim() } })}
            />
          </Field>
        ))}
        {view === "schematic" && (
          <Field label="Block">
            <select className="field h-8" value={blockOf(project, c.id)?.id ?? ""} onChange={(e) => setBlock(e.target.value)}>
              <option value="">None</option>
              {(project.blocks ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
              <option value={NEW_BLOCK}>New block</option>
            </select>
          </Field>
        )}
      </Section>

      {physical && (
        <Section title="Footprint">
          <select
            className="field mono h-8"
            value={part.footprints.includes(c.footprint) ? c.footprint : "__custom"}
            onChange={(e) => {
              if (e.target.value !== "__custom") update({ footprint: e.target.value })
            }}
            aria-label="Footprint"
          >
            {part.footprints.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
            {!part.footprints.includes(c.footprint) && <option value="__custom">{c.footprint}</option>}
          </select>
          <form
            className="flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault()
              const f = customFp.trim()
              if (!isValidFootprint(f)) {
                setFpError(true)
                return
              }
              setFpError(false)
              setCustomFp("")
              update({ footprint: f })
            }}
          >
            <input
              className="field mono h-8"
              placeholder="Custom, e.g. soic8 or pinrow5"
              value={customFp}
              onChange={(e) => {
                setCustomFp(e.target.value)
                setFpError(false)
              }}
              aria-label="Custom footprint"
            />
            <Button type="submit" disabled={!customFp.trim()}>
              Use
            </Button>
          </form>
          {fpError && <p className="text-[12px] text-danger">Footprinter can't build that footprint. Check the name and pin count.</p>}
        </Section>
      )}

      {physical && <AssemblySection c={c} />}

      {/* Keyed so a search, a problem or a busy button doesn't carry over to the next part selected. */}
      {physical && <ModelSection key={c.id} c={c} part={part} project={project} />}

      {view === "schematic" && (unitCount(part) > 1 || bodyStyleCount(part) > 1 || hasFieldPlaces(part)) && (
        <SymbolSection c={c} part={part} project={project} />
      )}

      <Section title="Placement">
        <div className="flex flex-wrap gap-1.5">
          <Button onClick={() => turnSymbol(c.id)}>
            <RotateCw size={14} /> Rotate symbol
          </Button>
          <Tooltip label="Flip top to bottom" shortcut="X">
            <Button onClick={() => mirror("x")} aria-label="Mirror top to bottom">
              <FlipVertical2 size={14} />
            </Button>
          </Tooltip>
          <Tooltip label="Flip left to right" shortcut="Y">
            <Button onClick={() => mirror("y")} aria-label="Mirror left to right">
              <FlipHorizontal2 size={14} />
            </Button>
          </Tooltip>
          <Button onClick={() => focusOn("schematic", c.sch, schematicBounds(c, part))}>
            <Spline size={14} /> Schematic
          </Button>
          {physical && (
            <Button onClick={() => focusOn("pcb", c.pcb, pcbCourtyard(c) ?? undefined)} disabled={!c.pcb.placed}>
              <CircuitBoard size={14} /> PCB
            </Button>
          )}
        </div>
        {physical && c.pcb.placed && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Field label="PCB X">
                <LengthInput min={-1e4} value={c.pcb.x} onCommit={(v) => v !== null && update({ pcb: { x: v } })} />
              </Field>
              <Field label="PCB Y">
                <LengthInput min={-1e4} value={c.pcb.y} onCommit={(v) => v !== null && update({ pcb: { y: v } })} />
              </Field>
            </div>
            <div className="flex gap-1.5">
              <Button disabled={!!c.pcb.locked} title={c.pcb.locked ? "Locked: turn off Locked below to rotate" : undefined} onClick={() => update({ pcb: { rot: (((c.pcb.rot + 90) % 360) as Rotation) } })}>
                <RotateCw size={14} /> {c.pcb.rot}°
              </Button>
              <Button disabled={!!c.pcb.locked} title={c.pcb.locked ? "Locked: turn off Locked below to flip" : undefined} onClick={() => update({ pcb: { side: c.pcb.side === "top" ? "bottom" : "top" } })}>
                <FlipHorizontal2 size={14} /> {c.pcb.side === "top" ? "Top side" : "Bottom side"}
              </Button>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[12.5px] text-ink-2" title="A locked part stays where it is when parts are placed automatically or the board is re-packed">
                Locked
              </span>
              <Switch label="Lock position" checked={!!c.pcb.locked} onChange={(locked) => update({ pcb: { locked: locked || undefined } })} />
            </div>
          </>
        )}
      </Section>

      {!isPower && (
        <Section
          title="Pins"
          action={
            importedNoConnectCount(project, c.id) > 0 && (
              <Tooltip label="Check imported no-connect pins" hint="The pins the KiCad import marked no connect, because the file puts no net on them, go back to being checked">
                <button className="text-[12px] text-ink-2 hover:text-ink hover:underline" onClick={() => projectApi().commit((p) => clearImportedNoConnect(p, [c.id]))}>
                  Check imported no-connect pins
                </button>
              </Tooltip>
            )
          }
        >
          <table className="w-full text-[12.5px]">
            <tbody>
              {pins
                .slice()
                .sort((a, b) => Number(a.pin) - Number(b.pin))
                .map((pin) => {
                  const netId = conn.pinNet.get(pinKey(c.id, pin.pin))
                  const net = conn.nets.find((n) => n.id === netId)
                  return (
                    <tr key={pin.pin} className="border-b border-chrome-2 last:border-0">
                      <td className="mono w-8 py-1 text-ink-3">{pin.pin}</td>
                      <td className="mono py-1 text-ink">
                        {part.pins.find((q) => q.number === pin.pin)?.alternates?.length ? (
                          <select className="field mono h-7" value={c.pinAlt?.[pin.pin] ?? ""} aria-label={`Function of pin ${pin.pin}`} onChange={(e) => setFunction(pin.pin, e.target.value || null)}>
                            <option value="">{part.pins.find((q) => q.number === pin.pin)?.name}</option>
                            {part.pins.find((q) => q.number === pin.pin)?.alternates?.map((a) => (
                              <option key={a.name} value={a.name}>
                                {a.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          pin.name
                        )}
                        {pin.hidden && <span className="ml-1 text-[11px] text-ink-3" title="Not drawn: a hidden power pin is on the net of its name">hidden</span>}
                      </td>
                      <td className="py-1 text-right">
                        {net ? (
                          <button className="mono text-brand hover:underline" onClick={() => uiApi().setHighlightNet(useUi.getState().highlightNet === net.id ? null : net.id)}>
                            {net.name}
                          </button>
                        ) : c.nc?.includes(pin.pin) ? (
                          <Tooltip label="Clear the no-connect flag">
                            <button className="text-ink-2 hover:text-ink hover:underline" onClick={() => setNc(pin.pin, false)}>
                              No connect
                            </button>
                          </Tooltip>
                        ) : (
                          <Tooltip label="Mark as unused on purpose" hint="Checks then skip this pin">
                            <button className="text-ink-3 hover:text-ink hover:underline" onClick={() => setNc(pin.pin, true)}>
                              Not connected
                            </button>
                          </Tooltip>
                        )}
                      </td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
        </Section>
      )}
    </div>
  )
}

/** Unit, body style and fields of a symbol that has them: what KiCad's symbols add to a part. */
function SymbolSection({ c, part, project }: { c: ComponentInstance; part: NonNullable<ReturnType<typeof findPart>>; project: Project }) {
  const units = unitCount(part)
  const styles = bodyStyleCount(part)
  const change = (patch: { unit?: number; bodyStyle?: number }) => {
    uiApi().clearNotice()
    const res = setSymbolVariant(projectApi().project!, c.id, patch, { conn: getConnectivity })
    if (res.ok) projectApi().commit(() => res.project)
    else uiApi().showNotice(res.message)
  }
  const names = part.units
  const placed = new Set(project.components.filter((x) => x.ref === c.ref && !!findPart(x.partId)?.units).map((x) => x.unit ?? 1))
  const missing = Array.from({ length: units }, (_, i) => i + 1).filter((u) => !placed.has(u))
  const fieldNames = [...new Set([...Object.keys(part.fieldPlaces ?? {}), ...Object.keys(c.fields ?? {})])]
  const place = (name: string) => fieldPlaceOf(c, part, name)
  const put = (name: string, patch: Parameters<typeof setFieldPlace>[3]) => projectApi().commit((p) => setFieldPlace(p, c.id, name, patch))
  return (
    <Section title="Symbol">
      {units > 1 && (
        <Field label="Unit">
          <select className="field h-8" value={c.unit ?? 1} onChange={(e) => change({ unit: Number(e.target.value) })} aria-label="Unit">
            {Array.from({ length: units }, (_, i) => i + 1).map((u) => (
              <option key={u} value={u}>
                {unitLetters(u)}
                {names?.unitNames?.[u] ? `: ${names.unitNames[u]}` : ""}
              </option>
            ))}
          </select>
        </Field>
      )}
      {units > 1 && missing.length > 0 && (
        <Button
          onClick={() => {
            uiApi().clearNotice()
            const b = schematicBounds(c, part)
            const res = addUnit(projectApi().project!, c.id, missing[0], { x: Math.round((b.maxX + 0.6) * 10) / 10, y: c.sch.y }, { conn: getConnectivity })
            if (res.ok) {
              projectApi().commit(() => res.project)
              uiApi().select([`c:${res.component.id}`])
            } else uiApi().showNotice(res.message)
          }}
        >
          <Plus size={14} /> Place unit {unitLetters(missing[0])}
        </Button>
      )}
      {styles > 1 && (
        <Field label="Body style">
          <select className="field h-8" value={c.bodyStyle ?? 1} onChange={(e) => change({ bodyStyle: Number(e.target.value) })} aria-label="Body style">
            {Array.from({ length: styles }, (_, i) => i + 1).map((b) => (
              <option key={b} value={b}>
                {names?.bodyStyleNames?.[b - 1] ?? (b === 1 ? "Normal" : b === 2 ? "Alternate (De Morgan)" : `Style ${b}`)}
              </option>
            ))}
          </select>
        </Field>
      )}
      {fieldNames.length > 0 && (
        <table className="w-full text-[12.5px]">
          <tbody>
            {fieldNames.map((name) => {
              const f = place(name)
              if (!f) return null
              return (
                <tr key={name} className="border-b border-chrome-2 last:border-0">
                  <td className="py-1 text-ink-2">{name}</td>
                  <td className="py-1">
                    <CommitInput mono value={String(f.x)} onCommit={(v) => Number.isFinite(Number(v)) && put(name, { x: Number(v) })} aria-label={`${name} x`} />
                  </td>
                  <td className="py-1">
                    <CommitInput mono value={String(f.y)} onCommit={(v) => Number.isFinite(Number(v)) && put(name, { y: Number(v) })} aria-label={`${name} y`} />
                  </td>
                  <td className="py-1 text-right">
                    <Tooltip label={f.hidden ? "Show on the sheet" : "Hide on the sheet"}>
                      <button className="rounded p-1 text-ink-3 hover:text-ink" aria-label={f.hidden ? `Show ${name}` : `Hide ${name}`} onClick={() => put(name, { hidden: f.hidden ? undefined : true })}>
                        {f.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </Tooltip>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </Section>
  )
}

function propLabel(key: string) {
  const labels: Record<string, string> = {
    resistance: "Resistance",
    capacitance: "Capacitance",
    inductance: "Inductance",
    voltage: "Voltage",
    frequency: "Frequency",
    color: "Colour",
    mpn: "Part number",
    net: "Net name",
  }
  return labels[key] ?? key.charAt(0).toUpperCase() + key.slice(1)
}
