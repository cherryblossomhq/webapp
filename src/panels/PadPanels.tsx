import { useState } from "react"
import { updateLandPadMachining, type PadMachiningPatch } from "../model/machiningOps"
import { hasPadFeatures } from "../model/padGeom"
import { padSummary, updateLandPad, type PadPatch } from "../model/padOps"
import { formatLength } from "../model/rules"
import { ownLand } from "../model/shapeOps"
import type { ComponentInstance, CopperLayer, PadDef, Project, ZoneConnect } from "../model/types"
import { projectApi } from "../store/projectStore"
import { Field } from "../ui/controls"
import { CommitInput, LengthInput, Row, Section, useLengthUnit } from "../ui/form"
import { copperLayers, layerLabel } from "../model/stack"
import { HoleMachining } from "./MachiningPanels"
import { landUsers } from "./shapeInspector"

/** X22 and X21: whether a pad has a backdrill, a post-machining, or a length or delay inside its package. */
const hasMachiningFeatures = (pad: PadDef) => pad.backdrill !== undefined || pad.tertiary !== undefined || pad.post !== undefined || pad.dieLength !== undefined || pad.dieDelay !== undefined

const ZONE_OPTIONS: { value: ZoneConnect | ""; label: string }[] = [
  { value: "", label: "The pour's own" },
  { value: "none", label: "Not connected" },
  { value: "thermal", label: "Thermal relief" },
  { value: "solid", label: "Solid" },
  { value: "tht", label: "Thermal relief on through-hole pads only" },
]

/** The sides a pad's layer is on, in words for a row. */
const SIDES = { top: "the part's side", bottom: "the other side", both: "both sides", none: "none" } as const

/**
 * The pads of a part from a KiCad board, in its own land: listed, picked, and the settings a pad can have of its own edited (the margins of its
 * mask opening and paste aperture, its clearance, how a pour joins it). Every part with the land changes with it.
 */
export function PartPadsSection({ c, project }: { c: ComponentInstance; project: Project }) {
  const unit = useLengthUnit()
  const [picked, setPicked] = useState(0)
  const land = ownLand(project, c.id)
  if (!land || !land.pads.some((p) => hasPadFeatures(p) || hasMachiningFeatures(p))) return null
  const index = Math.min(picked, land.pads.length - 1)
  const pad: PadDef = land.pads[index]
  const edit = (patch: PadPatch) => projectApi().commit((p) => updateLandPad(p, land.name, index, patch))
  const users = landUsers(project, land.name)
  const len = (label: string, key: "maskMargin" | "pasteMargin" | "clearance" | "thermalGap" | "thermalWidth", hint: string) => (
    <Field label={label}>
      <LengthInput value={pad[key] ?? null} optional ariaLabel={label} placeholder={hint} min={-10} onCommit={(mm) => edit({ [key]: mm })} />
    </Field>
  )
  return (
    <Section title="Pads" id="part-pads">
      <ul className="max-h-40 overflow-auto rounded border border-line" aria-label="Pads of the part">
        {land.pads.map((p, i) => (
          <li key={i}>
            <button
              type="button"
              aria-pressed={i === index}
              onClick={() => setPicked(i)}
              className={`flex w-full items-baseline justify-between gap-2 px-2 py-1 text-left text-[12.5px] ${i === index ? "bg-select-soft text-ink" : "text-ink-2 hover:bg-chrome-2"}`}
            >
              <span className="truncate">{padSummary(p)}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="text-[12px] text-ink-2">
        Every part with this land changes: {users} {users === 1 ? "part uses" : "parts use"} {land.name}.
      </p>
      <Row label="Size" value={`${formatLength(pad.width, unit)} x ${formatLength(pad.height, unit)}`} />
      {pad.layers && (
        <Row
          label="Layers"
          value={`copper ${SIDES[pad.layers.copper ?? (pad.layer === "through" ? "both" : "top")]}, mask ${SIDES[pad.layers.mask ?? (pad.layer === "through" ? "both" : "top")]}, paste ${SIDES[pad.layers.paste ?? (pad.layer === "through" ? "none" : "top")]}`}
        />
      )}
      {len("Mask margin", "maskMargin", "Board's")}
      {len("Paste margin", "pasteMargin", "Board's")}
      <Field label="Paste ratio">
        <CommitInput type="number" step={0.01} mono ariaLabel="Paste ratio" placeholder="Board's" value={pad.pasteRatio ?? ""} onCommit={(v) => (v.trim() === "" ? edit({ pasteRatio: null }) : Number.isFinite(Number(v)) && edit({ pasteRatio: Number(v) }))} />
      </Field>
      {len("Clearance", "clearance", "Rules'")}
      <Field label="Pour connection">
        <select className="field h-8" value={pad.zoneConnect ?? ""} aria-label="Pour connection" onChange={(e) => edit({ zoneConnect: e.target.value === "" ? null : (e.target.value as ZoneConnect) })}>
          {ZONE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
      {len("Thermal gap", "thermalGap", "Rules'")}
      {len("Spoke width", "thermalWidth", "Rules'")}
      <PadMachining pad={pad} project={project} edit={(patch) => projectApi().commit((p) => updateLandPadMachining(p, land.name, index, patch))} />
      <p className="text-[12px] text-ink-3">A margin or clearance left empty is the board's. The paste ratio is a fraction of the pad's size (0.1 is 10%).</p>
    </Section>
  )
}

/** The pad's backdrill, tertiary drill and post-machining, and the length and delay of its wire inside the package. Layers are seen from the part's own side. */
function PadMachining({ pad, project, edit }: { pad: PadDef; project: Project; edit: (patch: PadMachiningPatch) => void }) {
  const layerName = (l: CopperLayer) => (l === "top" ? "Part's face" : l === "bottom" ? "Far face" : layerLabel(project.board, l))
  return (
    <>
      <HoleMachining
        holes={[{ drill: pad.holeDiameter ?? 0, backdrill: pad.backdrill, tertiary: pad.tertiary, post: pad.post }]}
        layers={copperLayers(project.board)}
        layerName={layerName}
        sides={{ front: "part's face", back: "far face" }}
        edit={(make) => edit(make({ drill: pad.holeDiameter ?? 0, backdrill: pad.backdrill, tertiary: pad.tertiary, post: pad.post }))}
      />
      <Field label="Length in package">
        <LengthInput ariaLabel="Length in package" optional placeholder="None" value={pad.dieLength ?? null} onCommit={(mm) => edit({ dieLength: mm })} />
      </Field>
      <Field label="Delay in package">
        <CommitInput
          mono
          ariaLabel="Delay in package"
          placeholder="None (ps)"
          value={pad.dieDelay ?? ""}
          onCommit={(v) => (v.trim() === "" ? edit({ dieDelay: null }) : Number.isFinite(Number(v)) && Number(v) >= 0 && edit({ dieDelay: Number(v) }))}
        />
      </Field>
    </>
  )
}
