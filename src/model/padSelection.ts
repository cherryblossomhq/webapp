import { findPart } from "./library"
import { pcbPads, type WorldPad } from "./instances"
import type { CopperItem } from "./pcb"
import { copperLayers } from "./stack"
import type { ComponentInstance, Project } from "./types"

// A pad of a placed part, selected on its own: what the PCB editor's double-click list picks (`PickMenu`) where a pad is under the pointer with
// its part, as Altium lists a pad apart from its component. A click on a pad still picks the part, which is what a drag moves.

/** A pad's selection id, `pd:<component>:<index>`, the index in `pcbPads` (and in the analysis's `pad:<component>:<index>` items). */
export const padSelectionId = (componentId: string, index: number) => `pd:${componentId}:${index}`

export function parsePadSelectionId(id: string): { component: string; index: number } | null {
  if (!id.startsWith("pd:")) return null
  const at = id.lastIndexOf(":")
  const index = Number(id.slice(at + 1))
  return at > 3 && Number.isInteger(index) && index >= 0 ? { component: id.slice(3, at), index } : null
}

/** The index in `pcbPads` of an analysis pad item (`pad:<component>:<index>`, or `...@<layer>` for a layer of a pad stack). */
export function padItemIndex(itemId: string, componentId: string): number {
  return parseInt(itemId.slice(`pad:${componentId}:`.length), 10)
}

export interface SelectedPad {
  c: ComponentInstance
  index: number
  pad: WorldPad
  /** The net the analysis puts it on. */
  netId: string | null
  /** The name of its pin, where the part names it apart from its number. */
  pinName: string | null
}

/** The pad a selection id names, on the board as it is now; null when its part or its pad is gone. */
export function selectedPad(project: Project, items: readonly CopperItem[], id: string): SelectedPad | null {
  const at = parsePadSelectionId(id)
  if (!at) return null
  const c = project.components.find((x) => x.id === at.component)
  if (!c?.pcb.placed) return null
  const pad = pcbPads(c, copperLayers(project.board).length)[at.index]
  if (!pad) return null
  const key = `pad:${c.id}:${at.index}`
  const item = items.find((it) => it.kind === "pad" && (it.id === key || it.id.startsWith(`${key}@`)))
  const name = pad.pin ? findPart(c.partId)?.pins.find((p) => p.number === pad.pin)?.name : undefined
  return { c, index: at.index, pad, netId: item?.kind === "pad" ? item.netId : null, pinName: name && name !== pad.padNumber ? name : null }
}
