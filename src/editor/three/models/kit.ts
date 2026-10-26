import * as THREE from "three"
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js"
import { mergeGeometries, toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js"
import type { ModelMaterials } from "./index"

/** Height of the copper the scene draws on the board face; SMD leads rest on it. */
export const SEAT = 0.035

// ---------- materials ----------

type MaterialDef = () => THREE.Material

const std = (color: string, roughness: number, metalness = 0, extra: THREE.MeshStandardMaterialParameters = {}) => () =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra })

const phys = (color: string, roughness: number, extra: THREE.MeshPhysicalMaterialParameters = {}) => () =>
  new THREE.MeshPhysicalMaterial({ color, roughness, clearcoat: 0.25, clearcoatRoughness: 0.45, ...extra })

const MATERIALS: Record<string, MaterialDef> = {
  epoxy: std("#101012", 0.7),
  epoxyGloss: std("#0e0e10", 0.3),
  tin: std("#d3d6da", 0.3, 1),
  solder: std("#c8ccd1", 0.2, 1),
  gold: std("#e2b85c", 0.24, 1),
  steel: std("#c4c9cf", 0.36, 1),
  brushed: std("#cfd3d8", 0.26, 1),
  nickel: std("#d9dcdf", 0.2, 1),
  ceramic: std("#e7e1d1", 0.78),
  resistorCoat: std("#17171a", 0.5),
  mlcc: std("#a7845c", 0.68),
  ferrite: std("#3b3c40", 0.74),
  plasticBlack: phys("#19191c", 0.46),
  hole: std("#050506", 0.95),
  terminalGreen: phys("#25913f", 0.46, { clearcoat: 0.3 }),
  cream: phys("#efe8d7", 0.5),
  potBlue: phys("#2459c4", 0.42),
  white: phys("#f3f2ee", 0.42),
  rubber: std("#232325", 0.88),
  glassOrange: () =>
    new THREE.MeshPhysicalMaterial({
      color: "#d9862f",
      roughness: 0.08,
      transparent: true,
      opacity: 0.82,
      clearcoat: 1,
      clearcoatRoughness: 0.05,
    }),
  sleeveStripe: std("#c6cad1", 0.5),
  vent: std("#9ea3a9", 0.45, 1),
  /** Bare aluminium can (SMD electrolytics). */
  alu: std("#d2d6db", 0.3, 1),
  /** Tin-plated RF shield can. */
  shield: std("#c9cdd2", 0.36, 1),
  /** Black solder mask of a module carrier board. */
  pcbBlack: phys("#17181c", 0.5, { clearcoat: 0.45, clearcoatRoughness: 0.35 }),
  pcbModule: phys("#121317", 0.42, { clearcoat: 0.5, clearcoatRoughness: 0.3 }),
  /** Copper under black mask (PCB antenna). */
  maskCopper: phys("#2b2d33", 0.3, { clearcoat: 0.8, clearcoatRoughness: 0.15 }),
  /** OLED panel: dark glass, polariser and the exposed bottom glass ledge. */
  oledGlass: () =>
    new THREE.MeshPhysicalMaterial({ color: "#23262d", roughness: 0.06, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.03 }),
  oledPolarizer: () =>
    new THREE.MeshPhysicalMaterial({ color: "#07080b", roughness: 0.14, clearcoat: 1, clearcoatRoughness: 0.04 }),
  oledActive: () =>
    new THREE.MeshPhysicalMaterial({ color: "#0a0f1c", roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.04 }),
  oledLedge: () =>
    new THREE.MeshPhysicalMaterial({ color: "#5a6470", roughness: 0.1, metalness: 0.35, clearcoat: 1, clearcoatRoughness: 0.05 }),
  /** Amber polyimide flex. */
  flex: phys("#d49340", 0.34, { clearcoat: 0.7, clearcoatRoughness: 0.25 }),
  flexTrace: phys("#b66a2b", 0.3, { clearcoat: 0.8, clearcoatRoughness: 0.2 }),
  /** Tan tact-switch plunger. */
  actuatorTan: phys("#c39462", 0.5),
}

/**
 * Resolve a material key. Named keys come from the table above; `paint:#rrggbb:rough` is a
 * plain dielectric and `glow:#rrggbb` a translucent emissive lens.
 */
export function material(mats: ModelMaterials, key: string): THREE.Material {
  return mats.get(`model:${key}`, () => {
    const def = MATERIALS[key]
    if (def) return def()
    const [kind, color, rough] = key.split(":")
    if (kind === "paint") return new THREE.MeshStandardMaterial({ color, roughness: Number(rough ?? 0.55) })
    if (kind === "gloss") return new THREE.MeshPhysicalMaterial({ color, roughness: Number(rough ?? 0.4), clearcoat: 0.4, clearcoatRoughness: 0.3 })
    if (kind === "glow")
      return new THREE.MeshPhysicalMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.55,
        roughness: 0.12,
        transparent: true,
        opacity: 0.86,
        clearcoat: 1,
        clearcoatRoughness: 0.08,
      })
    if (kind === "die") return new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.6, roughness: 0.4 })
    return new THREE.MeshStandardMaterial({ color: "#ff00ff" })
  })
}

/** Materials that render with transparency; they don't cast shadows. */
export const isTransparentKey = (key: string) => key === "glassOrange" || key.startsWith("glow:")

// ---------- spec ----------

export interface MarkingSpec {
  lines: string[]
  /** Centre of the decal. */
  x: number
  y: number
  z: number
  /** Decal size in mm before rotation (width along the text baseline). */
  width: number
  height: number
  /** Rotation about Z (radians) applied after the decal's own orientation. */
  rotZ?: number
  /** Face the decal points at; "top" lies flat, "front" faces -y, "back" faces +y. */
  face?: "top" | "front"
  color?: string
  weight?: number
}

/** Geometry for one model, grouped by material key, plus decals. */
export interface ModelSpec {
  geoms: Map<string, THREE.BufferGeometry>
  markings: MarkingSpec[]
}

export class Builder {
  private parts = new Map<string, THREE.BufferGeometry[]>()
  markings: MarkingSpec[] = []

  add(key: string, geom: THREE.BufferGeometry): this {
    const list = this.parts.get(key) ?? []
    list.push(geom)
    this.parts.set(key, list)
    return this
  }

  /** Axis-aligned box with optional rounded edges. */
  box(key: string, cx: number, cy: number, z0: number, sx: number, sy: number, sz: number, radius = 0): this {
    const r = Math.min(radius, sx / 2, sy / 2, sz / 2) * 0.999
    const g = r > 0.005 ? new RoundedBoxGeometry(sx, sy, sz, 2, r) : new THREE.BoxGeometry(sx, sy, sz)
    g.translate(cx, cy, z0 + sz / 2)
    return this.add(key, g)
  }

  /** Vertical cylinder from z0 to z1. */
  cyl(key: string, x: number, y: number, z0: number, z1: number, r: number, seg = 18, r1 = r): this {
    const g = new THREE.CylinderGeometry(r1, r, z1 - z0, seg)
    g.rotateX(Math.PI / 2)
    g.translate(x, y, (z0 + z1) / 2)
    return this.add(key, g)
  }

  mark(m: MarkingSpec): this {
    this.markings.push(m)
    return this
  }

  /** Move everything collected from another builder into this one. */
  merge(other: Builder): this {
    for (const [key, list] of other.parts) for (const g of list) this.add(key, g)
    this.markings.push(...other.markings)
    other.parts.clear()
    other.markings = []
    return this
  }

  /** Rotate everything collected so far about Z, then move it to (cx, cy) and up by dz. */
  transform(cx: number, cy: number, rotZ = 0, dz = 0): this {
    const m = new THREE.Matrix4().makeRotationZ(rotZ).setPosition(cx, cy, dz)
    for (const list of this.parts.values()) for (const g of list) g.applyMatrix4(m)
    const c = Math.cos(rotZ)
    const s = Math.sin(rotZ)
    for (const mk of this.markings) {
      const x = mk.x * c - mk.y * s
      const y = mk.x * s + mk.y * c
      mk.x = x + cx
      mk.y = y + cy
      mk.z += dz
      mk.rotZ = (mk.rotZ ?? 0) + rotZ
    }
    return this
  }

  build(): ModelSpec {
    const geoms = new Map<string, THREE.BufferGeometry>()
    for (const [key, list] of this.parts) {
      const merged = mergeAll(list)
      if (merged) geoms.set(key, merged)
    }
    return { geoms, markings: this.markings }
  }
}

function mergeAll(list: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  const prepared = list.map((g) => {
    const n = g.index ? g.toNonIndexed() : g
    if (n !== g) g.dispose()
    for (const name of Object.keys(n.attributes)) {
      if (name !== "position" && name !== "normal" && name !== "uv") n.deleteAttribute(name)
    }
    if (!n.attributes.normal) n.computeVertexNormals()
    if (!n.attributes.uv) {
      const count = n.attributes.position.count
      n.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(count * 2), 2))
    }
    n.clearGroups()
    return n
  })
  if (!prepared.length) return null
  if (prepared.length === 1) return prepared[0]
  const merged = mergeGeometries(prepared, false)
  for (const g of prepared) g.dispose()
  return merged
}

// ---------- 2D helpers ----------

export type P2 = [number, number]

export function roundedRectShape(cx: number, cy: number, w: number, h: number, r: number): THREE.Shape {
  const rr = Math.max(0, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4))
  const x0 = cx - w / 2
  const y0 = cy - h / 2
  const s = new THREE.Shape()
  if (rr <= 1e-4) {
    s.moveTo(x0, y0)
    s.lineTo(x0 + w, y0)
    s.lineTo(x0 + w, y0 + h)
    s.lineTo(x0, y0 + h)
    s.closePath()
    return s
  }
  s.moveTo(x0 + rr, y0)
  s.lineTo(x0 + w - rr, y0)
  s.absarc(x0 + w - rr, y0 + rr, rr, -Math.PI / 2, 0, false)
  s.lineTo(x0 + w, y0 + h - rr)
  s.absarc(x0 + w - rr, y0 + h - rr, rr, 0, Math.PI / 2, false)
  s.lineTo(x0 + rr, y0 + h)
  s.absarc(x0 + rr, y0 + h - rr, rr, Math.PI / 2, Math.PI, false)
  s.lineTo(x0, y0 + rr)
  s.absarc(x0 + rr, y0 + rr, rr, Math.PI, Math.PI * 1.5, false)
  return s
}

export function rectPath(cx: number, cy: number, w: number, h: number): THREE.Path {
  const p = new THREE.Path()
  p.moveTo(cx - w / 2, cy - h / 2)
  p.lineTo(cx - w / 2, cy + h / 2)
  p.lineTo(cx + w / 2, cy + h / 2)
  p.lineTo(cx + w / 2, cy - h / 2)
  p.closePath()
  return p
}

export function circleHole(cx: number, cy: number, r: number): THREE.Path {
  const p = new THREE.Path()
  p.absarc(cx, cy, r, 0, Math.PI * 2, true)
  return p
}

/** Stadium (rounded-end rectangle) along x. */
export function stadiumShape(cx: number, cy: number, w: number, h: number): THREE.Shape {
  const r = h / 2
  const half = Math.max(0, w / 2 - r)
  const s = new THREE.Shape()
  s.moveTo(cx - half, cy - r)
  s.lineTo(cx + half, cy - r)
  s.absarc(cx + half, cy, r, -Math.PI / 2, Math.PI / 2, false)
  s.lineTo(cx - half, cy + r)
  s.absarc(cx - half, cy, r, Math.PI / 2, Math.PI * 1.5, false)
  return s
}

/**
 * Extrude a plan-view shape between z0 and z1, rounding the top and bottom edges with a bevel.
 * The shape is inset by the bevel so the outer footprint matches the shape.
 */
export function slab(shape: THREE.Shape, z0: number, z1: number, bevel = 0, curveSegments = 12): THREE.BufferGeometry {
  const h = z1 - z0
  const b = Math.min(bevel, h / 2 - 1e-3)
  if (b <= 1e-3) {
    const g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments })
    g.translate(0, 0, z0)
    return g
  }
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: h - 2 * b,
    bevelEnabled: true,
    bevelThickness: b,
    bevelSize: b,
    bevelOffset: -b,
    bevelSegments: 3,
    curveSegments,
  })
  g.translate(0, 0, z0 + b)
  return g
}

/** Extruded rounded rectangle body (plan size w x l) with bevelled edges. */
export function block(cx: number, cy: number, w: number, l: number, z0: number, z1: number, corner = 0.08, bevel = 0.08) {
  return slab(roundedRectShape(cx, cy, w, l, corner), z0, z1, bevel, 6)
}

/**
 * Extrude a profile drawn in the XZ plane (pairs of [x, z]) to a width centred on y = 0.
 * Curved runs of the profile get smooth normals; corners sharper than 35 degrees stay crisp.
 */
export function profileXZ(points: P2[], width: number, holes: P2[][] = [], bevel = 0): THREE.BufferGeometry {
  const shape = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, z)))
  for (const h of holes) shape.holes.push(new THREE.Path(h.map(([x, z]) => new THREE.Vector2(x, z))))
  const b = Math.min(bevel, width / 2 - 1e-3)
  const g =
    b > 1e-3
      ? new THREE.ExtrudeGeometry(shape, {
          depth: width - 2 * b,
          bevelEnabled: true,
          bevelThickness: b,
          bevelSize: b,
          bevelOffset: -b,
          bevelSegments: 3,
          curveSegments: 10,
        })
      : new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false, curveSegments: 10 })
  g.translate(0, 0, b > 1e-3 ? -width / 2 + b : -width / 2)
  g.rotateX(Math.PI / 2)
  const smooth = toCreasedNormals(g, (35 * Math.PI) / 180)
  if (smooth !== g) g.dispose()
  return smooth
}

/** Revolve [radius, z] pairs around the Z axis. */
export function lathe(points: P2[], segments = 32, phiStart = 0, phiLength = Math.PI * 2): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(points.map(([r, z]) => new THREE.Vector2(r, z)), segments, phiStart, phiLength)
  g.rotateX(Math.PI / 2)
  return g
}

/** Close an open polyline into a band of thickness t (miter joins). */
export function thicken(path: P2[], t: number): P2[] {
  const n = path.length
  const left: P2[] = []
  const right: P2[] = []
  for (let i = 0; i < n; i++) {
    const prev = path[Math.max(0, i - 1)]
    const next = path[Math.min(n - 1, i + 1)]
    let dx = next[0] - prev[0]
    let dy = next[1] - prev[1]
    const len = Math.hypot(dx, dy) || 1
    dx /= len
    dy /= len
    let nx = -dy
    let ny = dx
    let scale = 1
    if (i > 0 && i < n - 1) {
      const ax = path[i][0] - prev[0]
      const ay = path[i][1] - prev[1]
      const al = Math.hypot(ax, ay) || 1
      const segN: P2 = [-ay / al, ax / al]
      const cos = nx * segN[0] + ny * segN[1]
      scale = 1 / Math.max(0.35, cos)
    }
    nx *= (t / 2) * scale
    ny *= (t / 2) * scale
    left.push([path[i][0] + nx, path[i][1] + ny])
    right.push([path[i][0] - nx, path[i][1] - ny])
  }
  return [...left, ...right.reverse()]
}

/** Cubic Bezier sample, excluding the start point. */
export function bezier(a: P2, c1: P2, c2: P2, b: P2, steps = 8): P2[] {
  const out: P2[] = []
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const u = 1 - t
    out.push([
      u * u * u * a[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * b[0],
      u * u * u * a[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * b[1],
    ])
  }
  return out
}

/**
 * Gull-wing lead running outward along +x: leaves the body at `edge` and height `exitZ`,
 * drops to the pad and ends at `tip`. Returned geometry is centred on y = 0.
 */
export function gullWingLead(edge: number, tip: number, exitZ: number, t: number, w: number): THREE.BufferGeometry {
  const zf = SEAT + t / 2
  const reach = tip - edge
  const kneeX = edge + Math.min(0.3, reach * 0.32)
  const footStart = Math.min(tip - 0.12, kneeX + Math.min(0.32, reach * 0.3))
  const path: P2[] = [[edge - 0.25, exitZ], [edge, exitZ]]
  path.push(...bezier([edge, exitZ], [kneeX, exitZ], [kneeX - 0.04, zf], [footStart, zf], 14))
  path.push([tip, zf])
  return profileXZ(thicken(path, t), w)
}

/** Round wire through a sequence of 3D points with rounded corners. */
export function wire(points: THREE.Vector3[], radius: number, bend = 0.4, radial = 10): THREE.BufferGeometry {
  const path = new THREE.CurvePath<THREE.Vector3>()
  let cursor = points[0].clone()
  for (let i = 1; i < points.length; i++) {
    const p = points[i]
    if (i < points.length - 1) {
      const next = points[i + 1]
      const inDir = p.clone().sub(points[i - 1]).normalize()
      const outDir = next.clone().sub(p).normalize()
      const r = Math.min(bend, p.distanceTo(points[i - 1]) / 2, next.distanceTo(p) / 2)
      const a = p.clone().addScaledVector(inDir, -r)
      const b = p.clone().addScaledVector(outDir, r)
      if (cursor.distanceTo(a) > 1e-4) path.add(new THREE.LineCurve3(cursor, a))
      path.add(new THREE.QuadraticBezierCurve3(a, p.clone(), b))
      cursor = b
    } else if (cursor.distanceTo(p) > 1e-4) {
      path.add(new THREE.LineCurve3(cursor, p.clone()))
    }
  }
  const segments = Math.max(8, path.curves.length * 6)
  return new THREE.TubeGeometry(path, segments, radius, radial, false)
}

/** Pyramid-tipped square pin from z0 to z1 (tip chamfer at the top end, and at the bottom when tail). */
export function squarePin(b: Builder, key: string, x: number, y: number, z0: number, z1: number, side = 0.64) {
  const chamfer = side * 0.45
  b.box(key, x, y, z0 + chamfer, side, side, z1 - z0 - chamfer * 2)
  const wide = side / Math.SQRT2
  const narrow = (side * 0.3) / Math.SQRT2
  const frustum = (zLow: number, pointingUp: boolean) => {
    const g = new THREE.CylinderGeometry(pointingUp ? narrow : wide, pointingUp ? wide : narrow, chamfer, 4, 1)
    g.rotateY(Math.PI / 4)
    g.rotateX(Math.PI / 2)
    g.translate(x, y, zLow + chamfer / 2)
    b.add(key, g)
  }
  frustum(z1 - chamfer, true)
  frustum(z0, false)
}

/** Solder cone on the underside of a through-hole joint. */
export function solderJoint(b: Builder, x: number, y: number, boardT: number, padR: number, leadR: number) {
  const z = -boardT
  // Profile runs bottom to top so the lathe faces point outward.
  const g = lathe(
    [
      [0, z - 0.76],
      [leadR * 1.04, z - 0.75],
      [leadR * 1.18, z - 0.5],
      [leadR * 1.55, z - 0.28],
      [padR * 0.62, z - 0.1],
      [padR * 0.9, z - 0.015],
      [0, z],
    ],
    20,
  )
  g.translate(x, y, 0)
  b.add("solder", g)
}

// ---------- markings ----------

export function markingTexture(mats: ModelMaterials, lines: string[], aspect: number, color: string, weight: number): THREE.Texture | null {
  if (typeof document === "undefined") return null
  // Tall multi-line labels (pin columns) get a taller canvas so each line keeps its resolution.
  const a = Math.max(lines.length > 3 ? 0.03 : 0.25, Math.min(8, aspect))
  const key = `mark:${lines.join("\n")}:${a.toFixed(3)}:${color}:${weight}`
  return mats.texture(key, () => {
    const H = Math.min(2048, Math.max(192, lines.length * 72))
    const W = Math.max(16, Math.min(1536, Math.round(H * a)))
    const canvas = document.createElement("canvas")
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext("2d")!
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = color
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    const n = lines.length
    const lineH = H / (n + 0.35)
    let size = lineH * 0.82
    const family = `"Helvetica Neue", Helvetica, Arial, sans-serif`
    for (const line of lines) {
      ctx.font = `${weight} ${size}px ${family}`
      const w = ctx.measureText(line).width
      if (w > W * 0.94) size = (size * W * 0.94) / w
    }
    ctx.font = `${weight} ${size}px ${family}`
    lines.forEach((line, i) => ctx.fillText(line, W / 2, H / 2 + (i - (n - 1) / 2) * lineH))
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = 4
    tex.generateMipmaps = true
    tex.minFilter = THREE.LinearMipmapLinearFilter
    return tex
  })
}

/** Stable small hash for per-part variation (date codes and such). */
export function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Year-week date code like "2337", stable per component. */
export const dateCode = (seed: string) => {
  const h = hash(seed)
  return `${21 + (h % 5)}${String(1 + ((h >>> 4) % 52)).padStart(2, "0")}`
}
