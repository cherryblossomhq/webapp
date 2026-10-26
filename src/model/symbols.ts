import { emptyBox, expandBox, round } from "../lib/geometry"
import type { Rotation, SymbolDef, SymbolPort, SymbolPrimitive, TextAnchor } from "./types"

/** The schematic grid. 0.1 is KiCad's 50 mil, so its symbols' dimensions carry over in tenths. */
export const SCH_GRID = 0.1
export const PIN_PITCH = 0.2
/** Height of schematic text: designators, values, net labels and power port names (50 mil). */
export const SCH_TEXT = 0.1
const G = SCH_GRID

/** Direction text extends from its anchor point, in world axes. */
export interface TextExtent {
  x: -1 | 0 | 1
  y: -1 | 0 | 1
}

export function anchorToExtent(anchor: TextAnchor): TextExtent {
  switch (anchor) {
    case "middle_bottom":
      return { x: 0, y: 1 }
    case "middle_top":
      return { x: 0, y: -1 }
    case "middle_left":
      return { x: 1, y: 0 }
    case "middle_right":
      return { x: -1, y: 0 }
    case "bottom_left":
      return { x: 1, y: 1 }
    case "bottom_right":
      return { x: -1, y: 1 }
    case "top_left":
      return { x: 1, y: -1 }
    case "top_right":
      return { x: -1, y: -1 }
    default:
      return { x: 0, y: 0 }
  }
}

export function rotateExtent(e: TextExtent, rot: Rotation): TextExtent {
  let { x, y } = e
  for (let i = 0; i < rot / 90; i++) [x, y] = [-y as TextExtent["x"], x]
  return { x, y }
}

/** A symbol from its artwork and ports, with the bounds they cover. */
export const symbolDef = (primitives: SymbolPrimitive[], ports: SymbolPort[]): SymbolDef => ({ primitives, ports, bounds: computeBounds(primitives, ports) })

export interface BoxPin {
  number: string
  name: string
}

export interface BoxLayout {
  left?: BoxPin[]
  right?: BoxPin[]
  top?: BoxPin[]
  bottom?: BoxPin[]
}

const CHAR_W = 0.062
/** Advance of the smaller top/bottom pin names. */
const CAP_CHAR_W = 0.055
const PIN_LEN = 0.2

/** Generate a rectangular IC symbol with pins on up to four sides. */
export function makeBoxSymbol(layout: BoxLayout): SymbolDef {
  const left = layout.left ?? []
  const right = layout.right ?? []
  const top = layout.top ?? []
  const bottom = layout.bottom ?? []
  const maxLen = (pins: BoxPin[]) => pins.reduce((m, p) => Math.max(m, p.name.length), 0)

  const labelWidth = (maxLen(left) + maxLen(right)) * CHAR_W + 0.35
  const sideCount = Math.max(top.length, bottom.length)
  const minWidthForTop = (sideCount + 1) * PIN_PITCH
  let width = Math.max(0.8, labelWidth, minWidthForTop)
  width = round(Math.ceil(width / (2 * G) - 1e-6) * 2 * G)

  const rows = Math.max(left.length, right.length, 1)
  let height = (rows + 1) * PIN_PITCH
  if (top.length) height += PIN_PITCH
  if (bottom.length) height += PIN_PITCH
  height = round(Math.ceil(height / (2 * G) - 1e-6) * 2 * G)

  const hw = width / 2
  const hh = height / 2
  const primitives: SymbolPrimitive[] = [
    {
      type: "path",
      points: [
        { x: -hw, y: hh },
        { x: hw, y: hh },
        { x: hw, y: -hh },
        { x: -hw, y: -hh },
        { x: -hw, y: hh },
      ],
      fill: false,
    },
  ]
  const ports: SymbolPort[] = []
  const rowTop = round(hh - (top.length ? 2 : 1) * PIN_PITCH)

  const sidePins = (pins: BoxPin[], side: "left" | "right") => {
    pins.forEach((p, i) => {
      const y = round(rowTop - i * PIN_PITCH)
      const edge = side === "left" ? -hw : hw
      const tip = round(side === "left" ? -hw - PIN_LEN : hw + PIN_LEN)
      primitives.push({ type: "path", points: [{ x: tip, y }, { x: edge, y }], fill: false })
      primitives.push({
        type: "text",
        text: p.name,
        x: round(side === "left" ? edge + 0.05 : edge - 0.05),
        y,
        anchor: side === "left" ? "middle_left" : "middle_right",
        size: 0.09,
        role: "pin",
      })
      primitives.push({
        type: "text",
        text: p.number,
        x: round((tip + edge) / 2),
        y: round(y + 0.025),
        anchor: "middle_bottom",
        size: 0.065,
        role: "pinNumber",
      })
      ports.push({ pin: p.number, x: tip, y, dir: side })
    })
  }
  sidePins(left, "left")
  sidePins(right, "right")

  const capPins = (pins: BoxPin[], side: "top" | "bottom") => {
    const start = -((pins.length - 1) / 2) * PIN_PITCH
    // Names too wide to sit side by side at the pin pitch turn to run along their pins.
    const alongPin = pins.length > 1 && maxLen(pins) * CAP_CHAR_W > PIN_PITCH - 0.04
    pins.forEach((p, i) => {
      const x = round(start + i * PIN_PITCH)
      const edge = side === "top" ? hh : -hh
      const tip = round(side === "top" ? hh + PIN_LEN : -hh - PIN_LEN)
      primitives.push({ type: "path", points: [{ x, y: tip }, { x, y: edge }], fill: false })
      primitives.push({
        type: "text",
        text: p.name,
        x,
        y: round(side === "top" ? edge - 0.05 : edge + 0.05),
        anchor: side === "top" ? "middle_top" : "middle_bottom",
        size: 0.08,
        role: "pin",
        alongPin,
      })
      ports.push({ pin: p.number, x, y: tip, dir: side === "top" ? "up" : "down" })
    })
  }
  capPins(top, "top")
  capPins(bottom, "bottom")

  const topExtent = top.length ? hh + PIN_LEN : hh
  primitives.push({
    type: "text",
    text: "{REF}",
    x: -hw,
    y: round(topExtent + 0.04),
    anchor: "bottom_left",
    role: "ref",
  })
  // Under the body, ending before the first bottom pin so it doesn't cross those pins' wires.
  const firstBottom = -((bottom.length - 1) / 2) * PIN_PITCH
  primitives.push({
    type: "text",
    text: "{VAL}",
    x: bottom.length ? round(firstBottom - PIN_PITCH / 2) : -hw,
    y: round(-hh - 0.04),
    anchor: bottom.length ? "top_right" : "top_left",
    role: "value",
  })

  return symbolDef(primitives, ports)
}

function computeBounds(primitives: SymbolPrimitive[], ports: SymbolPort[]) {
  const b = emptyBox()
  for (const p of primitives) {
    if (p.type === "path") for (const pt of p.points) expandBox(b, pt)
    else if (p.type === "circle") expandBox(b, p, p.radius)
  }
  for (const p of ports) expandBox(b, p)
  if (!Number.isFinite(b.minX)) return { minX: -0.2, minY: -0.2, maxX: 0.2, maxY: 0.2 }
  return { minX: round(b.minX), minY: round(b.minY), maxX: round(b.maxX), maxY: round(b.maxY) }
}
