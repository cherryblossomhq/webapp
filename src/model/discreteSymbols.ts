import { round } from "../lib/geometry"
import { SCH_TEXT, symbolDef } from "./symbols"
import type { SymbolDef, SymbolPort, SymbolPrimitive, TextAnchor } from "./types"

/*
 * Discrete parts and power ports, drawn at KiCad's proportions (0.1 here is its 50 mil): two
 * terminal parts are 300 mil from pin to pin, switches 400 mil, transistors put their pins
 * 200 mil apart, and all text is 50 mil, the height of a net label's.
 *
 * A designator and a value on the same side of a symbol are anchored away from each other, so
 * they stay apart when the part is turned and its text stays upright.
 *
 * Ports are labelled with each symbol's own numbers ("1", "2", "3"), which `discreteSymbol` maps
 * to a part's pins. Each symbol sits about its origin so that its pins lie on the lines they did
 * when these parts were drawn larger, so opening a project from then (version 1 of the project
 * file, see `migrations/kicadSymbols.ts`) only lengthens wires along those lines. Moving a pin
 * of a shipped symbol again needs a migration of its own.
 */

type Pt = [number, number]

const path = (pts: Pt[], fill = false): SymbolPrimitive => ({ type: "path", points: pts.map(([x, y]) => ({ x, y })), fill })
const circle = (x: number, y: number, radius: number): SymbolPrimitive => ({ type: "circle", x, y, radius, fill: false })
const text = (role: "ref" | "value", x: number, y: number, anchor: TextAnchor): SymbolPrimitive => ({
  type: "text",
  text: role === "ref" ? "{REF}" : "{VAL}",
  x,
  y,
  anchor,
  size: SCH_TEXT,
  role,
})
const port = (pin: string, x: number, y: number, dir: SymbolPort["dir"]): SymbolPort => ({ pin, x, y, dir })

/** Points along a circle from one angle to another, in degrees. */
function arc(cx: number, cy: number, r: number, from: number, to: number, steps = 10): Pt[] {
  const pts: Pt[] = []
  for (let i = 0; i <= steps; i++) {
    const a = ((from + ((to - from) * i) / steps) * Math.PI) / 180
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
  }
  return pts
}

/** A filled arrowhead with its tip at (x, y), pointing along the angle in degrees. */
function arrowhead(x: number, y: number, angle: number, length = 0.06, half = 0.03): SymbolPrimitive {
  const a = (angle * Math.PI) / 180
  const d: Pt = [Math.cos(a), Math.sin(a)]
  const bx = x - d[0] * length
  const by = y - d[1] * length
  return path(
    [
      [x, y],
      [bx - d[1] * half, by + d[0] * half],
      [bx + d[1] * half, by - d[0] * half],
      [x, y],
    ],
    true,
  )
}

const plus = (x: number, y: number, half = 0.03): SymbolPrimitive[] => [
  path([
    [x - half, y],
    [x + half, y],
  ]),
  path([
    [x, y - half],
    [x, y + half],
  ]),
]

/** Two horizontal pins, "1" on the left and "2" on the right, at ±`half`. */
const twoPins = (half = 0.3): SymbolPort[] => [port("1", -half, 0, "left"), port("2", half, 0, "right")]

function zigzag(from: number, to: number, amplitude: number, waves = 6): Pt[] {
  const step = (to - from) / waves
  const pts: Pt[] = [[from, 0]]
  for (let i = 0; i < waves; i++) pts.push([from + (i + 0.5) * step, i % 2 ? -amplitude : amplitude])
  pts.push([to, 0])
  return pts
}

/** Anode on the left: the leads, the triangle and the cathode bar `bar` draws. */
function diode(bar: Pt[], extra: SymbolPrimitive[] = [], refY = 0.14): SymbolDef {
  return symbol(
    [
      path([
        [-0.3, 0],
        [-0.1, 0],
      ]),
      path([
        [-0.1, 0.1],
        [0.1, 0],
        [-0.1, -0.1],
        [-0.1, 0.1],
      ]),
      path(bar),
      path([
        [0.1, 0],
        [0.3, 0],
      ]),
      ...extra,
      text("ref", 0, refY, "middle_bottom"),
      text("value", 0, -0.14, "middle_top"),
    ],
    twoPins(),
  )
}

/** Collector left, emitter right and base below, as the larger drawing had them. */
function bjt(arrow: SymbolPrimitive): SymbolDef {
  return symbol(
    [
      circle(0, 0.2, 0.22),
      path([
        [0, -0.3],
        [0, 0.15],
      ]),
      path([
        [-0.15, 0.15],
        [0.15, 0.15],
      ]),
      path([
        [-0.05, 0.15],
        [-0.2, 0.3],
        [-0.4, 0.3],
      ]),
      path([
        [0.05, 0.15],
        [0.2, 0.3],
        [0.4, 0.3],
      ]),
      arrow,
      text("ref", -0.02, 0.46, "bottom_right"),
      text("value", 0.02, 0.46, "bottom_left"),
    ],
    [port("1", -0.4, 0.3, "left"), port("2", 0, -0.3, "down"), port("3", 0.4, 0.3, "right")],
  )
}

/** Gate left, drain up and source down, drawn about (-0.1, 0.1) from the origin. */
function mosfet(arrow: SymbolPrimitive): SymbolDef {
  const art: SymbolPrimitive[] = [
    circle(0.13, 0, 0.22),
    path([
      [-0.4, 0],
      [0.02, 0],
    ]),
    path([
      [0.02, -0.15],
      [0.02, 0.15],
    ]),
    path([
      [0.06, 0.1],
      [0.06, 0.18],
    ]),
    path([
      [0.06, -0.04],
      [0.06, 0.04],
    ]),
    path([
      [0.06, -0.18],
      [0.06, -0.1],
    ]),
    path([
      [0.06, 0.14],
      [0.2, 0.14],
      [0.2, 0.4],
    ]),
    path([
      [0.06, -0.14],
      [0.2, -0.14],
      [0.2, -0.4],
    ]),
    path([
      [0.06, 0],
      [0.2, 0],
      [0.2, -0.14],
    ]),
    arrow,
    text("ref", 0.39, 0.02, "bottom_left"),
    text("value", 0.39, -0.02, "top_left"),
  ]
  return symbol(art, [port("1", 0.2, 0.4, "up"), port("2", 0.2, -0.4, "down"), port("3", -0.4, 0, "left")], { x: 0.1, y: -0.1 })
}

/** Moves the artwork and ports by `offset`, rounds them, and adds the bounds. */
function symbol(primitives: SymbolPrimitive[], ports: SymbolPort[], offset = { x: 0, y: 0 }): SymbolDef {
  const mx = (x: number) => round(x + offset.x)
  const my = (y: number) => round(y + offset.y)
  return symbolDef(
    primitives.map((p) => (p.type === "path" ? { ...p, points: p.points.map((pt) => ({ x: mx(pt.x), y: my(pt.y) })) } : { ...p, x: mx(p.x), y: my(p.y) })),
    ports.map((p) => ({ ...p, x: mx(p.x), y: my(p.y) })),
  )
}

const SYMBOLS = {
  resistor: () =>
    symbol(
      [path([[-0.3, 0], ...zigzag(-0.2, 0.2, 0.08), [0.3, 0]]), text("ref", 0, 0.13, "middle_bottom"), text("value", 0, -0.13, "middle_top")],
      twoPins(),
    ),
  capacitor: () =>
    symbol(
      [
        path([
          [-0.3, 0],
          [-0.06, 0],
        ]),
        path([
          [-0.06, -0.16],
          [-0.06, 0.16],
        ]),
        path([
          [0.06, -0.16],
          [0.06, 0.16],
        ]),
        path([
          [0.06, 0],
          [0.3, 0],
        ]),
        text("ref", 0, 0.2, "middle_bottom"),
        text("value", 0, -0.2, "middle_top"),
      ],
      twoPins(),
    ),
  /** "1" is the positive plate, the straight one. */
  capacitor_polarized: () =>
    symbol(
      [
        path([
          [-0.3, 0],
          [-0.06, 0],
        ]),
        path([
          [-0.06, -0.16],
          [-0.06, 0.16],
        ]),
        path(arc(0.26, 0, 0.2, 127, 233)),
        path([
          [0.06, 0],
          [0.3, 0],
        ]),
        ...plus(-0.15, 0.11),
        text("ref", 0, 0.2, "middle_bottom"),
        text("value", 0, -0.2, "middle_top"),
      ],
      twoPins(),
    ),
  inductor: () =>
    symbol(
      [
        path([[-0.3, 0], ...[-0.15, -0.05, 0.05, 0.15].flatMap((cx) => arc(cx, 0, 0.05, 180, 0, 8)), [0.3, 0]]),
        text("ref", 0, 0.1, "middle_bottom"),
        text("value", 0, -0.04, "middle_top"),
      ],
      twoPins(),
    ),
  /** A rectangle turned 60°, the leads meeting its long sides on the axis. */
  ferrite_bead: () => {
    const u: Pt = [0.5, Math.sqrt(3) / 2]
    const v: Pt = [-u[1], u[0]]
    const corner = (a: number, b: number): Pt => [u[0] * a + v[0] * b, u[1] * a + v[1] * b]
    const edge = 0.06 / u[1]
    return symbol(
      [
        path([
          [-0.3, 0],
          [-edge, 0],
        ]),
        path([corner(-0.14, -0.06), corner(0.14, -0.06), corner(0.14, 0.06), corner(-0.14, 0.06), corner(-0.14, -0.06)]),
        path([
          [edge, 0],
          [0.3, 0],
        ]),
        text("ref", 0, 0.19, "middle_bottom"),
        text("value", 0, -0.19, "middle_top"),
      ],
      twoPins(),
    )
  },
  crystal: () =>
    symbol(
      [
        path([
          [-0.3, 0],
          [-0.16, 0],
        ]),
        path([
          [-0.16, -0.15],
          [-0.16, 0.15],
        ]),
        path([
          [-0.08, -0.12],
          [0.08, -0.12],
          [0.08, 0.12],
          [-0.08, 0.12],
          [-0.08, -0.12],
        ]),
        path([
          [0.16, -0.15],
          [0.16, 0.15],
        ]),
        path([
          [0.16, 0],
          [0.3, 0],
        ]),
        text("ref", 0, 0.19, "middle_bottom"),
        text("value", 0, -0.19, "middle_top"),
      ],
      twoPins(),
    ),
  fuse: () =>
    symbol(
      [
        path([
          [-0.3, 0],
          [0.3, 0],
        ]),
        path([
          [-0.2, -0.06],
          [0.2, -0.06],
          [0.2, 0.06],
          [-0.2, 0.06],
          [-0.2, -0.06],
        ]),
        text("ref", 0, 0.1, "middle_bottom"),
        text("value", 0, -0.1, "middle_top"),
      ],
      twoPins(),
    ),
  diode: () =>
    diode([
      [0.1, 0.1],
      [0.1, -0.1],
    ]),
  schottky: () =>
    diode([
      [0.15, 0.05],
      [0.15, 0.1],
      [0.1, 0.1],
      [0.1, -0.1],
      [0.05, -0.1],
      [0.05, -0.05],
    ]),
  zener: () =>
    diode([
      [0.14, -0.1],
      [0.1, -0.1],
      [0.1, 0.1],
      [0.06, 0.1],
    ]),
  tvs: () =>
    diode([
      [0.06, -0.14],
      [0.1, -0.1],
      [0.1, 0.1],
      [0.14, 0.14],
    ]),
  led: () =>
    diode(
      [
        [0.1, 0.1],
        [0.1, -0.1],
      ],
      [
        path([
          [-0.05, 0.13],
          [0.02, 0.2],
        ]),
        arrowhead(0.04, 0.22, 45),
        path([
          [0.03, 0.13],
          [0.1, 0.2],
        ]),
        arrowhead(0.12, 0.22, 45),
      ],
      0.26,
    ),
  /** A resistor between "1" and "3" with the wiper, "2", below. */
  potentiometer: () =>
    symbol(
      [
        path([[-0.3, 0], ...zigzag(-0.2, 0.2, 0.08), [0.3, 0]]),
        path([
          [0, -0.2],
          [0, -0.14],
        ]),
        arrowhead(0, -0.09, 90, 0.05),
        text("ref", 0, 0.13, "middle_bottom"),
        text("value", 0.06, -0.12, "top_left"),
      ],
      [port("1", -0.3, 0, "left"), port("3", 0.3, 0, "right"), port("2", 0, -0.2, "down")],
    ),
  npn: () => bjt(arrowhead(0.17, 0.27, 45)),
  pnp: () => bjt(arrowhead(0.08, 0.18, 225)),
  nmos: () => mosfet(arrowhead(0.075, 0, 180, 0.05)),
  pmos: () => mosfet(arrowhead(0.19, 0, 0, 0.05)),
  /** One cell, "1" the positive (long) plate. */
  battery: () =>
    symbol(
      [
        path([
          [-0.3, 0],
          [-0.04, 0],
        ]),
        path([
          [-0.04, -0.16],
          [-0.04, 0.16],
        ]),
        path(
          [
            [0.03, -0.09],
            [0.06, -0.09],
            [0.06, 0.09],
            [0.03, 0.09],
            [0.03, -0.09],
          ],
          true,
        ),
        path([
          [0.06, 0],
          [0.3, 0],
        ]),
        ...plus(-0.14, 0.12),
        text("ref", 0, 0.2, "middle_bottom"),
        text("value", 0, -0.2, "middle_top"),
      ],
      twoPins(),
    ),
  pushbutton: () =>
    symbol(
      [
        path([
          [-0.4, 0],
          [-0.2, 0],
        ]),
        circle(-0.16, 0, 0.04),
        circle(0.16, 0, 0.04),
        path([
          [0.2, 0],
          [0.4, 0],
        ]),
        path([
          [-0.2, 0.1],
          [0.2, 0.1],
        ]),
        path([
          [0, 0.1],
          [0, 0.24],
        ]),
        path([
          [-0.06, 0.24],
          [0.06, 0.24],
        ]),
        text("ref", 0, 0.29, "middle_bottom"),
        text("value", 0, -0.08, "middle_top"),
      ],
      twoPins(0.4),
    ),
  /** "1" the common contact on the left, "2" and "3" the throws on the right. */
  spdt: () =>
    symbol(
      [
        path([
          [-0.4, 0],
          [-0.2, 0],
        ]),
        circle(-0.16, 0, 0.04),
        circle(0.16, 0.2, 0.04),
        circle(0.16, -0.2, 0.04),
        path([
          [0.2, 0.2],
          [0.4, 0.2],
        ]),
        path([
          [0.2, -0.2],
          [0.4, -0.2],
        ]),
        path([
          [-0.12, 0.02],
          [0.12, 0.17],
        ]),
        text("ref", 0, 0.3, "middle_bottom"),
        text("value", 0, -0.3, "middle_top"),
      ],
      [port("1", -0.4, 0, "left"), port("2", 0.4, 0.2, "right"), port("3", 0.4, -0.2, "right")],
    ),
  /** Both pins on the left, "1" the positive one, above. */
  buzzer: () =>
    symbol(
      [
        path([
          [-0.2, 0.2],
          [0, 0.2],
        ]),
        path([
          [-0.2, -0.2],
          [0, -0.2],
        ]),
        path([
          [0, -0.25],
          [0, 0.25],
        ]),
        path(arc(0, 0, 0.25, -90, 90, 16)),
        ...plus(-0.1, 0.28),
        text("ref", 0.3, 0.02, "bottom_left"),
        text("value", 0.3, -0.02, "top_left"),
      ],
      [port("1", -0.2, 0.2, "left"), port("2", -0.2, -0.2, "left")],
    ),
  /** A supply arrow above its pin, named above the arrow. */
  power: () =>
    symbol(
      [
        path([
          [0, -0.2],
          [0, 0],
        ]),
        path([
          [-0.06, -0.1],
          [0, 0],
          [0.06, -0.1],
        ]),
        text("ref", 0, 0.03, "middle_bottom"),
      ],
      [port("1", 0, -0.2, "down")],
    ),
  /** Three bars under their pin, named below them. */
  ground: () =>
    symbol(
      [
        path([
          [0, 0.3],
          [0, 0.2],
        ]),
        ...(
          [
            [0.2, 0.1],
            [0.15, 0.06],
            [0.1, 0.02],
          ] as const
        ).map(([y, half]) =>
          path([
            [-half, y],
            [half, y],
          ]),
        ),
        text("ref", 0, 0.07, "middle_top"),
      ],
      [port("1", 0, 0.3, "up")],
    ),
} satisfies Record<string, () => SymbolDef>

export type DiscreteSymbolName = keyof typeof SYMBOLS

/** A discrete symbol with its ports renamed to a part's pins: `pinMap` maps the symbol's port label to the pin number. */
export function discreteSymbol(name: DiscreteSymbolName, pinMap?: Record<string, string>): SymbolDef {
  const s = SYMBOLS[name]()
  return pinMap ? { ...s, ports: s.ports.map((p) => ({ ...p, pin: pinMap[p.pin] ?? p.pin })) } : s
}
