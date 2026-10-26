import * as THREE from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import { componentModel } from "../../model/models3d"
import type { ZoneFill } from "../../model/pour"
import type { ComponentInstance, Model3D, Project } from "../../model/types"
import {
  buildBoard,
  buildParts,
  createSharedMaterials,
  disposeGeometries,
  disposeSharedMaterials,
  generatedModel,
  placedComponents,
  swapPartModel,
  type BoardBuild,
  type SharedMaterials,
} from "./buildBoard"
import { modelLibrary } from "./files/library"
import { placeModel } from "./files/place"
import { ModelMaterials } from "./models"
import { StudioFloor } from "./studio"
import { createStudioEnvironment } from "./studioEnvironment"
import { ViewCube } from "./viewCube"

export type CameraPreset = "home" | "top" | "bottom"

/** How the parts' real model files are doing, for the 3D view's status line. */
export interface ModelStatus {
  /** Model files the board uses. */
  total: number
  loading: number
  /** Files that couldn't be drawn, by name, with why; their parts show their generated bodies. */
  failed: { name: string; error: string }[]
}

const FOV = 30
const TWEEN_MS = 480
/** Default three-quarter view: from the front right, fairly high. */
const HOME_DIR = new THREE.Vector3(0.5, -1.05, 1.15).normalize()
const KEY_DIR = new THREE.Vector3(-0.42, -0.62, 1.25).normalize()

export const BACKDROP = { center: "#2d2a36", mid: "#1d1b23", edge: "#121116" }

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

interface Tween {
  fromDir: THREE.Vector3
  rotation: THREE.Quaternion
  fromDist: number
  toDist: number
  fromTarget: THREE.Vector3
  toTarget: THREE.Vector3
  start: number
}

/** Owns the renderer, camera, lights and floor; rebuilds board and part meshes when the project changes. */
export class BoardScene {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 4000)
  private controls: OrbitControls
  private envTexture: THREE.Texture
  private key: THREE.DirectionalLight
  private shared: SharedMaterials = createSharedMaterials()
  private models = new ModelMaterials()
  private content = new THREE.Group()
  private board: BoardBuild | null = null
  private parts: THREE.Group | null = null
  private floor: StudioFloor | null = null
  private floorKey = ""
  private selectionBox: THREE.Box3Helper | null = null
  private selectedId: string | null = null
  private partsVisible = true
  private realModels = true
  private modelsFrame = 0
  private stopModels: () => void
  private gridVisible = true
  private fitKey = ""
  private bounds = new THREE.Box3(new THREE.Vector3(-25, -20, -1), new THREE.Vector3(25, 20, 1))
  private boardRect = { x: 0, y: 0, width: 50, height: 40 }
  private last: { project: Project; fills: ZoneFill[] } | null = null
  private frame = 0
  private tween: Tween | null = null
  private observer: ResizeObserver
  private cube: ViewCube | null = null
  private raycaster = new THREE.Raycaster()
  private downAt: { x: number; y: number } | null = null
  private reducedMotion = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches

  /** Called with a component id when a part is clicked, null for empty space. */
  onPickPart: ((id: string | null) => void) | null = null
  /** Called whenever the real model files' progress changes. */
  onModelStatus: ((status: ModelStatus) => void) | null = null

  constructor(
    private host: HTMLElement,
    cubeHost: HTMLElement | null,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.toneMapping = THREE.NeutralToneMapping
    this.renderer.toneMappingExposure = 1.08
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    const canvas = this.renderer.domElement
    canvas.style.display = "block"
    canvas.style.width = "100%"
    canvas.style.height = "100%"
    canvas.style.touchAction = "none"
    host.appendChild(canvas)

    this.envTexture = createStudioEnvironment(this.renderer)
    this.scene.environment = this.envTexture
    this.scene.environmentIntensity = 1

    this.scene.add(new THREE.HemisphereLight("#f4f1ff", "#2a2633", 0.35))
    this.key = new THREE.DirectionalLight("#fff6ea", 2.1)
    this.key.castShadow = true
    this.key.shadow.mapSize.set(2048, 2048)
    this.key.shadow.radius = 5
    this.key.shadow.bias = -0.0004
    this.key.shadow.normalBias = 0.02
    this.scene.add(this.key, this.key.target)
    const rim = new THREE.DirectionalLight("#dfe6ff", 0.55)
    rim.position.set(0.7, 1.1, 0.6)
    // Lights only faces pointing down, i.e. the underside in bottom views.
    const under = new THREE.DirectionalLight("#f3f0ff", 1.5)
    under.position.set(-0.3, -0.6, -1)
    this.scene.add(rim, under)
    this.scene.add(this.content)

    // Board lies in the XY plane with Z up, matching PCB coordinates.
    this.camera.up.set(0, 0, 1)
    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.12
    this.controls.screenSpacePanning = true
    this.controls.zoomToCursor = true
    this.controls.rotateSpeed = 0.8
    this.controls.addEventListener("change", this.requestRender)
    this.controls.addEventListener("start", () => {
      this.tween = null
      this.requestRender()
    })

    if (cubeHost) {
      this.cube = new ViewCube(
        cubeHost,
        (dir) => this.viewDirection(dir),
        (dx, dy) => this.orbitBy(dx, dy),
      )
    }

    canvas.addEventListener("pointerdown", this.onPointerDown)
    canvas.addEventListener("pointerup", this.onPointerUp)

    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(host)
    if (cubeHost) this.observer.observe(cubeHost)
    this.resize()

    // A model file read anywhere on the page (another view, an export) is one this board may use.
    this.stopModels = modelLibrary.subscribe(() => {
      if (!this.modelsFrame && !this.disposed) this.modelsFrame = requestAnimationFrame(this.refreshModels)
    })
  }

  get maxAnisotropy() {
    return this.renderer.capabilities.getMaxAnisotropy()
  }

  /** Rebuild what changed. Returns the number of parts on the board. */
  setProject(project: Project | null, fills: ZoneFill[]): number {
    if (!project) {
      this.clearBoard()
      this.clearParts()
      this.last = null
      this.requestRender()
      return 0
    }
    const prev = this.last
    const b = project.board
    const pb = prev?.project.board
    const partsChanged =
      !prev || !this.parts || prev.project.components !== project.components || prev.project.models !== project.models || pb?.thickness !== b.thickness
    const boardChanged =
      !prev ||
      !this.board ||
      partsChanged ||
      prev.project.traces !== project.traces ||
      prev.project.vias !== project.vias ||
      prev.project.texts !== project.texts ||
      prev.project.board !== project.board ||
      // Mask expansion and tented vias change what the board shows.
      prev.project.rules !== project.rules ||
      prev.fills !== fills
    this.last = { project, fills }

    if (boardChanged) {
      this.clearBoard()
      this.board = buildBoard(project, fills, this.shared, this.maxAnisotropy)
      this.content.add(this.board.group)
    }
    if (partsChanged) this.rebuildParts(project)

    this.boardRect = { x: b.x, y: b.y, width: b.width, height: b.height }
    this.updateBounds()
    this.updateFloor(project)
    this.fitShadow()

    const key = `${b.width}x${b.height}@${b.x},${b.y}`
    if (key !== this.fitKey) {
      const first = this.fitKey === ""
      this.fitKey = key
      this.view("home", !first)
    }
    this.requestRender()
    return this.board?.placedCount ?? 0
  }

  /** Draw parts' real model files (on), or only their generated bodies (off). */
  setRealModels(on: boolean) {
    if (on === this.realModels) return
    this.realModels = on
    if (!this.last) return
    this.rebuildParts(this.last.project)
    this.afterPartsChanged(this.last.project)
  }

  /** Wait, at most `ms`, for the board's model files to be read, and draw them: for a picture taken at once. */
  async modelsReady(ms: number) {
    const project = this.last?.project
    if (!project || !this.realModels) return
    const models = new Map<string, Model3D>()
    for (const c of placedComponents(project)) {
      const m = componentModel(project, c)
      if (m) models.set(`${m.source}:${m.id}`, m)
    }
    if (!models.size) return
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([Promise.allSettled([...models.values()].map((m) => modelLibrary.load(m))), new Promise((r) => (timer = setTimeout(r, ms)))])
    clearTimeout(timer)
    if (this.modelsFrame) cancelAnimationFrame(this.modelsFrame)
    this.refreshModels()
  }

  /** Try model files that failed again. */
  retryModels() {
    modelLibrary.retryFailed()
    if (!this.last) return
    this.rebuildParts(this.last.project)
    this.afterPartsChanged(this.last.project)
  }

  /** A component's real model, placed, when it has one and its file is read; asks for the file when it isn't. */
  private realModel = (project: Project, c: ComponentInstance): THREE.Group | null => {
    if (!this.realModels) return null
    const model = componentModel(project, c)
    if (!model) return null
    const object = modelLibrary.peek(model)
    if (object) return placeModel(model, object)
    modelLibrary.request(model)
    return null
  }

  private realModelReady(project: Project, c: ComponentInstance): boolean {
    const model = componentModel(project, c)
    return !!model && !!modelLibrary.peek(model)
  }

  private rebuildParts(project: Project) {
    this.clearParts()
    this.parts = buildParts(project, this.models, (c) => this.realModel(project, c))
    this.parts.visible = this.partsVisible
    this.content.add(this.parts)
    this.updateSelectionBox()
    this.reportModels(project)
  }

  /** Swap in the real models whose files have been read since the parts were built. */
  private refreshModels = () => {
    this.modelsFrame = 0
    const project = this.last?.project
    if (!project || !this.parts || this.disposed) return
    const placed = placedComponents(project)
    const byId = new Map(placed.map((c) => [c.id, c]))
    // A part with no generated body has no holder to swap into: build the parts again once its file is read.
    const held = new Set(this.parts.children.map((h) => h.userData.componentId as string))
    if (this.realModels && placed.some((c) => !held.has(c.id) && this.realModelReady(project, c))) {
      this.rebuildParts(project)
      this.afterPartsChanged(project)
      return
    }
    let changed = false
    for (const holder of this.parts.children) {
      const c = byId.get(holder.userData.componentId as string)
      if (!c) continue
      const real = this.realModel(project, c)
      if (real) {
        if (holder.userData.real) continue
        swapPartModel(holder, real, true)
        changed = true
      } else if (holder.userData.real) {
        // Its file was forgotten (retried): back to the generated body until it is read again.
        const generated = generatedModel(project, c, this.models)
        if (generated) swapPartModel(holder, generated, false)
        changed = true
      }
    }
    this.reportModels(project)
    if (!changed) return
    this.afterPartsChanged(project)
  }

  private afterPartsChanged(project: Project) {
    this.updateSelectionBox()
    this.updateBounds()
    this.updateFloor(project)
    this.fitShadow()
    this.requestRender()
  }

  private reportModels(project: Project) {
    if (!this.onModelStatus) return
    const seen = new Map<string, Model3D>()
    for (const c of placedComponents(project)) {
      const m = componentModel(project, c)
      if (m) seen.set(`${m.source}:${m.id}`, m)
    }
    const status: ModelStatus = { total: this.realModels ? seen.size : 0, loading: 0, failed: [] }
    if (this.realModels) {
      for (const m of seen.values()) {
        const state = modelLibrary.state(m)
        if (state === "loading" || state === "idle") status.loading++
        else if (state === "failed") status.failed.push({ name: m.name, error: modelLibrary.error(m) ?? "" })
      }
    }
    this.onModelStatus(status)
  }

  setPartsVisible(visible: boolean) {
    this.partsVisible = visible
    if (this.parts) this.parts.visible = visible
    if (this.selectionBox) this.selectionBox.visible = visible
    this.updateBounds()
    this.fitShadow()
    this.requestRender()
  }

  setGridVisible(visible: boolean) {
    this.gridVisible = visible
    if (this.floor) {
      this.floor.group.children.forEach((c) => {
        if (c.name !== "shadow-catcher") c.visible = visible
      })
    }
    this.requestRender()
  }

  setSelected(componentId: string | null) {
    if (componentId === this.selectedId) return
    this.selectedId = componentId
    this.updateSelectionBox()
    this.requestRender()
  }

  private updateSelectionBox() {
    if (this.selectionBox) {
      this.scene.remove(this.selectionBox)
      this.selectionBox.geometry.dispose()
      ;(this.selectionBox.material as THREE.Material).dispose()
      this.selectionBox = null
    }
    if (!this.selectedId || !this.parts) return
    const holder = this.parts.children.find((c) => c.userData.componentId === this.selectedId)
    if (!holder) return
    const box = new THREE.Box3().setFromObject(holder)
    if (box.isEmpty()) return
    box.expandByScalar(0.25)
    this.selectionBox = new THREE.Box3Helper(box, new THREE.Color("#6f97ff"))
    ;(this.selectionBox.material as THREE.LineBasicMaterial).depthTest = false
    this.selectionBox.renderOrder = 10
    this.selectionBox.visible = this.partsVisible
    this.scene.add(this.selectionBox)
  }

  private clearBoard() {
    if (!this.board) return
    this.content.remove(this.board.group)
    disposeGeometries(this.board.group)
    this.board.textures.dispose()
    for (const m of this.board.faceMaterials) m.dispose()
    this.board = null
  }

  private clearParts() {
    if (!this.parts) return
    this.content.remove(this.parts)
    disposeGeometries(this.parts)
    this.parts = null
  }

  private updateBounds() {
    const box = new THREE.Box3()
    if (this.board) box.expandByObject(this.board.group)
    if (this.parts && this.partsVisible) box.expandByObject(this.parts)
    if (box.isEmpty()) {
      const { x, y, width, height } = this.boardRect
      box.set(new THREE.Vector3(x - width / 2, y - height / 2, -1), new THREE.Vector3(x + width / 2, y + height / 2, 1))
    }
    this.bounds = box
  }

  private updateFloor(project: Project) {
    const b = project.board
    // Rest the floor just under the lowest geometry (through-hole leads, bottom-side parts).
    const all = new THREE.Box3()
    if (this.board) all.expandByObject(this.board.group)
    if (this.parts) all.expandByObject(this.parts)
    const z = Math.round((Math.min(all.isEmpty() ? -b.thickness / 2 : all.min.z, -b.thickness / 2) - 0.6) * 10) / 10
    const key = `${b.x},${b.y},${b.width},${b.height},${z}`
    if (key === this.floorKey && this.floor) return
    this.floorKey = key
    if (this.floor) {
      this.scene.remove(this.floor.group)
      this.floor.dispose()
    }
    this.floor = new StudioFloor({
      minX: b.x - b.width / 2,
      maxX: b.x + b.width / 2,
      minY: b.y - b.height / 2,
      maxY: b.y + b.height / 2,
      z,
    })
    this.scene.add(this.floor.group)
    this.setGridVisible(this.gridVisible)
  }

  /** Fit the key light's shadow frustum tightly around the board and its parts. */
  private fitShadow() {
    const sphere = this.bounds.getBoundingSphere(new THREE.Sphere())
    const r = Math.max(sphere.radius, 5)
    const c = sphere.center
    this.key.position.copy(c).addScaledVector(KEY_DIR, r * 4)
    this.key.target.position.copy(c)
    this.key.target.updateMatrixWorld()
    const cam = this.key.shadow.camera
    // Include the floor shadow cast by the board, which lands down-light of the board.
    const s = r * 1.35
    cam.left = -s
    cam.right = s
    cam.top = s
    cam.bottom = -s
    cam.near = r * 0.5
    cam.far = r * 8
    cam.updateProjectionMatrix()
    this.key.shadow.needsUpdate = true
  }

  private fitDistance(): number {
    const size = this.bounds.getSize(new THREE.Vector3())
    const radius = Math.max(0.5 * Math.hypot(size.x, size.y, size.z), 5)
    const vFov = THREE.MathUtils.degToRad(FOV)
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect)
    return (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 1.06
  }

  view(preset: CameraPreset, animate = true) {
    if (preset === "top") this.viewDirection(new THREE.Vector3(0, 0, 1), animate, true)
    else if (preset === "bottom") this.viewDirection(new THREE.Vector3(0, 0, -1), animate, true)
    else this.viewDirection(HOME_DIR.clone(), animate, true)
  }

  /** Look at the board from `dir` (pointing from the board towards the camera). */
  viewDirection(dir: THREE.Vector3, animate = true, refit = false) {
    const center = this.bounds.getCenter(new THREE.Vector3())
    const target = refit ? center : this.controls.target.clone()
    const dist = refit ? this.fitDistance() : Math.max(this.camera.position.distanceTo(this.controls.target), this.fitDistance() * 0.3)
    const d = dir.clone().normalize()
    // Straight down/up is a pole for z-up orbiting; nudge so the board's north stays up.
    if (Math.abs(d.z) > 0.9995) d.set(0, d.z > 0 ? -0.002 : 0.002, Math.sign(d.z)).normalize()
    const pos = target.clone().addScaledVector(d, dist)
    this.camera.near = Math.max(0.05, dist / 300)
    this.camera.far = dist * 40
    this.camera.updateProjectionMatrix()
    this.controls.minDistance = Math.max(2, this.fitDistance() * 0.06)
    this.controls.maxDistance = this.fitDistance() * 6

    if (!animate || this.reducedMotion) {
      this.tween = null
      this.camera.position.copy(pos)
      this.controls.target.copy(target)
      this.controls.update()
      this.requestRender()
      return
    }
    // Swing around the target rather than cutting through it.
    const fromOffset = this.camera.position.clone().sub(this.controls.target)
    const fromDir = fromOffset.clone().normalize()
    this.tween = {
      fromDir,
      rotation: new THREE.Quaternion().setFromUnitVectors(fromDir, d),
      fromDist: fromOffset.length(),
      toDist: dist,
      fromTarget: this.controls.target.clone(),
      toTarget: target,
      start: performance.now(),
    }
    this.requestRender()
  }

  /** Place the camera explicitly (automation and tests). */
  lookFrom(position: [number, number, number], target: [number, number, number]) {
    this.tween = null
    this.controls.target.set(...target)
    this.camera.position.set(...position)
    this.controls.update()
    this.requestRender()
  }

  /** Orbit from a drag on the view cube (pixels). */
  private orbitBy(dx: number, dy: number) {
    this.tween = null
    const target = this.controls.target
    const offset = this.camera.position.clone().sub(target)
    const k = 0.012
    offset.applyAxisAngle(new THREE.Vector3(0, 0, 1), -dx * k)
    const right = new THREE.Vector3().crossVectors(offset, new THREE.Vector3(0, 0, 1)).normalize()
    const tilted = offset.clone().applyAxisAngle(right, dy * k)
    // Stop short of the poles.
    if (Math.abs(tilted.clone().normalize().z) < 0.999) offset.copy(tilted)
    this.camera.position.copy(target).add(offset)
    this.camera.lookAt(target)
    this.controls.update()
    this.requestRender()
  }

  /** Render the current view on the studio backdrop into a canvas `width` pixels wide. */
  capture(width: number): HTMLCanvasElement {
    const canvas = this.renderer.domElement
    const ratio = this.renderer.getPixelRatio()
    const cssW = canvas.clientWidth || 1
    // A hair over, so the drawing buffer's floor() lands on `width` and not one short.
    this.renderer.setPixelRatio((width + 0.01) / cssW)
    this.resize(false)
    const boxVisible = this.selectionBox?.visible ?? false
    if (this.selectionBox) this.selectionBox.visible = false
    this.renderer.render(this.scene, this.camera)
    if (this.selectionBox) this.selectionBox.visible = boxVisible
    const out = document.createElement("canvas")
    out.width = canvas.width
    out.height = canvas.height
    const ctx = out.getContext("2d")!
    paintBackdrop(ctx, out.width, out.height)
    ctx.drawImage(canvas, 0, 0)
    this.renderer.setPixelRatio(ratio)
    this.resize()
    return out
  }

  /** Render a PNG of the current view on the studio backdrop. */
  async screenshot(): Promise<Blob | null> {
    const ratio = this.renderer.getPixelRatio()
    const cssW = this.renderer.domElement.clientWidth || 1
    const scale = Math.min(4096 / (cssW * ratio), Math.max(1, 2400 / (cssW * ratio)))
    const out = this.capture(cssW * ratio * scale)
    return new Promise((resolve) => out.toBlob((b) => resolve(b), "image/png"))
  }

  private resize(render = true) {
    const w = Math.max(1, this.host.clientWidth)
    const h = Math.max(1, this.host.clientHeight)
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.cube?.resize()
    if (render) this.requestRender()
  }

  private onPointerDown = (e: PointerEvent) => {
    this.downAt = e.button === 0 ? { x: e.clientX, y: e.clientY } : null
  }

  private onPointerUp = (e: PointerEvent) => {
    const down = this.downAt
    this.downAt = null
    if (!down || e.button !== 0 || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return
    if (!this.onPickPart) return
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(ndc, this.camera)
    let id: string | null = null
    if (this.parts?.visible) {
      const hit = this.raycaster.intersectObject(this.parts, true)[0]
      let o: THREE.Object3D | null = hit?.object ?? null
      while (o && !o.userData.componentId) o = o.parent
      id = (o?.userData.componentId as string | undefined) ?? null
    }
    this.onPickPart(id)
  }

  private disposed = false

  private requestRender = () => {
    if (!this.frame && !this.disposed) this.frame = requestAnimationFrame(this.tick)
  }

  private tick = () => {
    this.frame = 0
    let active = false
    if (this.tween) {
      const t = Math.min(1, (performance.now() - this.tween.start) / TWEEN_MS)
      const e = easeInOut(t)
      const tw = this.tween
      const q = new THREE.Quaternion().slerp(tw.rotation, e)
      const dir = tw.fromDir.clone().applyQuaternion(q)
      this.controls.target.lerpVectors(tw.fromTarget, tw.toTarget, e)
      this.camera.position.copy(this.controls.target).addScaledVector(dir, tw.fromDist + (tw.toDist - tw.fromDist) * e)
      if (t >= 1) this.tween = null
      else active = true
    }
    // update() returns true while damping is still settling.
    if (this.controls.update()) active = true
    this.renderer.render(this.scene, this.camera)
    this.cube?.sync(this.camera.quaternion)
    if (active) this.requestRender()
  }

  dispose() {
    // Set first: the teardown below (clearing the selection) would otherwise schedule a frame
    // that renders with a renderer that no longer has a context.
    this.disposed = true
    if (this.frame) cancelAnimationFrame(this.frame)
    if (this.modelsFrame) cancelAnimationFrame(this.modelsFrame)
    this.stopModels()
    this.observer.disconnect()
    const canvas = this.renderer.domElement
    canvas.removeEventListener("pointerdown", this.onPointerDown)
    canvas.removeEventListener("pointerup", this.onPointerUp)
    this.controls.removeEventListener("change", this.requestRender)
    this.controls.dispose()
    this.clearBoard()
    this.clearParts()
    this.setSelected(null)
    if (this.floor) {
      this.scene.remove(this.floor.group)
      this.floor.dispose()
    }
    this.cube?.dispose()
    disposeSharedMaterials(this.shared)
    this.models.dispose()
    this.envTexture.dispose()
    this.key.shadow.map?.dispose()
    this.renderer.dispose()
    // Browsers cap live WebGL contexts; release ours now rather than at garbage collection.
    this.renderer.forceContextLoss()
    canvas.remove()
  }
}

/** The CSS backdrop, painted into a 2D canvas for screenshots. */
export function paintBackdrop(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const g = ctx.createRadialGradient(w * 0.5, h * 0.42, 0, w * 0.5, h * 0.42, Math.hypot(w, h) * 0.62)
  g.addColorStop(0, BACKDROP.center)
  g.addColorStop(0.55, BACKDROP.mid)
  g.addColorStop(1, BACKDROP.edge)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
}

export const backdropCss = `radial-gradient(ellipse 90% 85% at 50% 42%, ${BACKDROP.center} 0%, ${BACKDROP.mid} 55%, ${BACKDROP.edge} 100%)`
