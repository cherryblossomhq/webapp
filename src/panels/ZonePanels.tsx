import { Trash2 } from "lucide-react"
import { areaMm2OfZone, zoneFacts } from "./zoneInspector"
import { getConnectivity, getLiveAnalysis, useFillTick } from "../store/analysis"
import { updateZone, removeZones, type ZonePatch } from "../model/zoneOps"
import { zoneSettings } from "../model/zones"
import { copperLayers, layerLabel } from "../model/stack"
import { formatLength } from "../model/rules"
import type { CopperLayer, Project, Zone, ZoneConnection } from "../model/types"
import { projectApi } from "../store/projectStore"
import { uiApi } from "../store/uiStore"
import { Button, Field } from "../ui/controls"
import { LengthInput, Row, Section, Switch, useLengthUnit } from "../ui/form"

const CONNECTIONS: { value: ZoneConnection; label: string }[] = [
  { value: "thermal", label: "Thermal relief" },
  { value: "tht", label: "Thermal relief on through-hole pads, solid on the rest" },
  { value: "solid", label: "Solid" },
  { value: "none", label: "None" },
]

const KEEPOUTS: { key: keyof NonNullable<Zone["keepout"]>; label: string; hint: string }[] = [
  { key: "tracks", label: "Tracks", hint: "No trace may enter the area" },
  { key: "vias", label: "Vias", hint: "No via may sit in the area" },
  { key: "pads", label: "Pads", hint: "No pad may sit in the area" },
  { key: "pour", label: "Copper pours", hint: "Pours keep out of the area, with no gap" },
  { key: "footprints", label: "Parts", hint: "No part may sit in the area" },
]

/** What is selected on the board when it is a zone: a pour or a keepout of its own shape. */
export function ZoneInspector({ project, zone }: { project: Project; zone: Zone }) {
  const unit = useLengthUnit()
  const set = zoneSettings(project, zone)
  useFillTick((s) => s.tick)
  const analysis = getLiveAnalysis(project)
  const facts = zoneFacts(project, zone, analysis.zoneFills)
  const nets = getConnectivity(project)
    .nets.filter((n) => n.pins.length > 0)
    .map((n) => n.name)
  const patch = (p: ZonePatch) => projectApi().commit((x) => updateZone(x, zone.id, p))
  const layers = zone.layers ?? [zone.layer]
  const toggleLayer = (l: CopperLayer, on: boolean) => {
    const next = copperLayers(project.board).filter((x) => (x === l ? on : layers.includes(x)))
    if (next.length) patch({ layers: next, layer: next[0] })
  }
  const rule = zone.keepout !== undefined
  const fmt = (mm: number) => `${formatLength(mm, unit, true)}`
  const row = (label: string, hint: string, control: React.ReactNode) => (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12.5px] text-ink-2" title={hint}>
        {label}
      </span>
      {control}
    </div>
  )
  return (
    <Section title={rule ? "Keepout" : zone.teardrop ? "Teardrop zone" : "Copper zone"}>
      <Field label="Name">
        <input key={zone.name ?? ""} className="field h-8" aria-label="Zone name" defaultValue={zone.name ?? ""} placeholder="No name" onBlur={(e) => e.target.value !== (zone.name ?? "") && patch({ name: e.target.value || undefined })} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
      </Field>
      {!rule && (
        <Field label="Net">
          <select className="field mono h-8" aria-label="Zone net" value={zone.net} onChange={(e) => patch({ net: e.target.value })}>
            <option value="">No net</option>
            {zone.net && !nets.includes(zone.net) && <option value={zone.net}>{zone.net}</option>}
            {nets.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="flex items-center gap-4">
        {copperLayers(project.board).map((l) => (
          <label key={l} className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
            <input type="checkbox" aria-label={`On the ${l} layer`} checked={layers.includes(l)} onChange={(e) => toggleLayer(l, e.target.checked)} />
            {layerLabel(project.board, l)}
          </label>
        ))}
      </div>
      {rule ? (
        <div className="space-y-1">
          <p className="text-[12.5px] text-ink-2">Keeps out:</p>
          {KEEPOUTS.map((k) =>
            row(
              k.label,
              k.hint,
              <Switch
                label={k.label}
                checked={!!zone.keepout?.[k.key]}
                onChange={(on) => {
                  const next = { ...zone.keepout }
                  if (on) next[k.key] = true
                  else delete next[k.key]
                  patch({ keepout: next })
                }}
              />,
            ),
          )}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Priority">
              <input type="number" min={0} step={1} className="field h-8" aria-label="Priority" key={set.priority} defaultValue={set.priority} onBlur={(e) => patch({ priority: Math.max(0, Math.round(Number(e.target.value) || 0)) || undefined })} />
            </Field>
            <Field label="Gap to other nets">
              <LengthInput min={0} value={set.clearance} ariaLabel="Clearance" onCommit={(v) => v !== null && patch({ clearance: v })} />
            </Field>
            <Field label="Thinnest copper">
              <LengthInput min={0.01} value={set.minWidth} ariaLabel="Minimum width" onCommit={(v) => v !== null && patch({ minWidth: v })} />
            </Field>
            <Field label="Gap to the edge">
              <LengthInput min={0} value={set.edgeGap} ariaLabel="Edge gap" onCommit={(v) => v !== null && patch({ edgeGap: v })} />
            </Field>
          </div>
          <Field label="Pads of its net">
            <select className="field h-8" aria-label="Pad connection" value={set.connect} onChange={(e) => patch({ connect: e.target.value as ZoneConnection })}>
              {CONNECTIONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
          {(set.connect === "thermal" || set.connect === "tht") && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Relief gap">
                <LengthInput min={0} value={set.thermalGap} ariaLabel="Thermal gap" onCommit={(v) => v !== null && patch({ thermalGap: v })} />
              </Field>
              <Field label="Spoke width">
                <LengthInput min={0.01} value={set.spokeWidth} ariaLabel="Spoke width" onCommit={(v) => v !== null && patch({ spokeWidth: v })} />
              </Field>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Field label="Corners">
              <select className="field h-8" aria-label="Corner smoothing" value={zone.smoothing?.kind ?? "none"} onChange={(e) => patch({ smoothing: e.target.value === "none" ? undefined : { kind: e.target.value as "chamfer" | "fillet", radius: zone.smoothing?.radius ?? 1 } })}>
                <option value="none">Square</option>
                <option value="chamfer">Cut off</option>
                <option value="fillet">Rounded</option>
              </select>
            </Field>
            {zone.smoothing && (
              <Field label="By">
                <LengthInput min={0.01} value={zone.smoothing.radius} ariaLabel="Corner size" onCommit={(v) => v !== null && patch({ smoothing: { kind: zone.smoothing!.kind, radius: v } })} />
              </Field>
            )}
          </div>
          <Field label="Copper no net copper touches">
            <select
              className="field h-8"
              aria-label="Islands"
              value={zone.islands === undefined ? "always" : zone.islands === "never" ? "never" : "area"}
              onChange={(e) => patch({ islands: e.target.value === "always" ? undefined : e.target.value === "never" ? "never" : 10 })}
            >
              <option value="always">Removed</option>
              <option value="never">Kept</option>
              <option value="area">Removed when small</option>
            </select>
          </Field>
          {typeof zone.islands === "number" && (
            <Field label="Small means under (mm²)">
              <input type="number" min={0} step={0.5} className="field h-8" aria-label="Island area" key={zone.islands} defaultValue={zone.islands} onBlur={(e) => patch({ islands: Math.max(0, Number(e.target.value) || 0) })} />
            </Field>
          )}
          {zone.teardrop && <Row label="Teardrop" value={zone.teardrop === "padvia" ? "at a pad or via" : "at a track end"} />}
        </>
      )}
      <Row label="Layers" value={layers.map((l) => layerLabel(project.board, l)).join(", ")} />
      <Row label="Corners" value={facts.corners} />
      <Row label="Area" value={`${facts.area.toFixed(1)} mm²`} mono />
      {!rule && <Row label="Copper" value={facts.empty ? "none: nothing to fill here" : `${areaMm2OfZone(facts.copper).toFixed(1)} mm² in ${facts.pieces} piece${facts.pieces === 1 ? "" : "s"}`} />}
      {!rule && <p className="text-[12px] text-ink-3">The copper is filled again as soon as the zone or the copper round it changes (as you let go of a drag): gap {fmt(set.clearance)}, thinnest copper {fmt(set.minWidth)}.</p>}
      <p className="text-[12px] text-ink-3">Drag a square to move a corner, a dot on an edge to add one, the zone's edge to move the whole zone, right-click a corner to remove it. Delete removes the zone.</p>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12.5px] text-ink-2" title="A locked zone stays as it is when it is dragged or edited">
          Locked
        </span>
        <Switch label="Locked" checked={!!zone.locked} onChange={(on) => patch({ locked: on ? true : undefined })} />
      </div>
      <Button
        variant="danger"
        onClick={() => {
          projectApi().commit((x) => removeZones(x, [zone.id]))
          uiApi().clearSelection()
        }}
        disabled={zone.locked}
      >
        <Trash2 size={14} /> Delete {rule ? "keepout" : "zone"}
      </Button>
    </Section>
  )
}
