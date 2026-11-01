import { bareName, computeConnectivity, pinKey, type SchematicConnectivity } from "./connectivity"
import { powerNetName } from "./instances"
import { findPart } from "./library"
import { AUTO_NET_NAME, pinText } from "./merges"
import { isAutoNetName } from "./netNames"
import { renameNets } from "./tidy"
import type { Net, NetStyle, Project } from "./types"

// A net is a name its labels and ports carry, not a thing of its own: renaming one is renaming
// every label and port that gives it that name, and nothing else may change. An assistant renamed
// one by hand with a temporary name, a tidy and rewiring, where one call should do.

/** The net called `name`, by the name the connectivity gives it or the text its labels carry (`VBUS` for KiCad's `/VBUS`). */
export function findNet(conn: SchematicConnectivity, name: string): Net | undefined {
  const want = name.trim()
  return conn.nets.find((n) => n.name === want) ?? conn.nets.find((n) => (n.named || n.pins.length > 1) && bareName(n) === want)
}

/** Each pin's net, as sets of pins that share one: what a rename must leave as it found it. */
function partition(conn: SchematicConnectivity): Set<string> {
  const byNet = new Map<string, string[]>()
  for (const [key, id] of conn.pinNet) byNet.set(id, [...(byNet.get(id) ?? []), key])
  return new Set([...byNet.values()].filter((keys) => keys.length > 1).map((keys) => keys.sort().join(" ")))
}

/** A name the editor makes up for a net nobody named (`NET3`, `Net-(R1-Pad2)`), and renames as it pleases. */
export const isMadeUpName = (name: string) => AUTO_NET_NAME.test(name) || isAutoNetName(name)

/** What a name may not be: empty, or one the editor makes up and renames as it pleases. */
export function netNameProblem(name: string): string | null {
  const n = name.trim()
  if (!n) return "The new name is empty."
  if (/\s/.test(n)) return `"${n}" has a space in it; net names don't.`
  if (isMadeUpName(n)) return `"${n}" is a name the editor makes up for nets nobody named, and renames when it likes. Give the net a name that says what it is.`
  return null
}

/** Why `net` can't take the name `target`: a name the editor makes up, or one another net has (taking it would join the two). */
export function renameTargetProblem(project: Project, conn: SchematicConnectivity, net: Net, target: string): string | null {
  const problem = netNameProblem(target)
  if (problem) return problem
  const clash = conn.nets.find((n) => n.id !== net.id && (n.name === target || bareName(n) === target))
  if (!clash) return null
  const pins = clash.pins.slice(0, 4).map((p) => pinText(project, pinKey(p.componentId, p.pin)))
  return `${target} is already a net${pins.length ? ` (${pins.join(", ")})` : ""}: renaming ${net.named ? bareName(net) : net.name} to it would join the two. To join them, connect a pin of each with net_name ${target}.`
}

export type RenameResult = { project: Project; labels: number; ports: number; net: string } | { error: string }

/**
 * Rename the net called `from` to `to`: every label and power port on it that carries its name
 * takes the new one, and what the board keeps by the net's name (pours, vias, widths, net classes,
 * the copper's own net) and the style chosen for it follow. Refused, with nothing changed, when the
 * net has no name to change (a label gives it one), when another net already has the new one
 * (renaming would join them), or when the rename would move any pin to another net, as a hidden
 * power pin or a hierarchical label that joins by the old name would be left behind on it.
 */
export function renameNet(project: Project, from: string, to: string): RenameResult {
  const conn = computeConnectivity(project)
  const net = findNet(conn, from)
  if (!net) return { error: `No net is called ${from.trim()}.` }
  if (!net.named) return { error: `${net.name} has no name of its own yet` }
  const text = bareName(net)
  const target = to.trim()
  if (target === text && !netNameProblem(target)) return { project, labels: 0, ports: 0, net: net.name }
  const problem = renameTargetProblem(project, conn, net, target)
  if (problem) return { error: problem }

  const labels = new Set(project.labels.filter((l) => conn.labelNet.get(l.id) === net.id && l.name.trim() === text).map((l) => l.id))
  const ports = new Set(
    project.components
      .filter((c) => {
        const part = findPart(c.partId)
        return !!part?.powerNet && powerNetName(c, part) === text && part.pins.some((p) => conn.pinNet.get(pinKey(c.id, p.number)) === net.id)
      })
      .map((c) => c.id),
  )
  if (!labels.size && !ports.size) return { error: `${text} is named by something other than a label or a power port here (a hidden power pin, a sheet pin), so there is nothing to rename.` }
  let next: Project = {
    ...project,
    labels: project.labels.map((l) => (labels.has(l.id) ? { ...l, name: target } : l)),
    components: project.components.map((c) => (ports.has(c.id) ? { ...c, props: { ...c.props, net: target } } : c)),
  }

  const after = computeConnectivity(next)
  const was = partition(conn)
  const now = partition(after)
  if (was.size !== now.size || [...was].some((g) => !now.has(g))) {
    const moved = net.pins.filter((p) => after.pinNet.get(pinKey(p.componentId, p.pin)) !== after.pinNet.get(pinKey(net.pins[0].componentId, net.pins[0].pin)))
    const named = moved.slice(0, 4).map((p) => pinText(project, pinKey(p.componentId, p.pin)))
    return { error: `Renaming ${text} would split it${named.length ? `: ${named.join(", ")} would stay on ${text}` : ""}, since something other than its labels and ports (a hidden power pin, a hierarchical label, a label on another sheet) joins them by that name.` }
  }
  const first = net.pins[0]
  const renamed = first ? after.nets.find((n) => n.id === after.pinNet.get(pinKey(first.componentId, first.pin))) : undefined
  const newName = renamed?.name ?? target
  if (newName !== net.name) next = renameNets(next, { [net.name]: newName })
  const style = project.netStyles?.[text]
  if (style) next = setNetStyle(setNetStyle(next, text, null), target, style)
  return { project: next, labels: labels.size, ports: ports.size, net: newName }
}

/** Choose how Tidy draws the net named `name` (its label text), or leave it to Tidy with null. */
export function setNetStyle(project: Project, name: string, style: NetStyle | null): Project {
  const key = name.trim()
  if ((project.netStyles?.[key] ?? null) === style) return project
  const { [key]: _gone, ...rest } = project.netStyles ?? {}
  void _gone
  const styles = style ? { ...rest, [key]: style } : rest
  const { netStyles: _old, ...without } = project
  void _old
  return Object.keys(styles).length ? { ...without, netStyles: styles } : without
}
