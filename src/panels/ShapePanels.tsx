import { MoveRight, Trash2 } from "lucide-react"
import { useState } from "react"
import { removeGraphics, moveGraphics, updateGraphics, ownLand, updateLandShapes, moveLandShapes, removeLandShapes, type ShapePatch } from "../model/shapeOps"
import { formatLength } from "../model/rules"
import { landShapeId } from "../model/shapeItems"
import type { BoardGraphic, BoardShape, ComponentInstance, Project, ShapeDash } from "../model/types"
import { projectApi } from "../store/projectStore"
import { uiApi, useUi } from "../store/uiStore"
import { Button, Field } from "../ui/controls"
import { LengthInput, Row, Section, Switch, useLengthUnit } from "../ui/form"
import { DASH_OPTIONS, MIXED, landUsers, layerGroups, selectedLandIndices, shapeFacts, shapeRowText, sizeText, type ShapeFacts } from "./shapeInspector"

/** What an edit of drawings does: change them, move them, remove them. Each is one undo step. */
interface ShapeEdits {
  patch: (patch: ShapePatch) => void
  move: (dx: number, dy: number) => void
  remove: () => void
}

/** The properties of one or several drawings, the same for a board's and a part's. */
function ShapeFields({ shapes, edits, frameNote }: { shapes: BoardShape[]; edits: ShapeEdits; frameNote?: string }) {
  const unit = useLengthUnit()
  const [dx, setDx] = useState(0)
  const [dy, setDy] = useState(0)
  const f: ShapeFacts = shapeFacts(shapes)
  const fmt = (mm: number) => formatLength(mm, unit)
  const switchRow = (label: string, hint: string, value: boolean | typeof MIXED, on: (v: boolean) => void) => (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12.5px] text-ink-2" title={hint}>
        {label}
        {value === MIXED ? " (mixed)" : ""}
      </span>
      <Switch label={label} checked={value === true} onChange={on} />
    </div>
  )
  const netText = f.net === MIXED ? "" : f.net
  return (
    <>
      <Row label="Type" value={f.type} />
      <Field label="Layer">
        <select className="field h-8" aria-label="Layer" value={f.layer === MIXED ? "" : f.layer} onChange={(e) => e.target.value && edits.patch({ layer: e.target.value })}>
          {f.layer === MIXED && (
            <option value="" disabled>
              Mixed
            </option>
          )}
          {layerGroups(shapes.map((s) => s.layer)).map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.layers.map((l) => (
                <option key={l.name} value={l.name}>
                  {l.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label={f.width === MIXED ? "Stroke (mixed)" : "Stroke"}>
          <LengthInput min={0} value={f.width === MIXED ? null : f.width} optional placeholder={f.width === MIXED ? "Mixed" : undefined} onCommit={(v) => v !== null && edits.patch({ width: v })} />
        </Field>
        <Field label="Dash">
          <select className="field h-8" aria-label="Dash" value={f.dash === MIXED ? "" : f.dash} onChange={(e) => edits.patch({ dash: (e.target.value || null) as ShapeDash | null })}>
            {f.dash === MIXED && (
              <option value="" disabled>
                Mixed
              </option>
            )}
            {DASH_OPTIONS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {f.allClosed && switchRow("Filled", "Filled solid, as well as outlined by the stroke", f.fill, (fill) => edits.patch({ fill }))}
      {switchRow("Locked", "A locked drawing stays where it is when it is moved", f.locked, (locked) => edits.patch({ locked }))}
      {f.anyCopper && (
        <Field label="Net">
          <input
            key={netText}
            className="field mono h-8"
            aria-label="Net"
            placeholder={f.net === MIXED ? "Mixed" : "No net"}
            defaultValue={netText}
            onBlur={(e) => e.target.value !== netText && edits.patch({ net: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        </Field>
      )}
      {f.box && <Row label="Size" value={`${sizeText(f.box, fmt)} ${unit}`} mono />}
      {f.box && <Row label="Corner" value={`${fmt(f.box.minX)}, ${fmt(f.box.minY)} ${unit}`} mono />}
      <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
        <Field label="Move X">
          <LengthInput min={-1e4} value={dx} onCommit={(v) => v !== null && setDx(v)} ariaLabel="Move by X" />
        </Field>
        <Field label="Move Y">
          <LengthInput min={-1e4} value={dy} onCommit={(v) => v !== null && setDy(v)} ariaLabel="Move by Y" />
        </Field>
        <Button
          disabled={dx === 0 && dy === 0}
          onClick={() => {
            edits.move(dx, dy)
            setDx(0)
            setDy(0)
          }}
          title="Move by this much; a locked drawing stays"
        >
          <MoveRight size={14} /> Apply
        </Button>
      </div>
      {frameNote && <p className="text-[12px] text-ink-2">{frameNote}</p>}
      <Button variant="danger" onClick={edits.remove}>
        <Trash2 size={14} /> Delete {f.count > 1 ? `${f.count} drawings` : "drawing"}
      </Button>
    </>
  )
}

/** The Inspector for one or more selected board drawings. */
export function DrawingInspector({ graphics }: { graphics: BoardGraphic[] }) {
  const ids = graphics.map((g) => g.id)
  const edits: ShapeEdits = {
    patch: (patch) => projectApi().commit((p) => updateGraphics(p, ids, patch)),
    move: (dx, dy) => projectApi().commit((p) => moveGraphics(p, ids, dx, dy)),
    remove: () => {
      projectApi().commit((p) => removeGraphics(p, ids))
      uiApi().clearSelection()
    },
  }
  return (
    <Section title={graphics.length > 1 ? `${graphics.length} drawings` : "Drawing"}>
      <ShapeFields shapes={graphics} edits={edits} />
    </Section>
  )
}

/** A part's own drawings, in its land: listed, picked, edited. Every part with the land changes. */
export function PartDrawingsSection({ c, project }: { c: ComponentInstance; project: Project }) {
  const selection = useUi((s) => s.selection)
  const [local, setLocal] = useState<number[]>([])
  const land = ownLand(project, c.id)
  const shapes = land?.shapes
  if (!land || !shapes?.length) return null
  const fromSelection = selectedLandIndices(selection, c.id, shapes.length)
  const picked = fromSelection.length ? fromSelection : local.filter((i) => i < shapes.length)
  const pick = (i: number, add: boolean) => {
    const next = add ? (picked.includes(i) ? picked.filter((x) => x !== i) : [...picked, i]) : [i]
    setLocal(next)
    uiApi().select(next.map((n) => landShapeId(c.id, n)))
  }
  const users = landUsers(project, land.name)
  const edits: ShapeEdits = {
    patch: (patch) => projectApi().commit((p) => updateLandShapes(p, land.name, picked, patch)),
    move: (dx, dy) => projectApi().commit((p) => moveLandShapes(p, land.name, picked, dx, dy)),
    remove: () => {
      projectApi().commit((p) => removeLandShapes(p, land.name, picked))
      setLocal([])
      uiApi().select([`c:${c.id}`])
    },
  }
  return (
    <Section title="Part drawings" id="part-drawings">
      <ul className="max-h-40 overflow-auto rounded border border-line" aria-label="Part drawings">
        {shapes.map((s, i) => (
          <li key={i}>
            <button
              type="button"
              aria-pressed={picked.includes(i)}
              onClick={(e) => pick(i, e.shiftKey || e.metaKey || e.ctrlKey)}
              className={`flex w-full items-baseline justify-between gap-2 px-2 py-1 text-left text-[12.5px] ${picked.includes(i) ? "bg-select-soft text-ink" : "text-ink-2 hover:bg-chrome-2"}`}
            >
              <span className="truncate">{shapeRowText(s)}</span>
              <span className="mono shrink-0 text-ink-3">{s.width}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="text-[12px] text-ink-2">
        Every part with this land changes: {users} {users === 1 ? "part uses" : "parts use"} {land.name}.
      </p>
      {picked.length > 0 ? (
        <ShapeFields shapes={picked.map((i) => shapes[i])} edits={edits} frameNote="Moves are in the land's own frame, before the part is turned or flipped." />
      ) : (
        <p className="text-[12px] text-ink-3">Pick a drawing to edit it.</p>
      )}
    </Section>
  )
}
