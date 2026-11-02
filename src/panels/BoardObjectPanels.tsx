import { Group, Lock, LockOpen, Trash2, Ungroup } from "lucide-react"
import { groupSelected, lockSelectedGroups, selectedGroups, ungroupSelected } from "../editor/pcb/groupActions"
import { DIMENSION_NAMES } from "../editor/pcb/boardObjectEditing"
import { imageSize, removeDimensions, removeImages, renameGroup, updateDimensions, updateImages, type DimensionPatch, type ImagePatch, leafMembers } from "../model/boardObjects"
import { dimensionDrawing } from "../model/dimensions"
import { formatLength } from "../model/rules"
import type { BoardDimension, Project, ReferenceImage } from "../model/types"
import { imageState } from "../store/imageFiles"
import { projectApi } from "../store/projectStore"
import { uiApi, useUi } from "../store/uiStore"
import { Button, Field } from "../ui/controls"
import { CommitInput, LayerSelect, LengthInput, Row, Section, switchRow, useLengthUnit } from "../ui/form"
import { GeneratorBlock } from "./GeneratorPanels"
import { layerGroups } from "./shapeInspector"

const MIXED = "\u0000mixed"

/** What a list shares: its one value, or `MIXED`. */
function common<T, V>(items: T[], pick: (t: T) => V): V | typeof MIXED {
  const first = pick(items[0])
  return items.every((x) => pick(x) === first) ? first : MIXED
}

const UNIT_MODES = [
  { value: 2, label: "Millimetres" },
  { value: 1, label: "Mils" },
  { value: 0, label: "Inches" },
  { value: 3, label: "Automatic (shown in millimetres)" },
]
const FORMATS = [
  { value: 1, label: "After the value (1.5 mm)" },
  { value: 2, label: "In brackets (1.5 (mm))" },
  { value: 0, label: "None" },
]
const TEXT_MODES = [
  { value: 0, label: "Outside the crossbar" },
  { value: 1, label: "On the crossbar" },
  { value: 2, label: "Where it is put" },
]
const FRAMES = [
  { value: 0, label: "None" },
  { value: 1, label: "Rectangle" },
  { value: 2, label: "Circle" },
]

const edit = (ids: string[], patch: DimensionPatch) => projectApi().commit((p) => updateDimensions(p, ids, patch))

/** The properties of one or several dimensions: what they measure, how they say it, and how they are drawn. Each edit is one undo step. */
export function DimensionInspector({ dims, project }: { dims: BoardDimension[]; project: Project }) {
  const unit = useLengthUnit()
  const ids = dims.map((d) => d.id)
  const kind = common(dims, (d) => d.kind)
  const one = dims.length === 1 ? dims[0] : null
  const text = one ? dimensionDrawing(one).text?.content : undefined
  const aligned = kind === "aligned" || kind === "orthogonal"
  return (
    <Section title={dims.length > 1 ? `${dims.length} dimensions` : "Dimension"}>
      <Row label="Kind" value={kind === MIXED ? "Mixed" : DIMENSION_NAMES[kind]} />
      {one && one.kind !== "center" && <Row label="Shows" value={text ? text : "(nothing)"} mono />}
      {one && <Row label="Measures" value={`${formatLength(dimensionDrawing(one).measured / 1e6, unit, true)}`} mono />}
      <Field label="Layer">
        <LayerSelect groups={layerGroups(dims.map((d) => d.layer))} value={common(dims, (d) => d.layer)} mixed={MIXED} onChange={(layer) => edit(ids, { layer })} />
      </Field>
      {kind !== "center" && (
        <>
          <Field label="Text">
            <CommitInput
              mono
              value={common(dims, (d) => d.override ?? "") === MIXED ? "" : (dims[0].override ?? "")}
              placeholder={kind === "leader" ? "The text" : "Measured value"}
              onCommit={(v) => edit(ids, { override: v === "" && kind !== "leader" ? null : v })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Prefix">
              <CommitInput mono value={common(dims, (d) => d.prefix ?? "") === MIXED ? "" : (dims[0].prefix ?? "")} onCommit={(v) => edit(ids, { prefix: v })} />
            </Field>
            <Field label="Suffix">
              <CommitInput mono value={common(dims, (d) => d.suffix ?? "") === MIXED ? "" : (dims[0].suffix ?? "")} onCommit={(v) => edit(ids, { suffix: v })} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Units">
              <select className="field h-8" aria-label="Units" value={common(dims, (d) => d.units) === MIXED ? "" : dims[0].units} onChange={(e) => edit(ids, { units: Number(e.target.value) })}>
                {common(dims, (d) => d.units) === MIXED && <option value="">Mixed</option>}
                {UNIT_MODES.map((u) => (
                  <option key={u.value} value={u.value}>
                    {u.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Digits">
              <CommitInput type="number" min={0} step={1} ariaLabel="Digits" value={common(dims, (d) => d.precision) === MIXED ? "" : dims[0].precision} onCommit={(v) => Number.isInteger(Number(v)) && edit(ids, { precision: Number(v) })} />
            </Field>
          </div>
          <Field label="Units shown">
            <select className="field h-8" aria-label="Units shown" value={common(dims, (d) => d.format) === MIXED ? "" : dims[0].format} onChange={(e) => edit(ids, { format: Number(e.target.value) })}>
              {common(dims, (d) => d.format) === MIXED && <option value="">Mixed</option>}
              {FORMATS.map((u) => (
                <option key={u.value} value={u.value}>
                  {u.label}
                </option>
              ))}
            </select>
          </Field>
          {switchRow("Drop trailing zeros", "1.50 is shown as 1.5", common(dims, (d) => d.zeros === true), (zeros) => edit(ids, { zeros }))}
          <Field label="Text size">
            <LengthInput min={0.1} value={common(dims, (d) => d.size) === MIXED ? null : dims[0].size} optional placeholder={common(dims, (d) => d.size) === MIXED ? "Mixed" : undefined} onCommit={(v) => v !== null && edit(ids, { size: v })} />
          </Field>
          <Field label="Text position">
            <select className="field h-8" aria-label="Text position" value={common(dims, (d) => d.textMode ?? 0) === MIXED ? "" : (dims[0].textMode ?? 0)} onChange={(e) => edit(ids, { textMode: Number(e.target.value) as 0 | 1 | 2 })}>
              {common(dims, (d) => d.textMode ?? 0) === MIXED && <option value="">Mixed</option>}
              {TEXT_MODES.map((u) => (
                <option key={u.value} value={u.value}>
                  {u.label}
                </option>
              ))}
            </select>
          </Field>
          {switchRow("Text turns with the line", "Keep the text aligned with the crossbar", common(dims, (d) => d.keep === true), (keep) => edit(ids, { keep }))}
        </>
      )}
      {aligned && one && (
        <>
          <Field label="Crossbar distance">
            <LengthInput min={-1e4} value={one.height ?? 0} onCommit={(v) => v !== null && edit(ids, { height: v })} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Lines past the bar">
              <LengthInput min={0} value={one.extHeight} onCommit={(v) => v !== null && edit(ids, { extHeight: v })} />
            </Field>
            <Field label="Lines start away">
              <LengthInput min={0} value={one.extOffset} onCommit={(v) => v !== null && edit(ids, { extOffset: v })} />
            </Field>
          </div>
        </>
      )}
      {kind === "radial" && one && (
        <Field label="Leader length">
          <LengthInput min={0.1} value={one.leaderLength ?? 3.81} onCommit={(v) => v !== null && edit(ids, { leaderLength: v })} />
        </Field>
      )}
      {kind === "leader" && (
        <Field label="Frame">
          <select className="field h-8" aria-label="Frame" value={common(dims, (d) => d.frame ?? 0) === MIXED ? "" : (dims[0].frame ?? 0)} onChange={(e) => edit(ids, { frame: Number(e.target.value) as 0 | 1 | 2 })}>
            {FRAMES.map((u) => (
              <option key={u.value} value={u.value}>
                {u.label}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Field label="Line width">
          <LengthInput min={0} value={common(dims, (d) => d.thickness) === MIXED ? null : dims[0].thickness} optional placeholder={common(dims, (d) => d.thickness) === MIXED ? "Mixed" : undefined} onCommit={(v) => v !== null && edit(ids, { thickness: v })} />
        </Field>
        <Field label="Arrow length">
          <LengthInput min={0} value={common(dims, (d) => d.arrow) === MIXED ? null : dims[0].arrow} optional placeholder={common(dims, (d) => d.arrow) === MIXED ? "Mixed" : undefined} onCommit={(v) => v !== null && edit(ids, { arrow: v })} />
        </Field>
      </div>
      {aligned && switchRow("Arrows point inwards", "From outside the crossbar, with a tail", common(dims, (d) => d.inward === true), (inward) => edit(ids, { inward }))}
      {switchRow("Locked", "A locked dimension stays where it is when it is moved", common(dims, (d) => d.locked === true), (locked) => edit(ids, { locked }))}
      <GroupSection project={project} />
      <Button
        variant="danger"
        onClick={() => {
          projectApi().commit((p) => removeDimensions(p, ids))
          uiApi().clearSelection()
        }}
      >
        <Trash2 size={14} /> Delete {dims.length > 1 ? `${dims.length} dimensions` : "dimension"}
      </Button>
    </Section>
  )
}

/** Why an image's picture is not here, in the host's words. */
const missingWhy = (m: ReferenceImage) => {
  const s = imageState(m.file)
  return s?.state === "missing" ? s.why : "The picture is not here."
}

const editImage = (ids: string[], patch: ImagePatch) => projectApi().commit((p) => updateImages(p, ids, patch))

/** The properties of one or several reference images. */
export function ImageInspector({ images, project }: { images: ReferenceImage[]; project: Project }) {
  const unit = useLengthUnit()
  const ids = images.map((m) => m.id)
  const one = images.length === 1 ? images[0] : null
  const missing = images.filter((m) => imageState(m.file)?.state === "missing")
  return (
    <Section title={images.length > 1 ? `${images.length} reference images` : "Reference image"}>
      <Field label="Layer">
        <LayerSelect groups={layerGroups(images.map((m) => m.layer))} value={common(images, (m) => m.layer)} mixed={MIXED} onChange={(layer) => editImage(ids, { layer })} />
      </Field>
      {one && (
        <>
          <Row label="Picture" value={`${one.px} by ${one.py} pixels at ${one.ppi} per inch`} mono />
          <Row label="Size on the board" value={`${formatLength(imageSize(one).w, unit, true)} by ${formatLength(imageSize(one).h, unit, true)}`} mono />
          <div className="grid grid-cols-2 gap-2">
            <Field label="Centre X">
              <LengthInput min={-1e5} value={one.x} onCommit={(v) => v !== null && editImage(ids, { x: v })} />
            </Field>
            <Field label="Centre Y">
              <LengthInput min={-1e5} value={one.y} onCommit={(v) => v !== null && editImage(ids, { y: v })} />
            </Field>
          </div>
        </>
      )}
      <Field label="Scale">
        <CommitInput type="number" min={0.001} step={0.05} mono ariaLabel="Scale" value={common(images, (m) => m.scale) === MIXED ? "" : images[0].scale} onCommit={(v) => Number(v) > 0 && editImage(ids, { scale: Number(v) })} />
      </Field>
      {switchRow("Locked", "A locked image stays where it is when it is moved", common(images, (m) => m.locked === true), (locked) => editImage(ids, { locked }))}
      {missing.length > 0 && <p className="text-[12px] text-danger">{missingWhy(missing[0])} It is drawn as a frame, and kept in the project.</p>}
      <p className="text-[12px] text-ink-2">Reference images are for tracing: they are never in the Gerber files.</p>
      <GroupSection project={project} />
      <Button
        variant="danger"
        onClick={() => {
          projectApi().commit((p) => removeImages(p, ids))
          uiApi().clearSelection()
        }}
      >
        <Trash2 size={14} /> Delete {images.length > 1 ? `${images.length} images` : "image"}
      </Button>
    </Section>
  )
}

/** The groups a selection is in, and what can be done to them: group, take apart, lock, name. Nothing for a selection that is in no group and cannot be grouped. */
export function GroupSection({ project }: { project: Project }) {
  const selection = useUi((s) => s.selection)
  const groups = selectedGroups(project, selection)
  const groupable = selection.some((s) => "ctvgxmi".includes(s[0]) && s[1] === ":")
  if (!groups.length && selection.length < 2 && !groupable) return null
  const locked = groups.length > 0 && groups.every((g) => g.locked)
  const one = groups.length === 1 ? groups[0] : null
  // A generated item (a tuning pattern, a via stack, via stitching) is taken apart rather than ungrouped.
  const generated = groups.length > 0 && groups.every((g) => g.gen)
  const keeps = groups.every((g) => g.gen?.kind === "tuning_pattern") ? "tracks" : groups.some((g) => g.gen?.kind === "tuning_pattern") ? "tracks and vias" : "vias"
  return (
    <div className="space-y-2.5 border-t border-line pt-2.5">
      <div className="text-[12px] font-medium uppercase tracking-wide text-ink-3">{groups.length ? (groups.length > 1 ? `${groups.length} groups` : "Group") : "Grouping"}</div>
      {one && (
        <>
          <Field label="Name">
            <CommitInput value={one.name} placeholder="No name" onCommit={(v) => projectApi().commit((p) => renameGroup(p, one.id, v))} />
          </Field>
          <Row label="Holds" value={`${leafMembers(project, one).length} objects`} />
          {one.gen && <GeneratorBlock group={one} project={project} />}
        </>
      )}
      <div className="flex flex-wrap gap-1.5">
        {selection.length > 1 && (
          <Button onClick={() => groupSelected()} title="Move, turn and lock the selection together (Ctrl or Cmd G)">
            <Group size={14} /> Group
          </Button>
        )}
        {groups.length > 0 && (
          <Button onClick={() => ungroupSelected()} title={generated ? `The ${keeps} stay as plain ${keeps}` : "Take the group apart; what was in it stays (Ctrl or Cmd Shift G)"}>
            <Ungroup size={14} /> {generated ? "Take apart" : "Ungroup"}
          </Button>
        )}
        {groups.length > 0 && (
          <Button onClick={() => lockSelectedGroups(!locked)} title={locked ? "Let the group be moved again" : "Keep everything in the group where it is"}>
            {locked ? <LockOpen size={14} /> : <Lock size={14} />} {locked ? "Unlock group" : "Lock group"}
          </Button>
        )}
      </div>
      {generated && <p className="text-[12px] text-ink-2">{`The ${keeps} stay as plain ${keeps}`}</p>}
      {groups.length > 0 && <p className="text-[12px] text-ink-2">A click picks the whole group. Ctrl or Cmd click picks one thing in it.</p>}
    </div>
  )
}

