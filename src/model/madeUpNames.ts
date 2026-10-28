import type { SchematicConnectivity } from "./connectivity"
import { getConnectivity, sameSchematic } from "./connectivityCache"
import { AUTO_NET_NAME } from "./merges"
import type { Project } from "./types"

/** Whether two connectivities put the pins in the same groups, whatever the nets are called. */
function samePinGroups(a: SchematicConnectivity, b: SchematicConnectivity): boolean {
  if (a.pinNet.size !== b.pinNet.size) return false
  const there = new Map<string, string>()
  const back = new Map<string, string>()
  for (const [key, x] of a.pinNet) {
    const y = b.pinNet.get(key)
    if (!y || (there.get(x) ?? y) !== y || (back.get(y) ?? x) !== x) return false
    there.set(x, y)
    back.set(y, x)
  }
  return true
}

/** The nets each label is on, in every use of its sheet (a sheet used twice has its labels on a net in each). */
function labelNets(conn: SchematicConnectivity): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const uses of conn.byUse ? [...conn.byUse.labelNet.values()] : [conn.labelNet]) {
    for (const [id, net] of uses) out.set(id, (out.get(id) ?? new Set()).add(net))
  }
  return out
}

/** The one name every net of a label gives it, or null when they give none or disagree. */
function oneName(nets: Set<string> | undefined, nameOf: (net: string) => string | undefined): string | null {
  const names = new Set([...(nets ?? [])].map(nameOf))
  const [name] = names
  return names.size === 1 && name ? name : null
}

/**
 * A name `connect` made up (`NET3`) says nothing of what its net is: once an edit joins that net to a name, its labels take the
 * name, so one net is not written two ways and Checks has no "Net names merged" to say about it. `connect` does this for the joins
 * it draws (`settleNames` in `attach.ts`); this does it for every other edit (a power port put on a pin, a part moved or replaced, a
 * wire drawn by hand), run by the store on each commit.
 *
 * - A net the edit joined to a name, or named a label on, is settled: its made-up labels take the one name someone chose (else the
 *   first made-up one). A net that already had these names and was not touched, and one where two chosen names meet (a short,
 *   which Checks must show), are left as they are.
 * - A made-up label renamed by hand to another name its net had takes the other labels of its old name on that net with it. Labels
 *   join by name, so renaming one of two `NET1` labels would otherwise cut the net in two.
 *
 * A label the edit itself named, and hierarchical and global labels (which join other sheets by their text), keep their names, and
 * a settling that would change what is connected (beyond putting back what renaming one label cut) is not made.
 */
export function settleMadeUpNames(before: Project, after: Project): Project {
  if (!after.labels.some((l) => AUTO_NET_NAME.test(l.name.trim()))) return after
  if (sameSchematic(before, after)) return after
  const was = getConnectivity(before)
  const now = getConnectivity(after)
  const wasName = new Map(before.labels.map((l) => [l.id, l.name]))
  const renamedHere = after.labels.filter((l) => wasName.has(l.id) && wasName.get(l.id) !== l.name)
  const wasNets = labelNets(was)
  const nowNets = labelNets(now)

  // Joins: the name each net that the edit joined or worked on keeps.
  const had = new Set(was.conflicts.map((c) => c.names.join()))
  const touched = new Set(after.labels.filter((l) => wasName.get(l.id) !== l.name).flatMap((l) => [...(nowNets.get(l.id) ?? [])]))
  const target = new Map<string, string>()
  for (const c of now.conflicts) {
    if (had.has(c.names.join()) && !touched.has(c.netId)) continue
    const chosen = c.names.filter((n) => !AUTO_NET_NAME.test(n))
    if (chosen.length <= 1) target.set(c.netId, chosen[0] ?? c.names[0])
  }

  // Renames by hand: a made-up name on a net that had another name, renamed to it, by net and old name.
  const wasNames = new Map(was.conflicts.map((c) => [c.netId, c.names]))
  const follow = new Map<string, string>()
  for (const l of renamedHere) {
    const old = wasName.get(l.id)!.trim()
    const name = l.name.trim()
    if (!AUTO_NET_NAME.test(old)) continue
    for (const net of wasNets.get(l.id) ?? []) if (wasNames.get(net)?.includes(name)) follow.set(`${net}|${old}`, name)
  }
  if (!target.size && !follow.size) return after

  let followed = false
  let renamed = false
  const labels = after.labels.map((l) => {
    const name = l.name.trim()
    if (!AUTO_NET_NAME.test(name) || (l.kind && l.kind !== "local") || wasName.get(l.id) !== l.name) return l
    const along = oneName(wasNets.get(l.id), (net) => follow.get(`${net}|${name}`))
    const to = along ?? oneName(nowNets.get(l.id), (net) => target.get(net))
    if (!to || to === name) return l
    followed ||= !!along
    renamed = true
    return { ...l, name: to }
  })
  if (!renamed) return after
  const next = { ...after, labels }
  const groups = getConnectivity(next)
  return samePinGroups(now, groups) || (followed && samePinGroups(was, groups)) ? next : after
}
