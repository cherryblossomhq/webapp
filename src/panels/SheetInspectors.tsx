import { RotateCw } from "lucide-react"
import { isOnBoard } from "../model/instances"
import { findPart } from "../model/library"
import { setBlockLocked, setFlags, setLabelStyle, updateItem } from "../model/schematicEdit"
import { textLines } from "../model/sheetItems"
import type { ComponentInstance, LabelShape, NetLabel, Project, SchematicBlock, SheetItem, SheetStroke, TextLook } from "../model/types"
import { getConnectivity } from "../store/analysis"
import { projectApi } from "../store/projectStore"
import { Button, Field, Segmented } from "../ui/controls"
import { ColorField, CommitInput, Row, Section, Switch } from "../ui/form"

// The Inspector for what the importer brings: a label of KiCad's (its kind, shape, size and style), the
// items of the sheet (text, text boxes, drawings, pictures, tables, dots, flags), the flags of a symbol
// (do not populate, in the BOM, on the board, simulated), and a locked group.

const MM = 12.7
const mm = (units: number | undefined, fallback: number) => String(Math.round((units ?? fallback) * MM * 10000) / 10000)

const SHAPES: { value: LabelShape; label: string }[] = [
  { value: "input", label: "Input" },
  { value: "output", label: "Output" },
  { value: "bidirectional", label: "Bidirectional" },
  { value: "tri_state", label: "Tri-state" },
  { value: "passive", label: "Passive" },
]

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
  const set = (change: Parameters<typeof setLabelStyle>[2]) => projectApi().commit((p) => setLabelStyle(p, l.id, change))
  const kind = l.kind === "global" ? "global" : "local"
  return (
    <Section title={kind === "global" ? "Global label" : "Label"}>
      <Field label="Text">
        <CommitInput mono value={l.name} onCommit={(v) => v.trim() && set({ name: v.trim().replace(/\s+/g, "_") })} />
      </Field>
      <Field label="Joins">
        <Segmented
          size="sm"
          value={kind}
          options={[
            { value: "local", label: "This sheet", title: "A local label: the net is /NAME" },
            { value: "global", label: "Every sheet", title: "A global label: the net is NAME" },
          ]}
          onChange={(v) => set({ kind: v })}
        />
      </Field>
      {kind === "global" && (
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
      <p className="text-[12px] text-ink-2">{kind === "global" ? "Every global label with this text is one net, on every sheet." : "Labels with this text on this sheet are one net, named /NAME."}</p>
    </Section>
  )
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

const KIND_NAME: Record<SheetItem["kind"], string> = {
  text: "Text",
  textbox: "Text box",
  polyline: "Line",
  rectangle: "Rectangle",
  circle: "Circle",
  arc: "Arc",
  bezier: "Curve",
  image: "Picture",
  table: "Table",
  junction: "Junction dot",
  noconnect: "No-connect flag",
}

/** One item of the sheet. */
export function ItemInspector({ item }: { item: SheetItem }) {
  const set = (patch: Partial<SheetItem> | ((i: SheetItem) => SheetItem)) => projectApi().commit((p) => updateItem(p, item.id, patch))
  const setLook = (change: Partial<TextLook> | null) =>
    set((i) => {
      if (i.kind !== "text" && i.kind !== "textbox") return i
      if (change === null) {
        const { look: _l, ...rest } = i
        void _l
        return rest as SheetItem
      }
      const look: TextLook = { ...i.look, ...change }
      for (const k of Object.keys(look) as (keyof TextLook)[]) if (look[k] === undefined) delete look[k]
      const { look: _l, ...rest } = i
      void _l
      return (Object.keys(look).length ? { ...rest, look } : rest) as SheetItem
    })
  const setStroke = (change: Partial<SheetStroke>) =>
    set((i) => {
      if (!("stroke" in i) && i.kind !== "polyline" && i.kind !== "rectangle" && i.kind !== "circle" && i.kind !== "arc" && i.kind !== "bezier" && i.kind !== "textbox") return i
      const stroke: SheetStroke = { ...(i as { stroke?: SheetStroke }).stroke, ...change }
      for (const k of Object.keys(stroke) as (keyof SheetStroke)[]) if (stroke[k] === undefined) delete stroke[k]
      const { stroke: _s, ...rest } = i as SheetItem & { stroke?: SheetStroke }
      void _s
      return (Object.keys(stroke).length ? { ...rest, stroke } : rest) as SheetItem
    })
  const hasText = item.kind === "text" || item.kind === "textbox"
  const hasStroke = item.kind === "polyline" || item.kind === "rectangle" || item.kind === "circle" || item.kind === "arc" || item.kind === "bezier" || item.kind === "textbox"
  const stroke = hasStroke ? (item as { stroke?: SheetStroke }).stroke : undefined
  return (
    <Section title={KIND_NAME[item.kind]}>
      {hasText && (
        <Field label="Text">
          <textarea
            className="field mono min-h-[64px] py-1.5"
            defaultValue={item.kind === "text" || item.kind === "textbox" ? item.text : ""}
            key={item.id + (item.kind === "text" || item.kind === "textbox" ? item.text : "")}
            onBlur={(e) => {
              if ((item.kind === "text" || item.kind === "textbox") && e.target.value !== item.text) set({ text: e.target.value } as Partial<SheetItem>)
            }}
          />
        </Field>
      )}
      {(item.kind === "text" || item.kind === "textbox") && (
        <>
          <TextStyle look={item.look} onChange={(look) => setLook(look)} />
          <div className="flex flex-wrap gap-1.5">
            <Button onClick={() => set({ rot: item.rot === 90 || item.rot === 270 ? 0 : 90 } as Partial<SheetItem>)} title={item.kind === "textbox" ? "Turn the text of the box (the box stays)" : "Turn the text between across and up"}>
              <RotateCw size={14} /> Turn
            </Button>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-ink">Leave out of simulation</span>
            <Switch label="Leave out of simulation" checked={!!item.excludeFromSim} onChange={(v) => set({ excludeFromSim: v ? true : undefined } as Partial<SheetItem>)} />
          </div>
        </>
      )}
      {hasStroke && (
        <>
          <Field label="Line width (mm)">
            <CommitInput mono type="number" step={0.0254} min={0} value={mm(stroke?.width, 0.012)} onCommit={(v) => Number.isFinite(Number(v)) && setStroke({ width: Number(v) > 0 ? Number(v) / MM : undefined })} />
          </Field>
          <Field label="Line style">
            <select className="field h-8" value={stroke?.dash ?? ""} onChange={(e) => setStroke({ dash: (e.target.value || undefined) as SheetStroke["dash"] })}>
              {DASHES.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Line colour">
            <ColorField value={stroke?.color} fallback="#1d3fae" onCommit={(hex) => setStroke({ color: hex })} label="Line colour" />
          </Field>
        </>
      )}
      {item.kind === "junction" && (
        <>
          <Field label="Dot size (mm)">
            <CommitInput mono type="number" step={0.1} min={0} value={mm(item.diameter, 0.08)} onCommit={(v) => Number.isFinite(Number(v)) && set({ diameter: Number(v) > 0 ? Number(v) / MM : undefined } as Partial<SheetItem>)} />
          </Field>
          <Field label="Dot colour">
            <ColorField value={item.color} fallback="#1d3fae" onCommit={(hex) => set({ color: hex } as Partial<SheetItem>)} label="Dot colour" />
          </Field>
        </>
      )}
      {item.kind === "image" && (
        <Field label="Scale">
          <CommitInput mono type="number" step={0.05} min={0.01} value={item.scale} onCommit={(v) => Number(v) > 0 && set({ scale: Number(v) } as Partial<SheetItem>)} />
        </Field>
      )}
      {item.kind === "table" && <TableCells item={item} />}
    </Section>
  )
}

/** The text of a table's cells, each editable. */
function TableCells({ item }: { item: Extract<SheetItem, { kind: "table" }> }) {
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
            projectApi().commit((p) =>
              updateItem(p, item.id, (it) => (it.kind === "table" ? { ...it, cells: it.cells.map((x, j) => (j === i ? { ...x, text: v } : x)) } : it)),
            )
          }
        />
      ))}
    </div>
  )
}

/** The flags KiCad keeps on a symbol. */
export function FlagsSection({ c }: { c: ComponentInstance }) {
  const part = findPart(c.partId)
  if (!part || part.powerNet) return null
  const on = (v: boolean | undefined, dflt: boolean) => v ?? dflt
  const set = (change: Parameters<typeof setFlags>[2]) => projectApi().commit((p) => setFlags(p, c.id, change))
  // Leaving the board removes the unlocked traces and vias on the part's pads; the switch says so.
  const leaving = "Taking a part off the board also removes the unlocked traces and vias that touch its pads."
  const rows: [string, boolean, (v: boolean) => void, string?][] = [
    ["Do not populate", on(c.flags?.dnp, false), (v) => set({ dnp: v }), "Drawn and on the board, but left out of the bill of materials and the position file."],
    ["In the bill of materials", c.flags?.inBom !== false, (v) => set({ inBom: v })],
    ["On the board", c.flags?.onBoard !== false, (v) => set({ onBoard: v }), isOnBoard({ partId: c.partId, flags: undefined }) ? leaving : "This part has no footprint."],
    ["In the position file", c.flags?.inPosFiles !== false, (v) => set({ inPosFiles: v })],
    ["Left out of simulation", on(c.flags?.excludeFromSim, false), (v) => set({ excludeFromSim: v })],
  ]
  return (
    <Section title="Flags" id="flags">
      {rows.map(([label, value, onChange, hint]) => (
        <div key={label} title={hint} className="flex items-center justify-between">
          <span className="text-[13px] text-ink">{label}</span>
          <Switch label={label} checked={value} onChange={onChange} />
        </div>
      ))}
      {isOnBoard({ partId: c.partId, flags: undefined }) && <p className="text-[12px] text-ink-2">{leaving}</p>}
    </Section>
  )
}

/** A group's lock. */
export function BlockLock({ block }: { block: SchematicBlock }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[13px] text-ink">Locked</span>
      <Switch label="Locked" checked={!!block.locked} onChange={(v) => projectApi().commit((p) => setBlockLocked(p, block.id, v))} />
    </div>
  )
}
