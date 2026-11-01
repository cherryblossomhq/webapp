import { viaLayers } from "../../model/stack"
import { viaTentedOn } from "../../model/viaRules"
import * as THREE from "three"
import { resolvedComponents } from "../../model/ruleAreas"
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js"
import { boardColors, boardFinish, finishMetal, mountingHoles } from "../../model/board"
import { isNpth, pcbPads, slotEnds, type WorldPad } from "../../model/instances"
import { outlineGeometry, pointInRing } from "../../model/outline"
import { holeCentre } from "../../model/padDistance"
import { polygonKit, withMaxError, type ZoneFill } from "../../model/pour"
import type { ComponentInstance, Project, Vec2 } from "../../model/types"
import { buildBoardTextures, type BoardTextureSet } from "./boardTextures"
import { contactShadow, createContactShadowMaterial } from "./contactShadow"
import { onBoard } from "../../model/partFlags"

// Finished copper plus surface finish stands this far proud of the mask (mm).
const PAD_DEPTH = 0.035
const LIFT = 0.0015

export interface SharedMaterials {
  edge: THREE.MeshStandardMaterial
  hidden: THREE.MeshBasicMaterial
  /** Exposed pads by finish metal, and the plated hole walls under them. */
  pad: Record<FinishMetal, THREE.MeshPhysicalMaterial>
  barrel: Record<FinishMetal, THREE.MeshStandardMaterial>
  /** The soft shadow under each part's model (`contactShadow.ts`). */
  contact: THREE.ShaderMaterial
}

type FinishMetal = ReturnType<typeof finishMetal>

export function createSharedMaterials(): SharedMaterials {
  return {
    // Cut FR4 edge: pale glass-epoxy.
    edge: new THREE.MeshStandardMaterial({ color: "#968c66", roughness: 0.9, metalness: 0 }),
    hidden: new THREE.MeshBasicMaterial({ visible: false }),
    pad: {
      gold: new THREE.MeshPhysicalMaterial({ color: "#efc983", metalness: 1, roughness: 0.3, envMapIntensity: 1.8 }),
      tin: new THREE.MeshPhysicalMaterial({ color: "#dcdee3", metalness: 1, roughness: 0.34, envMapIntensity: 1.6 }),
      copper: new THREE.MeshPhysicalMaterial({ color: "#e0a07a", metalness: 1, roughness: 0.32, envMapIntensity: 1.6 }),
    },
    barrel: {
      gold: new THREE.MeshStandardMaterial({ color: "#a3804a", metalness: 1, roughness: 0.58, side: THREE.DoubleSide }),
      tin: new THREE.MeshStandardMaterial({ color: "#8e9096", metalness: 1, roughness: 0.6, side: THREE.DoubleSide }),
      copper: new THREE.MeshStandardMaterial({ color: "#9a6644", metalness: 1, roughness: 0.6, side: THREE.DoubleSide }),
    },
    contact: createContactShadowMaterial(),
  }
}

export function disposeSharedMaterials(m: SharedMaterials) {
  for (const mat of [m.edge, m.hidden, m.contact, ...Object.values(m.pad), ...Object.values(m.barrel)]) mat.dispose()
}

// ---------- 2D shapes (board plane is XY, mm, y up) ----------

function roundedRect(cx: number, cy: number, w: number, h: number, r: number): THREE.Shape {
  const rr = Math.max(0, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3))
  const x0 = cx - w / 2
  const y0 = cy - h / 2
  const s = new THREE.Shape()
  if (rr <= 0) {
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

function circlePath(cx: number, cy: number, r: number): THREE.Path {
  const p = new THREE.Path()
  p.absarc(cx, cy, r, 0, Math.PI * 2, true)
  return p
}

function circleShape(cx: number, cy: number, r: number): THREE.Shape {
  const s = new THREE.Shape()
  s.absarc(cx, cy, r, 0, Math.PI * 2, false)
  return s
}

function capsule(a: Vec2, b: Vec2, r: number): THREE.Shape {
  const theta = Math.atan2(b.y - a.y, b.x - a.x)
  const s = new THREE.Shape()
  s.absarc(b.x, b.y, r, theta - Math.PI / 2, theta + Math.PI / 2, false)
  s.absarc(a.x, a.y, r, theta + Math.PI / 2, theta + Math.PI * 1.5, false)
  s.closePath()
  return s
}

function padShape(pad: WorldPad): THREE.Shape {
  let s: THREE.Shape
  if (pad.shape === "circle") {
    s = circleShape(pad.x, pad.y, pad.width / 2)
  } else if (pad.shape === "pill") {
    const horizontal = pad.width >= pad.height
    const r = Math.min(pad.width, pad.height) / 2
    const half = Math.max(pad.width, pad.height) / 2 - r
    if (half < 1e-4) s = circleShape(pad.x, pad.y, r)
    else {
      const a = horizontal ? { x: pad.x - half, y: pad.y } : { x: pad.x, y: pad.y - half }
      const b = horizontal ? { x: pad.x + half, y: pad.y } : { x: pad.x, y: pad.y + half }
      s = capsule(a, b, r)
    }
  } else if (pad.shape === "polygon" && pad.points && pad.points.length >= 3) {
    s = new THREE.Shape(pad.points.map((p) => new THREE.Vector2(p.x, p.y)))
  } else {
    s = roundedRect(pad.x, pad.y, pad.width, pad.height, pad.x7 ? (pad.corner ?? 0) : Math.min(pad.width, pad.height) * 0.12)
  }
  if (pad.holeDiameter) s.holes.push(holePath(pad))
  return s
}

/**
 * A pad as the shapes to extrude: one, or for a custom pad of several rings (holes in it, pieces) one per outer ring with the holes inside it.
 * The pad's drill is cut from the shape it lies in.
 */
function padShapes(pad: WorldPad): THREE.Shape[] {
  if (!pad.rings || pad.rings.length < 2) return [padShape(pad)]
  const regions = withMaxError(undefined, () => polygonKit.regions(polygonKit.unionEvenOdd(pad.rings!.map((r) => polygonKit.path(r)))), 1e6)
  const out = regions.map((poly) => {
    const sh = new THREE.Shape(poly[0].map((p) => new THREE.Vector2(p.x, p.y)))
    for (const hole of poly.slice(1)) sh.holes.push(new THREE.Path(hole.map((p) => new THREE.Vector2(p.x, p.y))))
    return sh
  })
  if (pad.holeDiameter && out.length) {
    const at = holeCentre(pad)
    const owner = out.find((_, i) => pointInRing(at, regions[i][0])) ?? out[0]
    owner.holes.push(holePath(pad))
  }
  return out
}

/** Outline of a pad's drill: a circle, or a capsule for a slot. */
function holePath(pad: WorldPad): THREE.Path {
  const ends = slotEnds(pad)
  const r = (pad.holeDiameter ?? 0) / 2
  const at = holeCentre(pad)
  return ends ? capsule(ends[0], ends[1], r) : circlePath(at.x, at.y, r)
}

/** Extruded slab with only its top (or bottom) cap and walls; z0 is the face it sits on. */
function slab(shape: THREE.Shape, depth: number, z0: number, down: boolean): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 20 })
  g.translate(0, 0, down ? z0 - depth : z0)
  return g
}

function mergeInto(group: THREE.Group, geoms: THREE.BufferGeometry[], material: THREE.Material, name: string, shadows = true) {
  if (!geoms.length) return
  const merged = mergeGeometries(geoms.map((g) => (g.index ? g.toNonIndexed() : g)), false)
  for (const g of geoms) g.dispose()
  if (!merged) return
  const mesh = new THREE.Mesh(merged, material)
  mesh.name = name
  mesh.castShadow = shadows
  mesh.receiveShadow = true
  group.add(mesh)
}

/** Flat face at height z with UVs spanning the board rectangle; `down` flips it to face -z. */
function boardFace(outline: THREE.Shape | THREE.Shape[], z: number, down: boolean, bounds: { minX: number; minY: number; w: number; h: number }) {
  const g = new THREE.ShapeGeometry(outline, 32)
  const pos = g.attributes.position
  const uv = g.attributes.uv
  for (let i = 0; i < pos.count; i++) {
    uv.setXY(i, (pos.getX(i) - bounds.minX) / bounds.w, (pos.getY(i) - bounds.minY) / bounds.h)
    pos.setZ(i, z)
  }
  if (down && g.index) {
    const idx = g.index.array as Uint16Array | Uint32Array
    for (let i = 0; i < idx.length; i += 3) {
      const t = idx[i + 1]
      idx[i + 1] = idx[i + 2]
      idx[i + 2] = t
    }
    g.index.needsUpdate = true
  }
  g.computeVertexNormals()
  return g
}

// ---------- Board ----------

export interface BoardBuild {
  group: THREE.Group
  textures: BoardTextureSet
  faceMaterials: THREE.Material[]
  placedCount: number
}

export function placedComponents(project: Project): ComponentInstance[] {
  return resolvedComponents(project).filter((c) => c.pcb.placed && onBoard(c))
}

export function buildBoard(project: Project, fills: ZoneFill[], shared: SharedMaterials, anisotropy: number): BoardBuild {
  const group = new THREE.Group()
  group.name = "board"
  const b = project.board
  const t = b.thickness
  const minX = b.x - b.width / 2
  const minY = b.y - b.height / 2
  // A board with an outline of its own (and at least one loop in it): the pieces it is, cutouts and all. Otherwise the rectangle.
  const found = outlineGeometry(b)
  const custom = found && found.rings.length ? found : null
  const insideBoard = (x: number, y: number, r: number) =>
    custom ? custom.contains({ x, y }) && custom.nearest({ x, y }, r + 1e-3) === Infinity : x - r > minX && x + r < minX + b.width && y - r > minY && y + r < minY + b.height

  const placed = placedComponents(project)
  const padsByComponent = new Map(placed.map((c) => [c.id, pcbPads(c)]))
  const holesMounting = mountingHoles(b)

  // Drilled holes: through-hole pads, vias, mounting holes. Non-plated holes are bare FR4.
  const holes: { x: number; y: number; r: number; bare?: boolean; slot?: [Vec2, Vec2] }[] = []
  for (const pads of padsByComponent.values()) {
    for (const p of pads) {
      if (!p.holeDiameter) continue
      const slot = slotEnds(p) ?? undefined
      const at = holeCentre(p)
      holes.push({ x: at.x, y: at.y, r: p.holeDiameter / 2, bare: isNpth(p), slot })
    }
  }
  // Only a through via is drilled through the whole board; blind, buried and micro vias are inside it (X5).
  for (const v of project.vias) if (!v.kind) holes.push({ x: v.x, y: v.y, r: v.drill / 2 })
  for (const h of holesMounting) holes.push({ x: h.x, y: h.y, r: h.drill / 2 })

  const ringShape = (pts: Vec2[]) => {
    const sh = new THREE.Shape()
    pts.forEach((q, i) => (i ? sh.lineTo(q.x, q.y) : sh.moveTo(q.x, q.y)))
    sh.closePath()
    return sh
  }
  const outlines: THREE.Shape[] = custom
    ? custom.regions.map((r) => {
        const sh = ringShape(r.outer)
        for (const hole of r.holes) sh.holes.push(new THREE.Path(hole.map((q) => new THREE.Vector2(q.x, q.y))))
        return sh
      })
    : [roundedRect(b.x, b.y, b.width, b.height, b.cornerRadius)]
  const outline = outlines
  const shapeOf = (x: number, y: number) => {
    if (!custom) return outlines[0]
    const ring = custom.rings.find((q) => !q.hole && pointInRing({ x, y }, q.pts))
    return ring ? outlines[ring.region] : outlines[0]
  }
  const accepted: typeof holes = []
  // A slot is tested as the circle round its whole length.
  const reach = (h: (typeof holes)[number]) => (h.slot ? h.r + Math.hypot(h.slot[1].x - h.x, h.slot[1].y - h.y) : h.r)
  for (const h of holes) {
    if (!insideBoard(h.x, h.y, reach(h))) continue
    // Overlapping contours break triangulation; keep the first.
    if (accepted.some((o) => Math.hypot(o.x - h.x, o.y - h.y) < reach(o) + reach(h) + 0.02)) continue
    accepted.push(h)
    shapeOf(h.x, h.y).holes.push(h.slot ? capsule(h.slot[0], h.slot[1], h.r) : circlePath(h.x, h.y, h.r))
  }

  // Walls (outline edge and hole walls) in FR4; caps replaced by textured faces.
  const substrate = new THREE.ExtrudeGeometry(outline, { depth: t, bevelEnabled: false, curveSegments: 28 })
  substrate.translate(0, 0, -t / 2)
  const walls = new THREE.Mesh(substrate, [shared.hidden, shared.edge])
  walls.name = "substrate"
  walls.castShadow = true
  walls.receiveShadow = true
  group.add(walls)

  const textures = buildBoardTextures({ project, placed, padsByComponent, fills, anisotropy })
  const bounds = { minX, minY, w: b.width, h: b.height }
  const faceMat = (side: "top" | "bottom") =>
    new THREE.MeshPhysicalMaterial({
      color: "#ffffff",
      map: textures[side].albedo,
      bumpMap: textures[side].surface,
      bumpScale: 1.6,
      roughnessMap: textures[side].surface,
      roughness: 1,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.3,
      clearcoatRoughnessMap: textures[side].surface,
      // The clearcoat carries the gloss; a strong base lobe reads as a milky haze.
      specularIntensity: 0.06,
      envMapIntensity: 0.75,
    })
  const topMat = faceMat("top")
  const bottomMat = faceMat("bottom")
  const top = new THREE.Mesh(boardFace(outline, t / 2, false, bounds), topMat)
  const bottom = new THREE.Mesh(boardFace(outline, -t / 2, true, bounds), bottomMat)
  top.name = "mask-top"
  bottom.name = "mask-bottom"
  for (const m of [top, bottom]) {
    m.receiveShadow = true
    m.castShadow = true
    group.add(m)
  }

  // Exposed copper: SMD pads, through-hole rings on both faces, mounting-hole rings.
  const finish = finishMetal(boardFinish(b))
  const metal = shared.pad[finish]
  const barrelMat = shared.barrel[finish]
  const copper: THREE.BufferGeometry[] = []
  const topZ = t / 2 + LIFT
  const bottomZ = -t / 2 - LIFT
  for (const pads of padsByComponent.values()) {
    for (const p of pads) {
      if (!insideBoard(p.x, p.y, 0) || (isNpth(p) && !p.ring)) continue
      const sides = isNpth(p) ? p.ring! : p.layers
      for (const shape of padShapes(p)) {
        if (sides.includes("top")) copper.push(slab(shape, PAD_DEPTH, topZ, false))
        if (sides.includes("bottom")) copper.push(slab(shape, PAD_DEPTH, bottomZ, true))
      }
    }
  }
  const viaSide = (v: (typeof project.vias)[number], side: "top" | "bottom") => viaLayers(project.board, v).includes(side) && !viaTentedOn(project.rules, v, side)
  for (const h of holesMounting) {
    const ring = circleShape(h.x, h.y, h.diameter / 2)
    ring.holes.push(circlePath(h.x, h.y, h.drill / 2))
    copper.push(slab(ring, PAD_DEPTH, topZ, false))
    copper.push(slab(ring, PAD_DEPTH, bottomZ, true))
  }
  for (const v of project.vias) {
    // A through via has a hole in its ring; a blind one is closed on the side it does not reach, so its ring has no hole to show.
    const hole = !v.kind
    for (const side of ["top", "bottom"] as const) {
      if (!viaSide(v, side)) continue
      const ring = circleShape(v.x, v.y, v.diameter / 2)
      if (hole) ring.holes.push(circlePath(v.x, v.y, v.drill / 2))
      copper.push(slab(ring, PAD_DEPTH, side === "top" ? topZ : bottomZ, side === "bottom"))
    }
  }
  mergeInto(group, copper, metal, "copper", false)

  // Plated barrels for pad and mounting holes, and for vias unless they're tented: then mask
  // dips into the hole and closes it, so they read as small dimples rather than open holes.
  const viaAt = new Set(project.vias.filter((v) => !v.kind && viaTentedOn(project.rules, v, "top") && viaTentedOn(project.rules, v, "bottom")).map((v) => `${v.x},${v.y}`))
  const barrels: THREE.BufferGeometry[] = []
  const plugs: THREE.BufferGeometry[] = []
  for (const h of accepted) {
    if (h.bare) continue
    if (viaAt.has(`${h.x},${h.y}`)) {
      for (const z of [t / 2 - 0.06, -t / 2 + 0.06]) {
        const g = new THREE.CircleGeometry(h.r, 20)
        if (z < 0) g.rotateX(Math.PI)
        g.translate(h.x, h.y, z)
        plugs.push(g)
      }
      continue
    }
    if (h.slot) {
      // Plated slot wall: a thin capsule ring the board's thickness deep.
      const wall = capsule(h.slot[0], h.slot[1], h.r + 0.02)
      wall.holes.push(capsule(h.slot[0], h.slot[1], h.r))
      barrels.push(slab(wall, t + PAD_DEPTH * 2, -t / 2 - PAD_DEPTH, false))
      continue
    }
    const segments = Math.max(28, Math.min(72, Math.round(h.r * 40)))
    const g = new THREE.CylinderGeometry(h.r, h.r, t + PAD_DEPTH * 2, segments, 1, true)
    g.rotateX(Math.PI / 2)
    g.translate(h.x, h.y, 0)
    barrels.push(g)
  }
  mergeInto(group, barrels, barrelMat, "barrels", false)
  const tentMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(boardColors(b).mask).multiplyScalar(0.55),
    roughness: 0.45,
    clearcoat: 1,
    clearcoatRoughness: 0.2,
    specularIntensity: 0.2,
  })
  mergeInto(group, plugs, tentMat, "via-tents", false)

  return { group, textures, faceMaterials: [topMat, bottomMat, tentMat], placedCount: placed.length }
}

// ---------- Parts ----------

/** Where a component's model goes: rotated about z, and bottom-side parts flipped about local y onto the bottom face. */
export function partHolder(project: Project, c: ComponentInstance): { holder: THREE.Group; content: THREE.Group } {
  const t = project.board.thickness
  const holder = new THREE.Group()
  holder.name = c.ref
  holder.userData.componentId = c.id
  const bottom = c.pcb.side === "bottom"
  holder.position.set(c.pcb.x, c.pcb.y, bottom ? -t / 2 : t / 2)
  holder.rotation.z = THREE.MathUtils.degToRad(c.pcb.rot)
  let content = holder
  if (bottom) {
    content = new THREE.Group()
    content.rotation.y = Math.PI
    content.userData.flip = true
    holder.add(content)
  }
  return { holder, content }
}

/** Hold one component's model where it goes on the board, with its shadow on the board under it. */
export function partModel(project: Project, c: ComponentInstance, model: THREE.Group, shared: SharedMaterials): THREE.Group {
  const { holder, content } = partHolder(project, c)
  // Measured before the model is in the holder, so in the footprint's own frame.
  const shadow = contactShadow(model, shared.contact)
  content.add(model)
  if (shadow) content.add(shadow)
  return holder
}

/**
 * Place each component's model: `model` gives a part's model file when it has one and it is read.
 * A part with none has no holder, and the board shows only its pads, as KiCad's 3D viewer does.
 */
export function buildParts(project: Project, model: (c: ComponentInstance) => THREE.Group | null, shared: SharedMaterials): THREE.Group {
  const parts = new THREE.Group()
  parts.name = "parts"
  for (const c of placedComponents(project)) {
    const m = model(c)
    if (m) parts.add(partModel(project, c, m, shared))
  }
  return parts
}

/** Dispose geometries under a group; materials are cached and owned elsewhere, and real model files' meshes are shared. */
export function disposeGeometries(group: THREE.Object3D) {
  group.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (mesh.userData.shared) return
    if (mesh.isMesh || (o as THREE.LineSegments).isLineSegments) mesh.geometry?.dispose()
  })
}
