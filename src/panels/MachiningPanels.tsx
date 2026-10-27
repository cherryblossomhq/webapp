import { protectionWords, viaProtection } from "../model/machining"
import { patchProtectRule, updateViaMachining, type MachiningPatch, type ProtectionPatch } from "../model/machiningOps"
import { copperLayers, layerLabel } from "../model/stack"
import type { Backdrill, CopperLayer, DesignRules, PostMachining, Project, Via, ViaProtection } from "../model/types"
import { projectApi } from "../store/projectStore"
import { Field } from "../ui/controls"
import { CommitInput, LengthInput, RuleRow, Switch } from "../ui/form"

// X22: the panels of a via's protection, backdrills and post-machining, the same controls for a pad's hole, and the board's protection rule. Every edit is one commit through machiningOps.

/** The things a via or a pad's hole can have done to it after it is drilled. */
export type HolePatch = Omit<MachiningPatch, "protect">
interface Hole {
  drill: number
  backdrill?: Backdrill
  tertiary?: Backdrill
  post?: { front?: PostMachining; back?: PostMachining }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const MIXED = "\u0000mixed"
/** What the holes share, or MIXED. */
function common<T>(holes: Hole[], pick: (h: Hole) => T): T | typeof MIXED {
  const first = pick(holes[0])
  return holes.every((h) => same(pick(h), first)) ? first : MIXED
}

/** Whether any via of the project says something of X22, or the board has a rule or a stackup of its own: the blocks are hidden for a board drawn in the editor. */
export function hasViaMachining(project: Project): boolean {
  return project.rules.viaProtect !== undefined || project.board.stack !== undefined || project.vias.some((v) => v.protect || v.backdrill || v.tertiary || v.post)
}

// ---------- via protection ----------

type PartKey = "fill" | "cap" | "coverFront" | "coverBack" | "plugFront" | "plugBack"
const PARTS: { key: PartKey; label: string; hint: string }[] = [
  { key: "fill", label: "Filling", hint: "The hole is filled" },
  { key: "cap", label: "Capping", hint: "The hole is filled and the end plated over" },
  { key: "coverFront", label: "Covering, front", hint: "Mask over the front end of the hole" },
  { key: "coverBack", label: "Covering, back", hint: "Mask over the back end of the hole" },
  { key: "plugFront", label: "Plugging, front", hint: "The front end of the hole is plugged" },
  { key: "plugBack", label: "Plugging, back", hint: "The back end of the hole is plugged" },
]

/** The part a via says for itself: true, false, or undefined where it follows the board. */
function ownPart(p: ViaProtection | undefined, key: PartKey): boolean | undefined {
  switch (key) {
    case "fill":
      return p?.fill
    case "cap":
      return p?.cap
    case "coverFront":
      return p?.cover?.front
    case "coverBack":
      return p?.cover?.back
    case "plugFront":
      return p?.plug?.front
    case "plugBack":
      return p?.plug?.back
  }
}

/** The board's rule for a part, off where it says nothing. */
const rulePart = (rules: DesignRules, key: PartKey): boolean => ownPart(rules.viaProtect, key) ?? false

const triValue = (v: boolean | undefined | typeof MIXED) => (v === MIXED ? "mixed" : v === undefined ? "" : v ? "yes" : "no")

/** Commits `make` for every via of `ids` (each with its own patch), as one undo step. */
function editVias(ids: string[], make: (via: Via) => MachiningPatch) {
  projectApi().commit((p) =>
    ids.reduce((acc, id) => {
      const via = acc.vias.find((v) => v.id === id)
      return via ? updateViaMachining(acc, [id], make(via)) : acc
    }, p),
  )
}

/** The protection, backdrills and post-machining of one or several vias. Hidden for a board that has none of it. */
export function ViaMachiningSection({ vias, project }: { vias: Via[]; project: Project }) {
  if (!vias.length || !hasViaMachining(project)) return null
  const ids = vias.map((v) => v.id)
  const layers = copperLayers(project.board)
  const effective = vias.map((v) => protectionWords(viaProtection(project.rules, v, project.board)).join(", ") || "none")
  const result = effective.every((w) => w === effective[0]) ? effective[0] : "differs between the vias"
  return (
    <div className="space-y-2.5 border-t border-line pt-2.5" aria-label="Via machining">
      <div className="text-[12px] font-medium uppercase tracking-wide text-ink-3">Protection</div>
      {PARTS.map((part) => {
        const own = vias.every((v) => ownPart(v.protect, part.key) === ownPart(vias[0].protect, part.key)) ? ownPart(vias[0].protect, part.key) : MIXED
        const rule = rulePart(project.rules, part.key)
        return (
          <Field key={part.key} label={part.label}>
            <select
              className="field h-8"
              aria-label={`Via ${part.label.toLowerCase()}`}
              title={part.hint}
              value={triValue(own)}
              onChange={(e) => {
                const v = e.target.value
                if (v === "mixed") return
                const patch: ProtectionPatch = { [part.key]: v === "" ? null : v === "yes" }
                editVias(ids, () => ({ protect: patch }))
              }}
            >
              {own === MIXED && (
                <option value="mixed" disabled>
                  Mixed
                </option>
              )}
              <option value="">{`Board's default (${rule ? "on" : "off"})`}</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </Field>
        )
      })}
      <p className="text-[12px] text-ink-2">{`Result: ${result}.`}</p>
      <HoleMachining
        holes={vias}
        layers={layers}
        layerName={(l) => layerLabel(project.board, l)}
        sides={{ front: "front", back: "back" }}
        edit={(make) => editVias(ids, (via) => make(via))}
      />
    </div>
  )
}

// ---------- backdrills and post-machining, for a via and a pad ----------

/** The backdrill, tertiary drill and post-machining of one or several holes. `edit` runs `make` on each hole and commits the result once. */
export function HoleMachining({
  holes,
  layers,
  layerName,
  sides,
  edit,
}: {
  holes: Hole[]
  layers: readonly CopperLayer[]
  layerName: (l: CopperLayer) => string
  sides: { front: string; back: string }
  edit: (make: (hole: Hole) => HolePatch) => void
}) {
  return (
    <>
      <DrillBlock title="Backdrill" kind="backdrill" holes={holes} layers={layers} layerName={layerName} edit={edit} />
      <DrillBlock title="Tertiary drill" kind="tertiary" holes={holes} layers={layers} layerName={layerName} edit={edit} />
      {(["front", "back"] as const).map((side) => (
        <PostBlock key={side} side={side} title={`Post-machining, ${sides[side]}`} holes={holes} edit={edit} />
      ))}
    </>
  )
}

/** A hole's size to start a drill with: a little over its own. */
const startSize = (drill: number) => Math.round((Math.max(drill, 0.2) + 0.2) * 100) / 100

function DrillBlock({
  title,
  kind,
  holes,
  layers,
  layerName,
  edit,
}: {
  title: string
  kind: "backdrill" | "tertiary"
  holes: Hole[]
  layers: readonly CopperLayer[]
  layerName: (l: CopperLayer) => string
  edit: (make: (hole: Hole) => HolePatch) => void
}) {
  const drills = holes.map((h) => h[kind])
  const mode = drills.every((d) => !d) ? "off" : drills.every((d) => d) && drills.every((d) => same(d, drills[0])) ? "on" : "mixed"
  const shown = mode === "on" ? drills[0]! : null
  // A backdrill runs from the front, a tertiary drill from the back.
  const start = (h: Hole): Backdrill => ({
    size: startSize(h.drill),
    from: kind === "backdrill" ? layers[0] : layers[layers.length - 1],
    to: kind === "backdrill" ? layers[1] : layers[Math.max(0, layers.length - 2)],
  })
  const change = (k: keyof Backdrill, value: number | CopperLayer) => edit((h) => (h[kind] ? { [kind]: { ...h[kind]!, [k]: value } } : {}))
  const layerSelect = (k: "from" | "to") => (
    <Field label={k === "from" ? "From" : "To"}>
      <select aria-label={`${title} ${k === "from" ? "from" : "to"}`} className="field h-8" value={shown![k]} onChange={(e) => change(k, e.target.value as CopperLayer)}>
        {layers.map((l) => (
          <option key={l} value={l}>
            {layerName(l)}
          </option>
        ))}
      </select>
    </Field>
  )
  return (
    <>
      <Field label={title}>
        <select
          aria-label={title}
          className="field h-8"
          value={mode}
          onChange={(e) => {
            if (e.target.value === "off") edit(() => ({ [kind]: null }))
            else if (e.target.value === "on") edit((h) => ({ [kind]: h[kind] ?? start(h) }))
          }}
        >
          {mode === "mixed" && (
            <option value="mixed" disabled>
              Mixed
            </option>
          )}
          <option value="off">Off</option>
          <option value="on">On</option>
        </select>
      </Field>
      {shown && (
        <div className="grid grid-cols-3 gap-2">
          <Field label="Size">
            <LengthInput ariaLabel={`${title} size`} min={0.05} value={shown.size} onCommit={(mm) => mm !== null && change("size", mm)} />
          </Field>
          {layerSelect("from")}
          {layerSelect("to")}
        </div>
      )}
    </>
  )
}

function PostBlock({ side, title, holes, edit }: { side: "front" | "back"; title: string; holes: Hole[]; edit: (make: (hole: Hole) => HolePatch) => void }) {
  const posts = holes.map((h) => h.post?.[side])
  const mode = posts.every((p) => !p) ? "none" : posts.every((p) => p && p.mode === posts[0]!.mode) ? posts[0]!.mode : "mixed"
  const all = common(holes, (h) => h.post?.[side])
  const shown = all !== MIXED ? all : undefined
  const change = (patch: Partial<PostMachining>) => edit((h) => (h.post?.[side] ? { post: { [side]: { ...h.post[side]!, ...patch } } } : {}))
  return (
    <>
      <Field label={title}>
        <select
          aria-label={title}
          className="field h-8"
          value={mode}
          onChange={(e) => {
            const v = e.target.value
            if (v === "none") edit(() => ({ post: { [side]: null } }))
            else if (v === "counterbore" || v === "countersink")
              edit((h) => {
                const own = h.post?.[side]
                if (own) return { post: { [side]: { ...own, mode: v } } }
                return { post: { [side]: { mode: v, size: startSize(h.drill) + 0.2, depth: 0.2, ...(v === "countersink" ? { angle: 90 } : {}) } } }
              })
          }}
        >
          {mode === "mixed" && (
            <option value="mixed" disabled>
              Mixed
            </option>
          )}
          <option value="none">None</option>
          <option value="counterbore">Counterbore</option>
          <option value="countersink">Countersink</option>
        </select>
      </Field>
      {shown && (
        <div className={`grid gap-2 ${shown.mode === "countersink" ? "grid-cols-3" : "grid-cols-2"}`}>
          <Field label="Size">
            <LengthInput ariaLabel={`${title} size`} optional placeholder="None" value={shown.size ?? null} onCommit={(mm) => change({ size: mm ?? 0 })} />
          </Field>
          <Field label="Depth">
            <LengthInput ariaLabel={`${title} depth`} optional placeholder="None" value={shown.depth ?? null} onCommit={(mm) => change({ depth: mm ?? 0 })} />
          </Field>
          {shown.mode === "countersink" && (
            <Field label="Angle">
              <CommitInput
                type="number"
                min={0}
                step={1}
                mono
                ariaLabel={`${title} angle`}
                value={shown.angle ?? ""}
                placeholder="degrees"
                onCommit={(v) => Number.isFinite(Number(v)) && Number(v) >= 0 && change({ angle: Number(v) })}
              />
            </Field>
          )}
        </div>
      )}
    </>
  )
}

// ---------- the board's own rule ----------

/** The switches for the board's via protection rule, which a via that says nothing follows. */
export function ViaProtectRules({ project }: { project: Project }) {
  if (!hasViaMachining(project)) return null
  const r = project.rules
  const on = (key: PartKey) => rulePart(r, key)
  const toggle = (key: PartKey, value: boolean) => projectApi().commit((p) => ({ ...p, updatedAt: Date.now(), rules: patchProtectRule(p.rules, { [key]: value } as ProtectionPatch) }))
  return (
    <>
      {PARTS.map((part) => (
        <RuleRow key={part.key} label={`Via ${part.label.toLowerCase()}`} hint={`${part.hint}, for every via that does not say its own`}>
          <Switch label={`Rule: ${part.label.toLowerCase()}`} checked={on(part.key)} onChange={(v) => toggle(part.key, v)} />
        </RuleRow>
      ))}
    </>
  )
}
