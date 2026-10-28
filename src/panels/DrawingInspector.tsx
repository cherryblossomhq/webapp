import { commitHere } from "../store/sheetScope"
import { Bold, BringToFront, Code, Italic, SendToBack, Trash2 } from "lucide-react"
import { useEffect, useState } from "react"
import { useSch } from "../editor/theme"
import {
  CORNER_RADII,
  DRAWING_COLORS,
  drawingKind,
  LINE_DASHES,
  LINE_WEIGHTS,
  removeDrawings,
  reorderDrawings,
  SCH_UNIT_MM,
  TEXT_SIZE_RANGE,
  TEXT_SIZES,
  updateDrawings,
} from "../model/drawings"
import type { DrawingBox, DrawingColor, DrawingLine, DrawingStyle, DrawingText, SchematicDrawing } from "../model/types"
import { uiApi } from "../store/uiStore"
import { Button, IconButton, Segmented } from "../ui/controls"
import { Group, LengthInput, Section, Switch } from "../ui/form"

type TextPatch = Partial<Pick<DrawingText, "text" | "size" | "align" | "bold" | "italic" | "mono" | "border">>
type LinePatch = Partial<Pick<DrawingLine, "arrows" | "closed">>

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** The value every drawing shares, or undefined when they differ or there are none. */
function shared<D extends SchematicDrawing, T>(drawings: D[], get: (d: D) => T): T | undefined {
  if (!drawings.length) return undefined
  const first = get(drawings[0])
  return drawings.every((d) => get(d) === first) ? first : undefined
}

/** Takes a fill: closed shapes and texts, not an open line. */
const fillable = (d: SchematicDrawing) => d.type !== "line" || !!d.closed

/**
 * The selected drawings: their colour, fill and line, and what only texts, lines and rectangles
 * have. A colour, fill, line or border set here is also what the next drawing of its kind starts with.
 */
export function DrawingInspector({ drawings }: { drawings: SchematicDrawing[] }) {
  const sch = useSch()
  const ids = drawings.map((d) => d.id)
  const one = drawings.length === 1 ? drawings[0] : null
  const texts = drawings.filter((d): d is DrawingText => d.type === "text")
  const lines = drawings.filter((d): d is DrawingLine => d.type === "line")
  const rects = drawings.filter((d): d is DrawingBox => d.type === "rect")
  const allTexts = texts.length === drawings.length

  const change = (fn: (d: SchematicDrawing) => SchematicDrawing) => commitHere((p) => updateDrawings(p, ids, fn))

  const setStyle = (patch: DrawingStyle) => {
    // An open line keeps no fill, even when it is picked with shapes that take one.
    change((d) => ({ ...d, ...patch, ...("fill" in patch && !fillable(d) && { fill: d.fill }) }))
    if (texts.length) uiApi().setDrawDefaults("text", patch)
    if (texts.length < drawings.length) uiApi().setDrawDefaults("shape", patch)
  }
  // A note's look carries to the next text, its typography doesn't: one title doesn't make every text a title.
  const setText = (patch: TextPatch) => {
    change((d) => (d.type === "text" ? { ...d, ...patch } : d))
    if (patch.border !== undefined) uiApi().setDrawDefaults("text", { border: patch.border })
  }
  const setLine = (patch: LinePatch) => change((d) => (d.type === "line" ? { ...d, ...patch } : d))

  const color = shared(drawings, (d) => d.color ?? "ink")
  const fill = shared(drawings.filter(fillable), (d) => d.fill ?? null)
  const weight = shared(drawings, (d) => d.weight ?? "medium")
  const dash = shared(drawings, (d) => d.dash ?? "solid")
  // A text's outline only shows with its border on, so its line settings wait for that.
  const outlined = drawings.some((d) => d.type !== "text" || d.border)

  const style = (
    <>
      <Swatches label={allTexts ? "Text colour" : "Colour"} value={color} colors={sch.drawing} onPick={(c) => setStyle({ color: c ?? undefined })} />
      {drawings.some(fillable) && (
        <Swatches label={allTexts ? "Background" : "Fill"} value={fill} colors={sch.drawing} tint={sch.tint} none onPick={(c) => setStyle({ fill: c ?? undefined })} />
      )}
      {outlined && (
        <>
          <Group label="Line">
            <Segmented
              size="sm"
              value={weight ?? ("" as "medium")}
              onChange={(w) => setStyle({ weight: w })}
              options={LINE_WEIGHTS.map((w) => ({ value: w, label: cap(w) }))}
            />
          </Group>
          <Segmented size="sm" value={dash ?? ("" as "solid")} onChange={(d) => setStyle({ dash: d })} options={LINE_DASHES.map((d) => ({ value: d, label: cap(d) }))} />
        </>
      )}
      {rects.length > 0 && (
        <Group label="Corners">
          <Segmented
            size="sm"
            value={CORNER_RADII.find((c) => c.radius === shared(rects, (d) => d.radius ?? 0))?.id ?? ("" as "none")}
            onChange={(id) => change((d) => (d.type === "rect" ? { ...d, radius: CORNER_RADII.find((c) => c.id === id)!.radius } : d))}
            options={CORNER_RADII.map((c) => ({ value: c.id, label: c.label }))}
          />
        </Group>
      )}
      {lines.length > 0 && (
        <>
          {lines.some((l) => !l.closed) && (
            <Group label="Arrows">
              <Segmented
                size="sm"
                value={shared(lines, (d) => d.arrows ?? "none") ?? ("" as "none")}
                onChange={(a) => setLine({ arrows: a === "none" ? undefined : a })}
                options={(["none", "start", "end", "both"] as const).map((a) => ({ value: a, label: cap(a) }))}
              />
            </Group>
          )}
          {lines.every((l) => l.points.length > 2) && (
            <div className="flex items-center justify-between">
              <span className="text-[12.5px] text-ink-2">Closed</span>
              <Switch label="Closed" checked={lines.every((l) => l.closed)} onChange={(closed) => setLine({ closed })} />
            </div>
          )}
        </>
      )}
    </>
  )

  return (
    <div>
      <Section
        title={one ? drawingKind(one) : `${drawings.length} drawings`}
        action={
          <IconButton
            label={one ? `Delete ${drawingKind(one).toLowerCase()}` : "Delete drawings"}
            shortcut="Del"
            className="h-7 w-7 hover:bg-danger-soft hover:text-danger"
            onClick={() => {
              commitHere((p) => removeDrawings(p, ids))
              uiApi().clearSelection()
            }}
          >
            <Trash2 size={14} />
          </IconButton>
        }
      >
        {one?.type === "text" && <TextContent key={one.id} text={one.text} onCommit={(text) => setText({ text })} />}
        {texts.length > 0 && (
          <>
            <TextSizeField sizes={texts.map((t) => t.size)} onSize={(size) => setText({ size })} />
            <div className="flex items-center gap-1.5">
              <Segmented
                size="sm"
                value={shared(texts, (d) => d.align ?? "left") ?? ("" as "left")}
                onChange={(align) => setText({ align })}
                options={(["left", "center", "right"] as const).map((a) => ({ value: a, label: cap(a), title: `Align ${a}` }))}
              />
              <span className="flex-1" />
              <IconButton label="Bold" active={texts.every((t) => t.bold)} onClick={() => setText({ bold: !texts.every((t) => t.bold) })} className="h-7 w-7">
                <Bold size={14} />
              </IconButton>
              <IconButton label="Italic" active={texts.every((t) => t.italic)} onClick={() => setText({ italic: !texts.every((t) => t.italic) })} className="h-7 w-7">
                <Italic size={14} />
              </IconButton>
              <IconButton label="Monospace" active={texts.every((t) => t.mono)} onClick={() => setText({ mono: !texts.every((t) => t.mono) })} className="h-7 w-7">
                <Code size={14} />
              </IconButton>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[12.5px] text-ink-2">Border</span>
              <Switch label="Border" checked={texts.every((t) => t.border)} onChange={(border) => setText({ border })} />
            </div>
          </>
        )}
        {!texts.length && style}
      </Section>

      {texts.length > 0 && <Section title="Style">{style}</Section>}

      <Section title="Arrange">
        <div className="flex flex-wrap gap-1.5">
          <Button onClick={() => commitHere((p) => reorderDrawings(p, ids, "front"))} title="Drawn over the other drawings">
            <BringToFront size={14} /> Bring to front
          </Button>
          <Button onClick={() => commitHere((p) => reorderDrawings(p, ids, "back"))} title="Drawn under the other drawings">
            <SendToBack size={14} /> Send to back
          </Button>
        </div>
        <p className="text-[12px] text-ink-2">Drawings sit under the circuit and are never connected to it. Drag a handle to resize; R turns.</p>
      </Section>
    </div>
  )
}

/**
 * The size of the selected texts as a length, in the Inspector's unit (mm or mil), with the named sizes
 * beside it to pick from; the list says Custom for a size none of them is, and Mixed for texts that differ.
 */
function TextSizeField({ sizes, onSize }: { sizes: number[]; onSize: (size: number) => void }) {
  const size = sizes.every((s) => s === sizes[0]) ? sizes[0] : undefined
  const preset = size === undefined ? undefined : TEXT_SIZES.find((s) => Math.abs(s.size - size) < 1e-6)
  return (
    <Group label="Size">
      <div className="flex items-center gap-1.5">
        <LengthInput
          ariaLabel="Text size"
          className="min-w-0 flex-1"
          min={TEXT_SIZE_RANGE.min * SCH_UNIT_MM}
          value={size === undefined ? null : size * SCH_UNIT_MM}
          placeholder={size === undefined ? "Mixed" : undefined}
          onCommit={(mm) => mm !== null && onSize(Math.min(TEXT_SIZE_RANGE.max, mm / SCH_UNIT_MM))}
        />
        <select className="field h-8 w-[96px]" aria-label="Named text size" value={preset?.id ?? ""} onChange={(e) => onSize(TEXT_SIZES.find((s) => s.id === e.target.value)!.size)}>
          {!preset && <option value="">{size === undefined ? "Mixed" : "Custom"}</option>}
          {TEXT_SIZES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
    </Group>
  )
}

/** A text's lines, saved when the field is left. Enter is a new line here; the canvas's in-place editor uses it to finish. */
function TextContent({ text, onCommit }: { text: string; onCommit: (text: string) => void }) {
  const [draft, setDraft] = useState(text)
  useEffect(() => setDraft(text), [text])
  return (
    <textarea
      aria-label="Text"
      className="field min-h-[64px] resize-y py-1.5 leading-snug"
      value={draft}
      rows={Math.min(8, Math.max(2, draft.split("\n").length))}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const next = draft.replace(/\s+$/, "")
        if (next.trim() && next !== text) onCommit(next)
        else setDraft(text)
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setDraft(text)
          ;(e.target as HTMLTextAreaElement).blur()
        }
      }}
    />
  )
}

/** A row of the drawing colours, as they show on this sheet; `none` adds a swatch for no colour at all. */
export function Swatches({
  label,
  value,
  colors,
  tint,
  none = false,
  onPick,
}: {
  label: string
  value: DrawingColor | null | undefined
  colors: Record<DrawingColor, string>
  tint?: number
  none?: boolean
  onPick: (c: DrawingColor | null) => void
}) {
  const ring = (on: boolean) => (on ? "ring-2 ring-select ring-offset-1 ring-offset-surface" : "hover:scale-110")
  return (
    <Group label={label}>
      <div className="flex flex-wrap items-center gap-1.5">
        {none && (
          <button
            type="button"
            aria-label={`${label}: none`}
            aria-pressed={value === null}
            title="None"
            onClick={() => onPick(null)}
            className={`relative h-5 w-5 overflow-hidden rounded-full border border-line bg-surface transition-transform ${ring(value === null)}`}
          >
            <span className="absolute left-1/2 top-[-2px] h-[24px] w-px -translate-x-1/2 rotate-45 bg-danger" />
          </button>
        )}
        {DRAWING_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`${label}: ${c}`}
            aria-pressed={value === c}
            title={cap(c)}
            onClick={() => onPick(c)}
            className={`relative h-5 w-5 overflow-hidden rounded-full border border-line transition-transform ${ring(value === c)}`}
          >
            <span className="absolute inset-0" style={{ background: colors[c], opacity: tint ?? 1 }} />
            {tint !== undefined && <span className="absolute inset-[5px] rounded-full" style={{ background: colors[c] }} />}
          </button>
        ))}
      </div>
    </Group>
  )
}
