import { commitHere, removalNote, shownPath } from "../store/sheetScope"
import { ArrowUp, BringToFront, Copy, FolderOpen, Plus, RotateCw, SendToBack, Trash2 } from "lucide-react"

import { useSch } from "../editor/theme"
import { setDirectiveClass, setDirectiveLength, setDirectiveShape, isNetclassFieldName } from "../model/directives"
import { applyStyle, drawingKind, LINE_DASHES, LINE_WEIGHTS, removeDrawings, reorderDrawings, rotateDrawing, updateDrawings } from "../model/drawings"
import { aliasLookup } from "../model/busConnectivity"
import { BusTooLarge, isBusName, parseBusName, typedNetName } from "../model/busNames"
import { setBlockLocked, setLabelStyle } from "../model/schematicEdit"
import { BUS_WIDTH, lookOfText, textLines } from "../model/sheetItems"
import { SCH_TEXT } from "../model/symbols"
import { addMissingPins, addSheetPin, addSheetUse, missingPins, removeSheetPin, removeSheetSymbols, renameSheetUse, setSheetPin, setSheetSymbol } from "../model/sheetOps"
import { sheetUses, useAt, usesOfSheet } from "../model/sheets"
import { projectApi } from "../store/projectStore"
import { uiApi } from "../store/uiStore"
import type { DirectiveShape, RuleAreaMark, SheetSymbol, DrawingStyle, DrawingTable, LabelShape, NetLabel, Project, SchematicBlock, SchematicDrawing, SheetStroke, TextLook } from "../model/types"
import { getConnectivity } from "../store/analysis"
import { Button, Field, Segmented } from "../ui/controls"
import { ColorField, CommitInput, Group, Row, Section, Switch } from "../ui/form"
import { cap, Swatches } from "./DrawingInspector"

// The Inspector for what the importer brings: a label of KiCad's (its kind, shape, size and style), the
// drawings a KiCad sheet gave (text, text boxes, lines, shapes, pictures, tables, dots, flags: exact controls),
// and a locked group. A part's flags are the Flags section of the part's Inspector (`Inspector.tsx`).

const MM = 12.7
const mm = (units: number | undefined, fallback: number) => String(Math.round((units ?? fallback) * MM * 10000) / 10000)

const SHAPES: { value: LabelShape; label: string }[] = [
  { value: "input", label: "Input" },
  { value: "output", label: "Output" },
  { value: "bidirectional", label: "Bidirectional" },
  { value: "tri_state", label: "Tri-state" },
  { value: "passive", label: "Passive" },
]

const DIRECTIVE_SHAPES: { value: DirectiveShape; label: string }[] = [
  { value: "round", label: "Round" },
  { value: "dot", label: "Dot" },
  { value: "diamond", label: "Diamond" },
  { value: "rectangle", label: "Rectangle" },
]

const RULE_AREA_FLAGS: { key: "dnp" | "excludeFromBom" | "notOnBoard" | "excludeFromSim"; label: string }[] = [
  { key: "dnp", label: "Do not populate" },
  { key: "excludeFromBom", label: "Leave out of the BOM" },
  { key: "notOnBoard", label: "Not on the board" },
  { key: "excludeFromSim", label: "Leave out of simulation" },
]

/** A rule area's marks with one flag set or cleared. */
function withFlag(mark: RuleAreaMark, key: (typeof RULE_AREA_FLAGS)[number]["key"], on: boolean): RuleAreaMark {
  const { [key]: _old, ...rest } = mark
  return on ? { ...rest, [key]: true } : rest
}

const DASHES: { value: string; label: string }[] = [
  { value: "", label: "Solid" },
  { value: "dash", label: "Dash" },
  { value: "dot", label: "Dot" },
  { value: "dash_dot", label: "Dash dot" },
  { value: "dash_dot_dot", label: "Dash dot dot" },
]

/** A label from KiCad, or any label of a project named as KiCad names its nets. */
export function LabelInspector({ l, project }: { l: NetLabel; project: Project }) {
  const conn = getConnectivity(project)
  const net = conn.nets.find((n) => n.id === conn.labelNet.get(l.id))
  const set = (change: Parameters<typeof setLabelStyle>[2]) => commitHere((p) => setLabelStyle(p, l.id, change))
  const kind = l.kind === "global" ? "global" : l.kind === "hierarchical" ? "hierarchical" : "local"
  return (
    <Section title={kind === "global" ? "Global label" : kind === "hierarchical" ? "Hierarchical label" : "Label"}>
      <Field label="Text">
        <CommitInput mono value={l.name} onCommit={(v) => v.trim() && set({ name: isBusName(v.trim()) ? v.trim().replace(/\s+/g, " ") : typedNetName(v.trim()) })} />
      </Field>
      <Field label="Joins">
        <Segmented
          size="sm"
          value={kind}
          options={[
            { value: "local", label: "This sheet", title: "A local label: the net is /NAME" },
            { value: "global", label: "Every sheet", title: "A global label: the net is NAME" },
            { value: "hierarchical", label: "Parent sheet", title: "A hierarchical label: joins the pin of the same name on the sheet symbol that stands for this sheet" },
          ]}
          onChange={(v) => set({ kind: v })}
        />
      </Field>
      {kind !== "local" && (
        <Field label="Shape">
          <select className="field h-8" value={l.shape ?? "bidirectional"} onChange={(e) => set({ shape: e.target.value as LabelShape })}>
            {SHAPES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
      )}
      <TextStyle look={l.look} onChange={(look) => set({ look })} />
      <div className="flex flex-wrap gap-1.5">
        <Button onClick={() => set({ turn: (((l.rot + 90) % 360) as NetLabel["rot"]) })} title="Turn a quarter">
          <RotateCw size={14} /> Turn
        </Button>
      </div>
      {net && <Row label="Net" value={net.name} mono />}
      {!net && <BusMembers text={l.name} project={project} />}
      <p className="text-[12px] text-ink-2">{kind === "global" ? "Every global label with this text is one net, on every sheet." : kind === "hierarchical" ? "Joins the sheet pin of this name on the sheet symbol above, and the labels with this text on this sheet." : "Labels with this text on this sheet are one net, named /NAME."}</p>
    </Section>
  )
}

/** S3: what a label that names a bus carries: its nets, as KiCad names them. */
function BusMembers({ text, project }: { text: string; project: Project }) {
  let names: string[] | undefined
  try {
    names = parseBusName(text.trim(), aliasLookup(project.busAliases))?.names
  } catch (e) {
    if (!(e instanceof BusTooLarge)) throw e
  }
  if (!names) return null
  return <Row label="Bus" value={names.length > 8 ? `${names.slice(0, 8).join(" ")} ... (${names.length} nets)` : names.join(" ")} mono />
}

/** Size in millimetres, bold and italic, and a colour of a text. */
function TextStyle({ look, onChange }: { look: TextLook | undefined; onChange: (look: Partial<TextLook> | null) => void }) {
  return (
    <>
      <Field label="Text size (mm)">
        <CommitInput
          mono
          type="number"
          step={0.127}
          min={0.1}
          value={mm(look?.size, 0.1)}
          onCommit={(v) => {
            const size = Number(v) / MM
            if (Number.isFinite(size) && size > 0) onChange({ size: Math.abs(size - 0.1) < 1e-9 ? undefined : size })
          }}
        />
      </Field>
      <div className="flex items-center justify-between">
        <span className="text-[13px] text-ink">Bold</span>
        <Switch label="Bold" checked={!!look?.bold} onChange={(v) => onChange({ bold: v ? true : undefined })} />
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[13px] text-ink">Italic</span>
        <Switch label="Italic" checked={!!look?.italic} onChange={(v) => onChange({ italic: v ? true : undefined })} />
      </div>
      <Field label="Text colour">
        <ColorField value={look?.color} fallback="#10297a" onCommit={(hex) => onChange({ color: hex })} label="Text colour" />
      </Field>
    </>
  )
}

/** A drawing a KiCad sheet gave, or one that says its look exactly: its text, its text style, its stroke in millimetres and a colour of any value. */
export function ExactDrawingInspector({ drawing }: { drawing: SchematicDrawing }) {
  const change = (fn: (d: SchematicDrawing) => SchematicDrawing) => commitHere((p) => updateDrawings(p, [drawing.id], fn))
  const d = drawing
  const setLook = (patch: Partial<TextLook> | null) =>
    change((x) => {
      if (x.type === "textbox") {
        const look: TextLook = patch === null ? {} : { ...x.look, ...patch }
        for (const k of Object.keys(look) as (keyof TextLook)[]) if (look[k] === undefined) delete look[k]
        const { look: _l, ...rest } = x
        void _l
        return Object.keys(look).length ? { ...rest, look } : rest
      }
      if (x.type !== "text" || patch === null) return x
      const next = { ...x }
      if ("size" in patch) next.size = patch.size ?? SCH_TEXT
      if ("bold" in patch) {
        if (patch.bold) next.bold = true
        else delete next.bold
      }
      if ("italic" in patch) {
        if (patch.italic) next.italic = true
        else delete next.italic
      }
      if ("color" in patch) {
        const stroke = { ...next.stroke }
        if (patch.color) stroke.color = patch.color
        else delete stroke.color
        if (Object.keys(stroke).length) next.stroke = stroke
        else delete next.stroke
      }
      return next
    })
  const setStroke = (patch: Partial<SheetStroke>) =>
    change((x) => {
      if (x.type === "text" || x.type === "image" || x.type === "table" || x.type === "junction" || x.type === "noconnect" || x.type === "directive") return x
      const stroke: SheetStroke = { ...x.stroke, ...patch }
      for (const k of Object.keys(stroke) as (keyof SheetStroke)[]) if (stroke[k] === undefined) delete stroke[k]
      return { ...x, stroke }
    })
  const hasText = d.type === "text" || d.type === "textbox"
  const hasStroke = d.type === "line" || d.type === "rect" || d.type === "circle" || d.type === "arc" || d.type === "bezier" || d.type === "textbox" || d.type === "bus" || d.type === "busentry"
  const stroke = hasStroke ? (d as { stroke?: SheetStroke }).stroke : undefined
  const look: TextLook | undefined = d.type === "text" ? lookOfText(d) : d.type === "textbox" ? d.look : undefined
  const turned = d.type === "text" ? d.rot === 90 || d.rot === 270 : d.type === "textbox" ? d.rot === 90 || d.rot === 270 : false
  return (
    <Section title={drawingKind(d)}>
      {hasText && (
        <Field label="Text">
          <textarea
            className="field mono min-h-[64px] py-1.5"
            defaultValue={d.type === "text" || d.type === "textbox" ? d.text : ""}
            key={d.id + (d.type === "text" || d.type === "textbox" ? d.text : "")}
            onBlur={(e) => {
              if ((d.type === "text" || d.type === "textbox") && e.target.value !== d.text) change((x) => (x.type === "text" || x.type === "textbox" ? { ...x, text: e.target.value } : x))
            }}
          />
        </Field>
      )}
      {(d.type === "text" || d.type === "textbox") && (
        <>
          <TextStyle look={look} onChange={setLook} />
          <div className="flex flex-wrap gap-1.5">
            <Button
              onClick={() => change((x) => (x.type === "text" || x.type === "textbox" ? { ...x, rot: turned ? 0 : 90 } : x))}
              title={d.type === "textbox" ? "Turn the text of the box (the box stays)" : "Turn the text between across and up"}
            >
              <RotateCw size={14} /> Turn
            </Button>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-ink">Leave out of simulation</span>
            <Switch label="Leave out of simulation" checked={!!d.excludeFromSim} onChange={(v) => change((x) => ({ ...x, excludeFromSim: v ? true : undefined }))} />
          </div>
        </>
      )}
      {hasStroke && (
        <>
          <Field label="Line width (mm)">
            <CommitInput mono type="number" step={0.0254} min={0} value={mm(stroke?.width, d.type === "bus" ? BUS_WIDTH : 0.012)} onCommit={(v) => Number.isFinite(Number(v)) && setStroke({ width: Number(v) > 0 ? Number(v) / MM : undefined })} />
          </Field>
          <Field label="Line style">
            <select className="field h-8" value={stroke?.dash ?? ""} onChange={(e) => setStroke({ dash: (e.target.value || undefined) as SheetStroke["dash"] })}>
              {DASHES.map((x) => (
                <option key={x.value} value={x.value}>
                  {x.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Line colour">
            <ColorField value={stroke?.color} fallback="#1d3fae" onCommit={(hex) => setStroke({ color: hex })} label="Line colour" />
          </Field>
        </>
      )}
      {d.type === "directive" && (
        <>
          <Field label="Net class">
            <CommitInput mono value={d.fields.find((f) => isNetclassFieldName(f.name))?.value ?? ""} onCommit={(v) => change((x) => (x.type === "directive" ? setDirectiveClass(x, v.trim()) : x))} />
          </Field>
          <Field label="Flag">
            <select className="field h-8" value={d.shape} onChange={(e) => change((x) => (x.type === "directive" ? setDirectiveShape(x, e.target.value as DirectiveShape) : x))}>
              {DIRECTIVE_SHAPES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Pin length (mm)">
            <CommitInput mono type="number" step={0.127} min={0} value={mm(d.length, 0.2)} onCommit={(v) => Number.isFinite(Number(v)) && change((x) => (x.type === "directive" ? setDirectiveLength(x, Number(v) / MM) : x))} />
          </Field>
          <div className="flex flex-wrap gap-1.5">
            <Button onClick={() => commitHere((p) => updateDrawings(p, [d.id], (x) => rotateDrawing(x)))} title="Turn the pin a quarter">
              <RotateCw size={14} /> Turn
            </Button>
          </div>
          <p className="text-[12px] text-ink-2">Put the flag's anchor on a wire or a pin and the net there is in this class; on the edge of a rule area, the nets inside it are. Other fields it has are kept.</p>
        </>
      )}
      {d.type === "line" && d.ruleArea && (
        <>
          {RULE_AREA_FLAGS.map((f) => (
            <div key={f.key} className="flex items-center justify-between">
              <span className="text-[13px] text-ink">{f.label}</span>
              <Switch label={f.label} checked={!!d.ruleArea?.[f.key]} onChange={(v) => change((x) => (x.type === "line" && x.ruleArea ? { ...x, ruleArea: withFlag(x.ruleArea, f.key, v) } : x))} />
            </div>
          ))}
          <p className="text-[12px] text-ink-2">Every part this area touches takes these flags (KiCad 10 reads them; a KiCad 9 file has them on the parts).</p>
        </>
      )}
      {d.type === "bus" && <p className="text-[12px] text-ink-2">A bus carries the nets its label names: put a label like D[0..7] or {"{"}A B{"}"} on it. A wire joins a member by a bus entry and a label of the member's name.</p>}
      {d.type === "busentry" && (
        <div className="flex flex-wrap gap-1.5">
          <Button onClick={() => change((x) => rotateDrawing(x))} title="Turn a quarter">
            <RotateCw size={14} /> Turn
          </Button>
        </div>
      )}
      {d.type === "junction" && (
        <>
          <Field label="Dot size (mm)">
            <CommitInput mono type="number" step={0.1} min={0} value={mm(d.diameter, 0.08)} onCommit={(v) => Number.isFinite(Number(v)) && change((x) => (x.type === "junction" ? { ...x, diameter: Number(v) > 0 ? Number(v) / MM : undefined } : x))} />
          </Field>
          <Field label="Dot colour">
            <ColorField value={d.dotColor} fallback="#1d3fae" onCommit={(hex) => change((x) => (x.type === "junction" ? { ...x, dotColor: hex } : x))} label="Dot colour" />
          </Field>
        </>
      )}
      {d.type === "image" && (
        <Field label="Scale">
          <CommitInput mono type="number" step={0.05} min={0.01} value={d.scale} onCommit={(v) => Number(v) > 0 && change((x) => (x.type === "image" ? { ...x, scale: Number(v) } : x))} />
        </Field>
      )}
      {d.type === "table" && <TableCells item={d} />}
      <div className="flex flex-wrap gap-1.5">
        <Button variant="danger" onClick={() => commitHere((p) => removeDrawings(p, [d.id]))}>
          <Trash2 size={14} /> Delete
        </Button>
      </div>
    </Section>
  )
}

/** Which style controls the selected drawings can take: not the shapes with no stroke (a junction dot, a no-connect flag, a picture, a table), a fill only closed shapes, a line only what is not a text. */
export function multiStyleControls(drawings: SchematicDrawing[]) {
  const styled = drawings.filter((d) => d.type !== "junction" && d.type !== "noconnect" && d.type !== "directive" && d.type !== "image" && d.type !== "table")
  return {
    ids: styled.map((d) => d.id),
    colour: styled.length > 0,
    fill: styled.some((d) => d.type !== "text" && (d.type !== "line" || !!d.closed)),
    line: styled.some((d) => d.type !== "text"),
  }
}

/**
 * Several drawings picked together, at least one of them from a KiCad file (or with an exact look): the colour, fill and line
 * of all of them, each changed in the way its own look allows (`applyStyle`: an exact drawing changes only the part named, a
 * drawing of the tools its named style). The shapes that take none are left as they are and their controls are not offered.
 */
export function ExactDrawingsInspector({ drawings }: { drawings: SchematicDrawing[] }) {
  const sch = useSch()
  const ids = drawings.map((d) => d.id)
  const can = multiStyleControls(drawings)
  const set = (patch: DrawingStyle) => commitHere((p) => updateDrawings(p, can.ids, (d) => applyStyle(d, patch)))
  return (
    <div>
      <Section
        title={`${drawings.length} drawings`}
        action={
          <Button variant="danger" onClick={() => commitHere((p) => removeDrawings(p, ids))}>
            <Trash2 size={14} /> Delete
          </Button>
        }
      >
        {can.colour && <Swatches label="Colour" value={undefined} colors={sch.drawing} onPick={(c) => set({ color: c ?? undefined })} />}
        {can.fill && <Swatches label="Fill" value={undefined} colors={sch.drawing} tint={sch.tint} none onPick={(c) => set({ fill: c ?? undefined })} />}
        {can.line && (
          <>
            <Group label="Line">
              <Segmented size="sm" value={"" as "medium"} onChange={(w) => set({ weight: w })} options={LINE_WEIGHTS.map((w) => ({ value: w, label: cap(w) }))} />
            </Group>
            <Segmented size="sm" value={"" as "solid"} onChange={(d) => set({ dash: d })} options={LINE_DASHES.map((d) => ({ value: d, label: cap(d) }))} />
          </>
        )}
        {!can.ids.length && <p className="text-[12px] text-ink-2">Dots, flags, pictures and tables have no colour or line to set here.</p>}
      </Section>
      <Section title="Arrange">
        <div className="flex flex-wrap gap-1.5">
          <Button onClick={() => commitHere((p) => reorderDrawings(p, ids, "front"))} title="Drawn over the other drawings">
            <BringToFront size={14} /> Bring to front
          </Button>
          <Button onClick={() => commitHere((p) => reorderDrawings(p, ids, "back"))} title="Drawn under the other drawings">
            <SendToBack size={14} /> Send to back
          </Button>
        </div>
      </Section>
    </div>
  )
}

/** The text of a table's cells, each editable. */
function TableCells({ item }: { item: DrawingTable }) {
  return (
    <div className="space-y-1.5">
      <Row label="Cells" value={`${item.cells.length} in ${item.columns} columns`} />
      {item.cells.slice(0, 24).map((c, i) => (
        <CommitInput
          key={i}
          mono
          value={textLines(c.text).join(" / ")}
          ariaLabel={`Cell ${i + 1}`}
          onCommit={(v) =>
            commitHere((p) => updateDrawings(p, [item.id], (it) => (it.type === "table" ? { ...it, cells: it.cells.map((x, j) => (j === i ? { ...x, text: v } : x)) } : it)))
          }
        />
      ))}
    </div>
  )
}

/** A group's lock. */
export function BlockLock({ block }: { block: SchematicBlock }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[13px] text-ink">Locked</span>
      <Switch label="Locked" checked={!!block.locked} onChange={(v) => commitHere((p) => setBlockLocked(p, block.id, v))} />
    </div>
  )
}

/** S1: a sheet symbol: its name, its flags and its pins. */
export function SheetSymbolInspector({ sym, project }: { sym: SheetSymbol; project: Project }) {
  const uses = sheetUses(project)
  const mine = uses.filter((u) => u.symbol?.id === sym.id)
  const missing = missingPins(project, sym.id)
  const flags = sym.flags ?? {}
  const flag = (key: "dnp" | "excludeFromBom" | "notOnBoard" | "excludeFromSim", label: string, on: (f: boolean) => boolean) => (
    <div className="flex items-center justify-between">
      <span className="text-[13px] text-ink">{label}</span>
      <Switch label={label} checked={on(!!flags[key])} onChange={(v) => commitHere((p) => setSheetSymbol(p, sym.id, { flags: { [key]: key === "excludeFromBom" || key === "notOnBoard" ? !v : v } }))} />
    </div>
  )
  const open = mine[0] ? () => uiApi().setSheet(mine[0].path) : undefined
  return (
    <div>
      <Section title="Sheet">
        <Field label="Name">
          <CommitInput value={sym.name} onCommit={(v) => v.trim() && commitHere((p) => setSheetSymbol(p, sym.id, { name: v.trim() }))} />
        </Field>
        <div className="flex flex-wrap gap-1.5">
          <Button onClick={open} disabled={!open} title="Show the sheet this symbol stands for (double-click it)">
            <FolderOpen size={14} /> Open
          </Button>
          <Button
            title="Draw this sheet again beside this symbol: the parts are copied, each with a reference of its own, and an edit to one is made to both"
            onClick={() =>
              commitHere((p) => {
                const box = { minX: sym.x + sym.w + 0.4, minY: sym.y, maxX: sym.x + sym.w * 2 + 0.4, maxY: sym.y + sym.h }
                const res = addSheetUse(p, p.scope ?? "", sym.child, box)
                return res ? res.project : p
              })
            }
          >
            <Copy size={14} /> Use again
          </Button>
          <Button
            variant="danger"
            title="Delete the symbol; a sheet nothing else uses goes with it, and says so"
            onClick={() => {
              const note = removalNote(project, [sym.id])
              commitHere((p) => removeSheetSymbols(p, [sym.id]))
              uiApi().clearSelection()
              if (note) uiApi().showNotice(note)
            }}
          >
            <Trash2 size={14} /> Delete
          </Button>
        </div>
      </Section>
      <Section title="Pins">
        {sym.pins.length === 0 && <p className="text-[12px] text-ink-2">No pins: the sheet is joined to this one only by global labels and power symbols.</p>}
        {sym.pins.map((pin) => (
          <div key={pin.id} className="flex items-center gap-1.5">
            <CommitInput mono value={pin.name} onCommit={(v) => v.trim() && commitHere((p) => setSheetPin(p, sym.id, pin.id, { name: v }))} />
            <select className="field h-8 w-[120px]" value={pin.shape} aria-label={`Shape of ${pin.name}`} onChange={(e) => commitHere((p) => setSheetPin(p, sym.id, pin.id, { shape: e.target.value as LabelShape }))}>
              {SHAPES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <Button onClick={() => commitHere((p) => removeSheetPin(p, sym.id, pin.id))} title="Remove the pin" aria-label={`Remove ${pin.name}`}>
              <Trash2 size={14} />
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap gap-1.5">
          <Button
            onClick={() => {
              const name = window.prompt("Pin name (the hierarchical label inside the sheet that it joins)")?.trim()
              if (name) commitHere((p) => addSheetPin(p, sym.id, name))
            }}
          >
            <Plus size={14} /> Add pin
          </Button>
          {missing.length > 0 && (
            <Button onClick={() => commitHere((p) => addMissingPins(p, sym.id))} title={missing.map((m) => m.name).join(", ")}>
              <Plus size={14} /> Pins for {missing.length} label{missing.length > 1 ? "s" : ""}
            </Button>
          )}
        </div>
        <p className="text-[12px] text-ink-2">A pin joins the hierarchical label of its name inside the sheet.</p>
      </Section>
      <Section title="Flags">
        {flag("dnp", "Do not populate", (v) => v)}
        {flag("excludeFromBom", "In the BOM", (v) => !v)}
        {flag("notOnBoard", "On the board", (v) => !v)}
        {flag("excludeFromSim", "Simulate", (v) => !v)}
        <p className="text-[12px] text-ink-2">A flag on a sheet is the flag of every part on it.</p>
      </Section>
    </div>
  )
}

/**
 * The sheet shown, when nothing on it is selected: what Altium's Properties panel shows of a document. Its name (the root's own, or its
 * symbol's), how many uses it has, and the way up to the sheet above.
 */
export function ShownSheetInspector({ project, path }: { project: Project; path: string }) {
  const use = useAt(project, shownPath(project, path))
  const uses = usesOfSheet(project, use.sheet).length
  const parent = use.parent !== null ? useAt(project, use.parent) : null
  return (
    <Section
      title="Sheet"
      navigation={
        parent && (
          <Button onClick={() => uiApi().setSheet(parent.path)} title="Show the sheet this one is on (⌥↑)">
            <ArrowUp size={14} /> Up to {parent.name}
          </Button>
        )
      }
    >
      <Field label="Name">
        <CommitInput value={use.name} onCommit={(v) => projectApi().commit((p) => renameSheetUse(p, use.path, v))} />
      </Field>
      {uses > 1 && <p className="text-[12px] text-ink-2">Used {uses} times. Each use has its own references and its own place on the board; an edit on one is made on every use.</p>}
    </Section>
  )
}
