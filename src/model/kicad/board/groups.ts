// Ported from KiCad (https://gitlab.com/kicad/code/kicad): `PCB_IO_KICAD_SEXPR_PARSER::resolveGroups` (pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr_parser.cpp,
// master line 1662) and `EDA_GROUP::AddItem` (common/eda_group.cpp): a group lists the ids of its members, the ids are resolved once the whole file is read, in the
// file's order, and an id that names nothing is skipped. An item is in one group at a time, so a group that lists an item another one holds takes it from that one; a
// group is never added to itself or to a group it is inside of.
// Copyright The KiCad Developers, see AUTHORS.txt for contributors. This program source code file is part of KiCad, a free EDA CAD application. This program is free
// software; you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation; either version 2
// of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the
// implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details. You should have received a copy of
// the GNU General Public License along with this program; if not, see <https://www.gnu.org/licenses/>.

import type { PcbGroup } from "../../types"
import type { KicadGroup } from "./types"

/** What became of the members the file lists. */
export interface GroupStats {
  /** Members that name nothing in the file (or, for a part's group, nothing of that part): KiCad skips them as well. */
  unresolved: number
  /** Members that are something the project does not hold (a zone, an arc track). */
  notBrought: number
  /** Members that a later group took from the group that held them first (an item is in one group). */
  moved: number
  /** Members KiCad refuses: a group in itself, or in a group that is inside it. */
  refused: number
  /** Groups left with nothing in them, which KiCad writes no node for. */
  empty: number
}

export const newGroupStats = (): GroupStats => ({ unresolved: 0, notBrought: 0, moved: 0, refused: 0, empty: 0 })

type Member = { item: string } | { group: number }

function simulate(raw: KicadGroup[], refs: Map<string, string[]>, stats: GroupStats): { held: Member[][]; parent: Map<string, number> } {
  const byUuid = new Map<string, number>()
  raw.forEach((g, i) => g.uuid !== null && !byUuid.has(g.uuid) && byUuid.set(g.uuid, i))
  const held: Member[][] = raw.map(() => [])
  /** Which group holds an item (by project id) or a group (by index, as `g<i>`). */
  const parent = new Map<string, number>()
  const keyOf = (m: Member) => ("item" in m ? m.item : `#g${m.group}`)
  /** Whether group `inner` is inside group `outer`, at any depth (`EDA_GROUP::ContainsItem`). */
  const inside = (inner: number, outer: number): boolean => {
    for (let at = parent.get(`#g${inner}`); at !== undefined; at = parent.get(`#g${at}`)) if (at === outer) return true
    return false
  }
  const add = (to: number, m: Member) => {
    if ("group" in m && (m.group === to || inside(to, m.group))) {
      stats.refused++
      return
    }
    const key = keyOf(m)
    const was = parent.get(key)
    if (was !== undefined) {
      held[was] = held[was].filter((x) => keyOf(x) !== key)
      stats.moved++
    }
    held[to].push(m)
    parent.set(key, to)
  }
  raw.forEach((g, i) => {
    for (const uuid of g.members) {
      const child = byUuid.get(uuid)
      if (child !== undefined) {
        add(i, { group: child })
        continue
      }
      const ids = refs.get(uuid)
      if (ids === undefined) stats.unresolved++
      else if (!ids.length) stats.notBrought++
      else for (const id of ids) add(i, { item: id })
    }
  })
  return { held, parent }
}

/** The group (by its place in the file) that holds each id the file lists, after the groups have taken items from each other: what a track is joined with its neighbours by. */
export function groupParents(raw: KicadGroup[]): Map<string, number> {
  const refs = new Map<string, string[]>()
  for (const g of raw) for (const m of g.members) refs.set(m, [m])
  return simulate(raw, refs, newGroupStats()).parent
}

/**
 * The groups of a file as the project's: `refs` says what each id of the file is in the project (a list of project ids, empty for something the project
 * does not hold) and has no entry for an id that names nothing. A group's members come out in the file's order, a member that is a group as that group's id.
 */
export function resolveGroups(raw: KicadGroup[], refs: Map<string, string[]>, defaultId: (place: number) => string, stats: GroupStats): PcbGroup[] {
  const { held } = simulate(raw, refs, stats)
  // A group with nothing in it, or only groups with nothing in them, is not kept.
  const alive = new Array<boolean | undefined>(raw.length)
  const lives = (i: number): boolean => (alive[i] ??= held[i].some((m) => ("item" in m ? true : lives(m.group))))
  const kept = raw.map((_, i) => i).filter((i) => lives(i))
  stats.empty += raw.length - kept.length
  const finalId = new Map<number, string>()
  kept.forEach((i, place) => finalId.set(i, defaultId(place)))
  return kept.map((i): PcbGroup => {
    const g = raw[i]
    return {
      id: finalId.get(i)!,
      name: g.name,
      members: held[i].flatMap((m) => ("item" in m ? [m.item] : finalId.has(m.group) ? [finalId.get(m.group)!] : [])),
      ...(g.locked ? { locked: true as const } : {}),
      ...(g.libId !== null ? { lib: g.libId } : {}),
    }
  })
}
