import { Plus, RotateCcw, Trash2 } from "lucide-react"
import { useState } from "react"
import { copperCount } from "../model/stack"
import { addPartText, patchTexts, removeBoardTexts, removePartText, resetPartTexts, withDesignatorText, type TextPatch } from "../model/textOps"
import { componentTexts, parseTextId, shownOf, type WorldText } from "../model/texts"
import type { ComponentInstance, Project } from "../model/types"
import { projectApi } from "../store/projectStore"
import { uiApi } from "../store/uiStore"
import { Button, Field } from "../ui/controls"
import { LengthInput, Section, Switch } from "../ui/form"
import { MIXED } from "./shapeInspector"
import { textFacts, textLayerGroups, textRowText } from "./textInspector"

/** The properties of one or several texts, the same for board text and a part's. */
function TextFields({ texts, project }: { texts: WorldText[]; project: Project }) {
  const f = textFacts(texts)
  const one = texts.length === 1 ? texts[0] : null
  const edit = (patch: TextPatch) => projectApi().commit((p) => patchTexts(p, texts, patch))
  const switchRow = (label: string, hint: string, value: boolean | typeof MIXED, on: (v: boolean) => void) => (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12.5px] text-ink-2" title={hint}>
        {label}
        {value === MIXED ? " (mixed)" : ""}
      </span>
      <Switch label={label} checked={value === true} onChange={on} />
    </div>
  )
  // A reference or a value shows the part's own; text of its own and board text has content to edit.
  const editable = one && (one.kind === "board" || one.kind === "user")
  const shown = one ? shownOf(project, one) : ""
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <>
      {one && editable && (
        <Field label="Text">
          <textarea
            className="field mono min-h-[56px] py-1.5"
            aria-label="Text"
            value={draft ?? one.content}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (draft !== null && draft !== one.content) edit({ text: draft })
              setDraft(null)
            }}
          />
        </Field>
      )}
      {one && !editable && <p className="text-[12.5px] text-ink-2">Shows {shown ? `"${shown}"` : "nothing"}: the {one.kind === "reference" ? "reference" : "value"} of the part, so change it on the part.</p>}
      {one && editable && shown !== one.content && <p className="text-[12px] text-ink-2">Shows "{shown}" (variables such as {"${REFERENCE}"} are filled in).</p>}
      <Field label="Layer">
        <select className="field h-8" aria-label="Layer" value={f.layer === MIXED ? "" : f.layer} onChange={(e) => e.target.value && edit({ layer: e.target.value })}>
          {f.layer === MIXED && (
            <option value="" disabled>
              Mixed
            </option>
          )}
          {textLayerGroups(texts.map((t) => t.layer)).map((g) => (
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
        <Field label={f.size === MIXED ? "Height (mixed)" : "Height"}>
          <LengthInput min={0.001} value={f.size === MIXED ? null : f.size} optional placeholder={f.size === MIXED ? "Mixed" : undefined} onCommit={(v) => v !== null && edit({ size: v, ...(f.w === f.size ? { w: null } : {}) })} ariaLabel="Text height" />
        </Field>
        <Field label={f.w === MIXED ? "Width (mixed)" : "Width"}>
          <LengthInput min={0.001} value={f.w === MIXED ? null : f.w} optional placeholder={f.w === MIXED ? "Mixed" : undefined} onCommit={(v) => v !== null && edit({ w: v })} ariaLabel="Text width" />
        </Field>
      </div>
      <Field label="Pen width">
        <LengthInput min={0} value={f.thickness === MIXED || f.thickness === 0 ? null : f.thickness} optional placeholder={f.thickness === MIXED ? "Mixed" : "Automatic"} onCommit={(v) => edit({ thickness: v })} ariaLabel="Pen width" />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Across">
          <select className="field h-8" aria-label="Horizontal justification" value={f.hj === MIXED ? "" : String(f.hj)} onChange={(e) => e.target.value !== "" && edit({ hj: e.target.value === "-1" ? "left" : e.target.value === "1" ? "right" : null })}>
            {f.hj === MIXED && (
              <option value="" disabled>
                Mixed
              </option>
            )}
            <option value="-1">Left</option>
            <option value="0">Centre</option>
            <option value="1">Right</option>
          </select>
        </Field>
        <Field label="Down">
          <select className="field h-8" aria-label="Vertical justification" value={f.vj === MIXED ? "" : String(f.vj)} onChange={(e) => e.target.value !== "" && edit({ vj: e.target.value === "-1" ? "top" : e.target.value === "1" ? "bottom" : null })}>
            {f.vj === MIXED && (
              <option value="" disabled>
                Mixed
              </option>
            )}
            <option value="-1">Top</option>
            <option value="0">Centre</option>
            <option value="1">Bottom</option>
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Angle (degrees)">
          <input
            key={String(f.rot)}
            type="number"
            className="field mono h-8"
            aria-label="Angle"
            step={1}
            defaultValue={f.rot === MIXED ? "" : Math.round((one ? one.rot : (f.rot as number)) * 1e4) / 1e4}
            placeholder={f.rot === MIXED ? "Mixed" : undefined}
            onBlur={(e) => e.target.value !== "" && Number.isFinite(Number(e.target.value)) && edit({ rot: Number(e.target.value) })}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        </Field>
        <Field label="Line spacing">
          <input
            key={String(f.spacing)}
            type="number"
            className="field mono h-8"
            aria-label="Line spacing"
            step={0.05}
            min={0.1}
            defaultValue={f.spacing === MIXED ? "" : f.spacing}
            placeholder={f.spacing === MIXED ? "Mixed" : undefined}
            onBlur={(e) => e.target.value !== "" && Number.isFinite(Number(e.target.value)) && edit({ spacing: Number(e.target.value) })}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        </Field>
      </div>
      {one && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="X">
            <LengthInput min={-1e4} value={one.x} onCommit={(v) => v !== null && edit({ x: v })} ariaLabel="Text X" />
          </Field>
          <Field label="Y">
            <LengthInput min={-1e4} value={one.y} onCommit={(v) => v !== null && edit({ y: v })} ariaLabel="Text Y" />
          </Field>
        </div>
      )}
      {switchRow("Bold", "Bold text is drawn with a thicker pen", f.bold, (bold) => edit({ bold }))}
      {switchRow("Italic", "Leans the letters", f.italic, (italic) => edit({ italic }))}
      {switchRow("Mirrored", "Reads backwards from above: text on a bottom layer is mirrored to read from below", f.mirror, (mirror) => edit({ mirror }))}
      {switchRow("Knockout", "A filled box with the letters cut out of it", f.knockout, (knockout) => edit({ knockout }))}
      {f.allPart && switchRow("Hidden", "A hidden text is neither drawn nor plotted", f.hide, (hide) => edit({ hide }))}
      {f.allPart && switchRow("Keep upright", "Turns upside-down text half a turn so it reads from the bottom or the right", f.upright, (upright) => edit({ upright }))}
      {switchRow("Locked", "A locked text stays where it is when it is moved", f.locked, (locked) => edit({ locked }))}
      {f.anyBox && <p className="text-[12px] text-ink-2">A text box wraps its text inside its rectangle.</p>}
    </>
  )
}

/** The Inspector for one or more selected texts. */
export function TextInspector({ texts, project }: { texts: WorldText[]; project: Project }) {
  const deletable = texts.filter((t) => t.kind === "board" || t.kind === "user")
  const remove = () => {
    projectApi().commit((p) => {
      let out = removeBoardTexts(p, deletable.flatMap((t) => (t.kind === "board" ? [(t.source as { id: string }).id] : [])))
      const parts = deletable.filter((t) => t.kind === "user").sort((a, b) => b.index - a.index)
      for (const t of parts) out = removePartText(out, t.owner, t.index)
      return out
    })
    uiApi().clearSelection()
  }
  const ref = texts.length === 1 && texts[0].component ? texts[0].component.ref : null
  return (
    <Section title={texts.length > 1 ? `${texts.length} texts` : texts[0]?.kind === "board" ? "Text" : `Text of ${ref ?? "a part"}`}>
      <TextFields texts={texts} project={project} />
      {deletable.length > 0 && (
        <Button variant="danger" onClick={remove}>
          <Trash2 size={14} /> Delete {deletable.length > 1 ? `${deletable.length} texts` : "text"}
        </Button>
      )}
    </Section>
  )
}

/** A part's texts: its reference, its value and its own, listed and picked, with a way to add one and to hand the designator back to the editor. */
export function PartTextsSection({ c, project }: { c: ComponentInstance; project: Project }) {
  const list = componentTexts(c, copperCount(project.board))
  const own = !!c.texts
  const [confirming, setConfirming] = useState(false)
  return (
    <Section title="Text" id="part-text">
      {own ? (
        <ul className="max-h-40 overflow-auto rounded border border-line" aria-label="Part text">
          {list.map((t) => (
            <li key={t.id}>
              <button type="button" onClick={() => uiApi().select([t.id])} className="flex w-full items-baseline justify-between gap-2 px-2 py-1 text-left text-[12.5px] text-ink-2 hover:bg-chrome-2">
                <span className="truncate">{textRowText(t, shownOf(project, t))}</span>
                <span className="mono shrink-0 text-ink-3">{t.layer}</span>
              </button>
            </li>
          ))}
          {list.length === 0 && <li className="px-2 py-1 text-[12.5px] text-ink-3">This part has no text.</li>}
        </ul>
      ) : (
        <p className="text-[12px] text-ink-2">The designator is placed for you. Place it by hand to move it, or add text.</p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {!own && (
          <Button onClick={() => projectApi().commit((p) => withDesignatorText(p, c.id))} title="The designator becomes a text of the part, where it is now, and can be moved">
            Place designator by hand
          </Button>
        )}
        <Button
          onClick={() => {
            let index = -1
            projectApi().commit((p) => {
              const part = p.components.find((x) => x.id === c.id)!
              const res = addPartText(p, c.id, { text: "TEXT", at: { x: part.pcb.x, y: part.pcb.y } })
              index = res.index
              return res.project
            })
            if (index >= 0) uiApi().select([`p:${c.id}:${index}`])
          }}
        >
          <Plus size={14} /> Add text
        </Button>
        {own && !confirming && (
          <Button
            // a part that holds only its own reference text (one placed by hand here) gives it back at once; one that holds more says what it removes first
            onClick={() => (list.length > 1 ? setConfirming(true) : projectApi().commit((p) => resetPartTexts(p, c.id)))}
            title="Removes this part's texts; its designator is placed for you again"
          >
            <RotateCcw size={14} /> Automatic designator
          </Button>
        )}
      </div>
      {own && confirming && (
        <div className="flex flex-col gap-1.5 rounded border border-line p-2" role="alert">
          <p className="text-[12.5px] text-ink-2">
            This removes all {list.length} texts of {c.ref} ({[list.some((t) => t.kind === "reference") && "its reference", list.some((t) => t.kind === "value") && "its value", list.filter((t) => t.kind === "user").length > 0 && `${list.filter((t) => t.kind === "user").length} of its own`].filter(Boolean).join(", ")}) and places the designator for you again.
          </p>
          <div className="flex gap-1.5">
            <Button
              variant="danger"
              onClick={() => {
                setConfirming(false)
                projectApi().commit((p) => resetPartTexts(p, c.id))
              }}
            >
              Remove the {list.length} texts
            </Button>
            <Button onClick={() => setConfirming(false)}>Keep them</Button>
          </div>
        </div>
      )}
    </Section>
  )
}

/** The id of a text a selection holds, for the part panel to stay open on. */
export const textOwner = (selection: string[]): string | null => {
  const parsed = selection.length === 1 ? parseTextId(selection[0]) : null
  return parsed?.kind === "part" ? parsed.component : null
}
