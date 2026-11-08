import { commitHere, shownPath } from "../store/sheetScope"
import { ArrowDownToLine, ArrowUp, ArrowUpFromLine, BringToFront, Copy, FolderOpen, Plus, RotateCw, Scan, SendToBack, Trash2 } from "lucide-react"
import { useMemo, useState } from "react"
import { addSheetEntry, commitPort, deleteSheetSymbols, revealEntry, revealPort, reuseSheet } from "../editor/schematic/sheetActions"

import { useSch } from "../editor/theme"
import { setDirectiveClass, setDirectiveLength, setDirectiveShape, isNetclassFieldName } from "../model/directives"
import { applyStyle, drawingKind, LINE_DASHES, LINE_WEIGHTS, removeDrawings, reorderDrawings, rotateDrawing, updateDrawings } from "../model/drawings"
import { aliasLookup } from "../model/busConnectivity"
import { BusTooLarge, parseBusName, typedLabelName } from "../model/busNames"
import { setBlockLocked, setLabelStyle } from "../model/schematicEdit"
import { BUS_WIDTH, lookOfText, textLines } from "../model/sheetItems"
import { SCH_TEXT } from "../model/symbols"
import { isPortrait, ownTitleBlock, PAPER_LABEL, PAPER_SIZES, paperMm, paperOf, titleBlockOf, USER_PAPER_RANGE } from "../model/paper"
import { formatLength } from "../model/rules"
import {
  addMissingPins,
  fitSheetPaper,
  missingPins,
  removeSheetPin,
  renameSheetUse,
  setSheetPaper,
  setSheetPin,
  setSheetSymbol,
  setTitleField,
  type PaperPatch,
  type SheetSide,
  type TitleField,
} from "../model/sheetOps"
import { sheetUses, useAt, usesOfSheet } from "../model/sheets"
import { projectApi } from "../store/projectStore"
import { uiApi, useUi } from "../store/uiStore"
import type { DirectiveShape, PaperSize, RuleAreaMark, SheetPin, SheetSymbol, DrawingStyle, DrawingTable, LabelShape, NetLabel, Project, SchematicBlock, SchematicDrawing, SheetStroke, TextLook } from "../model/types"
import { getConnectivity } from "../store/analysis"
import { Button, Field, Segmented } from "../ui/controls"
import { ColorField, CommitInput, Group, LengthInput, Row, RuleGroup, Section, Switch, useLengthUnit } from "../ui/form"
import { cap, Swatches } from "./DrawingInspector"

// The Inspector for labels (a net label, a global label or a port, in Altium's words: its text, what it joins, its shape, and
// where something draws it its text style), sheet symbols and their entries, the sheet shown, what the importer brings (the
// drawings a KiCad sheet gave: text, text boxes, lines, shapes, pictures, tables, dots, flags, with exact controls) and a
// locked group. A part's flags are the Flags section of the part's Inspector (`Inspector.tsx`).

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

/**
 * Any label: its text (named as the project names what is typed, `typedLabelName`), what it joins (this sheet, every sheet, or the parent sheet's entry of its
 * name: a net label, a global label, a port) and its shape. A label switched to a port gets its entry on every symbol of its sheet. The text style is offered
 * where something draws it: a label with a kind, or any label of a KiCad project.
 */
export function LabelInspector({ l, project }: { l: NetLabel; project: Project }) {
  const shown = useUi((s) => s.sheet)
  const conn = getConnectivity(project)
  const net = conn.nets.find((n) => n.id === conn.labelNet.get(l.id))
  const set = (change: Parameters<typeof setLabelStyle>[2]) => commitHere((p) => setLabelStyle(p, l.id, change))
  const kind = l.kind === "global" ? "global" : l.kind === "hierarchical" ? "hierarchical" : "local"
  const kicad = !!project.netNames
  const use = useAt(project, shownPath(project, shown))
  // Main has no sheet above it: a label there can't become a port (one from a KiCad file may already be one).
  const portOff = use.parent === null && kind !== "hierarchical"
  const entry = kind === "hierarchical" ? use.symbol?.pins.find((q) => q.name.trim() === l.name.trim()) : undefined
  const setKind = (v: typeof kind) => {
    if (v === "hierarchical") commitPort((view) => setLabelStyle(view, l.id, { kind: v }), l.name, l.shape ?? "bidirectional")
    else set({ kind: v })
  }
  return (
    <Section
      title={kind === "global" ? "Global label" : kind === "hierarchical" ? "Port" : "Net label"}
      navigation={
        kind === "hierarchical" &&
        use.symbol && (
          <Button
            onClick={() => revealEntry(use.path, l.name)}
            disabled={!entry}
            title={entry ? `Show the entry ${l.name} on ${use.symbol.name}, on the sheet above` : `${use.symbol.name} has no entry ${l.name} on the sheet above`}
          >
            <ArrowUpFromLine size={14} /> Go to the sheet entry
          </Button>
        )
      }
    >
      <Field label="Text">
        <CommitInput
          mono
          value={l.name}
          onCommit={(v) => {
            const name = typedLabelName(project, v)
            if (name) set({ name })
          }}
        />
      </Field>
      <Field label="Joins">
        <Segmented
          size="sm"
          value={kind}
          options={[
            { value: "local", label: "This sheet", title: kicad ? "A local label: the net is /NAME" : "A net label: labels of its name on this sheet are one net" },
            { value: "global", label: "Every sheet", title: kicad ? "A global label: the net is NAME" : "A global label: labels of its name on every sheet are one net" },
            {
              value: "hierarchical",
              label: "Parent sheet",
              title: portOff ? "Main has no sheet above it to join" : "A port: joins the entry of its name on the sheet symbol that stands for this sheet",
              disabled: portOff,
            },
          ]}
          onChange={setKind}
        />
      </Field>
      <Field label="Shape">
        <select
          className="field h-8"
          value={kind === "local" ? "" : (l.shape ?? "bidirectional")}
          disabled={kind === "local"}
          title={kind === "local" ? "A net label has no direction: a global label and a port do" : undefined}
          onChange={(e) => set({ shape: e.target.value as LabelShape })}
        >
          {kind === "local" && <option value="">None</option>}
          {SHAPES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </Field>
      {(l.kind || kicad) && <TextStyle look={l.look} onChange={(look) => set({ look })} />}
      <div className="flex flex-wrap gap-1.5">
        <Button onClick={() => set({ turn: (((l.rot + 90) % 360) as NetLabel["rot"]) })} title="Turn a quarter">
          <RotateCw size={14} /> Turn
        </Button>
      </div>
      {net && <Row label="Net" value={net.name} mono />}
      {!net && <BusMembers text={l.name} project={project} />}
      <p className="text-[12px] text-ink-2">
        {kind === "global"
          ? "Every global label with this text is one net, on every sheet."
          : kind === "hierarchical"
            ? "Joins the sheet entry of this name on the sheet symbol above, and the labels with this text on this sheet."
            : kicad
              ? "Labels with this text on this sheet are one net, named /NAME."
              : "Every label with this text on this sheet is the same net."}
      </p>
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

const SIDES: { value: SheetSide; label: string }[] = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
  { value: "top", label: "Top" },
  { value: "bottom", label: "Bottom" },
]

/** The shape of a sheet entry, as a choice. */
function ShapeSelect({ pin, sym, label }: { pin: SheetPin; sym: SheetSymbol; label: string }) {
  return (
    <select className="field h-8 w-[120px]" value={pin.shape} aria-label={label} onChange={(e) => commitHere((p) => setSheetPin(p, sym.id, pin.id, { shape: e.target.value as LabelShape }))}>
      {SHAPES.map((s) => (
        <option key={s.value} value={s.value}>
          {s.label}
        </option>
      ))}
    </select>
  )
}

/** A sheet entry renamed, the name typed as the project names labels, so it meets its port. */
const renameEntry = (project: Project, sym: SheetSymbol, pin: SheetPin, typed: string) => {
  const name = typedLabelName(project, typed)
  if (name) commitHere((p) => setSheetPin(p, sym.id, pin.id, { name }))
}

/** A new entry typed in place, on the side chosen; Enter adds it with its port inside the sheet. */
function AddEntry({ sym, project }: { sym: SheetSymbol; project: Project }) {
  const [name, setName] = useState("")
  const [side, setSide] = useState<SheetSide>("left")
  const add = () => {
    const typed = typedLabelName(project, name)
    if (!typed) return
    addSheetEntry(sym.id, typed, side)
    setName("")
  }
  return (
    <div className="flex items-center gap-1.5">
      <input
        className="field mono h-8 min-w-0 flex-1"
        placeholder="New entry"
        aria-label="New entry name"
        value={name}
        onChange={(e) => setName(typedLabelName(project, e.target.value, true))}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return
          e.preventDefault()
          add()
        }}
      />
      <select className="field h-8 w-[88px]" aria-label="Side of the new entry" value={side} onChange={(e) => setSide(e.target.value as SheetSide)}>
        {SIDES.map((x) => (
          <option key={x.value} value={x.value}>
            {x.label}
          </option>
        ))}
      </select>
      <Button onClick={add} disabled={!name.trim()} title="Add the entry, and its port inside the sheet (Enter)">
        <Plus size={14} /> Add entry
      </Button>
    </div>
  )
}

/** S1: a sheet symbol: its name, its flags and its entries. */
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
          <Button title="Draw this sheet again beside this symbol: the parts are copied, each with a reference of its own, and an edit to one is made to both" onClick={() => reuseSheet(sym.id)}>
            <Copy size={14} /> Use again
          </Button>
          <Button variant="danger" title="Delete the symbol; a sheet nothing else uses goes with it, and says so" onClick={() => deleteSheetSymbols([sym.id])}>
            <Trash2 size={14} /> Delete
          </Button>
        </div>
      </Section>
      <Section title="Entries">
        {sym.pins.length === 0 && <p className="text-[12px] text-ink-2">No entries: the sheet is joined to this one only by global labels and power symbols.</p>}
        {sym.pins.map((pin) => (
          <div key={pin.id} className="flex items-center gap-1.5">
            <CommitInput mono ariaLabel={`Name of ${pin.name}`} value={pin.name} onCommit={(v) => renameEntry(project, sym, pin, v)} />
            <ShapeSelect pin={pin} sym={sym} label={`Shape of ${pin.name}`} />
            <Button onClick={() => commitHere((p) => removeSheetPin(p, sym.id, pin.id))} title="Remove the entry" aria-label={`Remove ${pin.name}`}>
              <Trash2 size={14} />
            </Button>
          </div>
        ))}
        <AddEntry sym={sym} project={project} />
        {missing.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <Button onClick={() => commitHere((p) => addMissingPins(p, sym.id))} title={missing.map((m) => m.name).join(", ")}>
              <Plus size={14} /> Entries for {missing.length} port{missing.length > 1 ? "s" : ""}
            </Button>
          </div>
        )}
        <p className="text-[12px] text-ink-2">An entry joins the port of its name inside the sheet.</p>
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

/** S1: one sheet entry: its name and shape, the symbol it is on, the way to its port inside the sheet, and Delete. */
export function SheetEntryInspector({ sym, pin, project }: { sym: SheetSymbol; pin: SheetPin; project: Project }) {
  const shown = useUi((s) => s.sheet)
  const path = shownPath(project, shown)
  return (
    <Section
      title="Sheet entry"
      navigation={
        <Button onClick={() => revealPort(path, sym.id, pin.id)} title={`Show the port ${pin.name} inside ${sym.name} (double-click the entry)`}>
          <ArrowDownToLine size={14} /> Go to the port
        </Button>
      }
    >
      <Field label="Name">
        <CommitInput mono value={pin.name} onCommit={(v) => renameEntry(project, sym, pin, v)} />
      </Field>
      <Field label="Shape">
        <ShapeSelect pin={pin} sym={sym} label="Shape" />
      </Field>
      <Row label="On" value={sym.name} />
      <div className="flex flex-wrap gap-1.5">
        <Button
          variant="danger"
          onClick={() => {
            commitHere((p) => removeSheetPin(p, sym.id, pin.id))
            uiApi().clearSelection()
          }}
        >
          <Trash2 size={14} /> Delete
        </Button>
      </div>
      <p className="text-[12px] text-ink-2">Joins the port of its name inside the sheet, and what is wired to it here.</p>
    </Section>
  )
}

const ORIENTATIONS = [
  { value: "landscape", label: "Landscape" },
  { value: "portrait", label: "Portrait" },
] as const

/**
 * The sheet shown, when nothing on it is selected: what Altium's Properties panel shows of a document. Its name (the root's own, or its
 * symbol's), how many uses it has, the way up to the sheet above, its page and its title block. The page and the title block are edits of the
 * whole project (`projectApi().commit`), not of the sheet shown: the page is stored on the sheet, which every use shares, and the title block's
 * fields are the project's name and properties, or a KiCad sub-sheet's own entries.
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
      <PageFields project={project} sheet={use.sheet} path={use.path} />
      <TitleBlockFields project={project} sheet={use.sheet} path={use.path} />
    </Section>
  )
}

/** The page of the sheet: its size (a named one, or a custom width and height), its orientation, and Fit to drawing. */
function PageFields({ project, sheet, path }: { project: Project; sheet: string; path: string }) {
  const unit = useLengthUnit()
  const paper = paperOf(project, sheet)
  const mm = paperMm(paper)
  const set = (patch: PaperPatch) => projectApi().commit((p) => setSheetPaper(p, sheet, patch))
  // Only a side typed here is held to the range: a custom page imported from KiCad outside it is kept as it came.
  const side = (key: "width" | "height") => (v: number | null) => {
    if (v === null) return
    if (v >= USER_PAPER_RANGE.min && v <= USER_PAPER_RANGE.max) set({ [key]: v })
    else uiApi().showNotice(`A side of a custom page is ${formatLength(USER_PAPER_RANGE.min, unit, true)} to ${formatLength(USER_PAPER_RANGE.max, unit, true)}.`)
  }
  return (
    <RuleGroup title="Page">
      <div className="space-y-2.5">
        <Field label="Size">
          <select className="field h-8" value={paper.size} onChange={(e) => set({ size: e.target.value as PaperSize })}>
            {PAPER_SIZES.map((s) => (
              <option key={s} value={s}>
                {PAPER_LABEL[s]}
              </option>
            ))}
          </select>
        </Field>
        {paper.size === "User" && (
          <div className="grid grid-cols-2 gap-2">
            <Field label="Width">
              <LengthInput ariaLabel="Page width" value={mm.width} onCommit={side("width")} />
            </Field>
            <Field label="Height">
              <LengthInput ariaLabel="Page height" value={mm.height} onCommit={side("height")} />
            </Field>
          </div>
        )}
        <Group label="Orientation">
          <Segmented size="sm" value={isPortrait(paper) ? "portrait" : "landscape"} options={[...ORIENTATIONS]} onChange={(v) => set({ portrait: v === "portrait" })} />
        </Group>
        <div className="flex flex-wrap gap-1.5">
          <Button onClick={() => projectApi().commit((p) => fitSheetPaper(p, path))} title="The smallest page of this family that holds the drawing, placed around it">
            <Scan size={14} /> Fit to drawing
          </Button>
        </div>
      </div>
    </RuleGroup>
  )
}

/**
 * The title block's fields: Title, Revision, Company and Drawn by to type in (`setTitleField` says where each is kept), and what the sheet
 * fills in itself (Sheet N of M, the size, the date) to read.
 */
function TitleBlockFields({ project, sheet, path }: { project: Project; sheet: string; path: string }) {
  const block = useMemo(() => titleBlockOf(project, path), [project, path])
  const own = !!ownTitleBlock(project, sheet)
  const field = (label: string, key: TitleField, value: string | undefined) => (
    <Field label={label}>
      <CommitInput value={value ?? ""} onCommit={(v) => projectApi().commit((p) => setTitleField(p, sheet, key, v))} />
    </Field>
  )
  return (
    <RuleGroup title="Title block">
      <div className="space-y-2.5">
        {field("Title", "title", block.title)}
        {field("Revision", "revision", block.revision)}
        {field("Company", "company", block.company)}
        {field("Drawn by", "drawnBy", block.drawnBy)}
        <div className="space-y-1">
          <Row label="Sheet" value={`${block.number} of ${block.count}`} />
          <Row label="Size" value={block.size} />
          {block.date && <Row label="Date" value={block.date} />}
        </div>
        {own && <p className="text-[12px] text-ink-2">This sheet keeps the title block it had in KiCad: its title, revision and company are its own. Drawn by is the project's.</p>}
      </div>
    </RuleGroup>
  )
}
