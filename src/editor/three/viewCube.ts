import * as THREE from "three"

const SIZE = 1
// Width of the edge/corner hot zones as a fraction of the cube size.
const BAND = 0.2

// BoxGeometry face order after rotating it into the z-up frame: +x, -x, +z, -z, -y, +y.
// Seen from below with north up, the bottom face's texture lands upside down; pre-rotate it.
const FACES = [
  { label: "Right", shade: 0.9, flip: false },
  { label: "Left", shade: 0.86, flip: false },
  { label: "Top", shade: 1, flip: false },
  { label: "Bottom", shade: 0.8, flip: true },
  { label: "Front", shade: 0.94, flip: false },
  { label: "Back", shade: 0.84, flip: false },
]

function faceTexture(label: string, shade: number, flip: boolean): THREE.CanvasTexture {
  const n = 256
  const canvas = document.createElement("canvas")
  canvas.width = n
  canvas.height = n
  const ctx = canvas.getContext("2d")!
  const v = Math.round(246 * shade)
  ctx.fillStyle = `rgb(${v},${Math.round(v * 0.995)},${Math.min(255, Math.round(v * 1.01))})`
  ctx.fillRect(0, 0, n, n)
  ctx.strokeStyle = "rgba(34,29,48,0.28)"
  ctx.lineWidth = 6
  ctx.strokeRect(3, 3, n - 6, n - 6)
  ctx.fillStyle = "#3b3450"
  ctx.font = `600 ${label.length > 5 ? 50 : 56}px "Geist Variable", ui-sans-serif, system-ui, sans-serif`
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  if (flip) {
    ctx.translate(n, n)
    ctx.rotate(Math.PI)
  }
  ctx.fillText(label, n / 2, n / 2 + 3)
  const t = new THREE.CanvasTexture(canvas)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

/** Orientation widget: mirrors the main camera and turns clicks into view directions. */
export class ViewCube {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10)
  private cube: THREE.Mesh
  private highlight: THREE.Mesh
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()
  private hover: THREE.Vector3 | null = null
  private textures: THREE.Texture[] = []
  private disposables: { dispose(): void }[] = []
  private quaternion = new THREE.Quaternion()
  private down: { x: number; y: number; dragged: boolean } | null = null

  constructor(
    private host: HTMLElement,
    private onPick: (dir: THREE.Vector3) => void,
    private onDragOrbit: (dx: number, dy: number) => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.setClearColor(0x000000, 0)
    const canvas = this.renderer.domElement
    canvas.style.width = "100%"
    canvas.style.height = "100%"
    canvas.style.display = "block"
    canvas.style.touchAction = "none"
    host.appendChild(canvas)

    const geom = new THREE.BoxGeometry(SIZE, SIZE, SIZE)
    geom.rotateX(Math.PI / 2)
    const mats = FACES.map((f) => {
      const t = faceTexture(f.label, f.shade, f.flip)
      this.textures.push(t)
      return new THREE.MeshBasicMaterial({ map: t })
    })
    this.cube = new THREE.Mesh(geom, mats)
    this.scene.add(this.cube)
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geom),
      new THREE.LineBasicMaterial({ color: "#5a5369", transparent: true, opacity: 0.55 }),
    )
    this.cube.add(edges)
    this.disposables.push(geom, ...mats, edges.geometry, edges.material as THREE.Material)

    const hlGeom = new THREE.BoxGeometry(1, 1, 1)
    const hlMat = new THREE.MeshBasicMaterial({ color: "#2f6bff", transparent: true, opacity: 0.5, depthTest: false })
    this.highlight = new THREE.Mesh(hlGeom, hlMat)
    this.highlight.visible = false
    this.highlight.renderOrder = 2
    this.scene.add(this.highlight)
    this.disposables.push(hlGeom, hlMat)

    canvas.addEventListener("pointermove", this.onMove)
    canvas.addEventListener("pointerleave", this.onLeave)
    canvas.addEventListener("pointerdown", this.onDown)
    canvas.addEventListener("pointerup", this.onUp)
    this.resize()
  }

  resize() {
    const w = Math.max(1, this.host.clientWidth)
    const h = Math.max(1, this.host.clientHeight)
    this.renderer.setSize(w, h, false)
    const s = 0.98
    const aspect = w / h
    this.camera.left = -s * aspect
    this.camera.right = s * aspect
    this.camera.top = s
    this.camera.bottom = -s
    this.camera.updateProjectionMatrix()
    this.render()
  }

  sync(q: THREE.Quaternion) {
    if (this.quaternion.equals(q)) return
    this.quaternion.copy(q)
    this.render()
  }

  private render() {
    this.camera.quaternion.copy(this.quaternion)
    this.camera.position.set(0, 0, 4).applyQuaternion(this.quaternion)
    this.camera.updateMatrixWorld()
    this.renderer.render(this.scene, this.camera)
  }

  /** Face, edge or corner under the pointer as a vector with components in {-1, 0, 1}. */
  private pick(e: PointerEvent): THREE.Vector3 | null {
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hit = this.raycaster.intersectObject(this.cube, false)[0]
    if (!hit) return null
    const p = hit.point
    const limit = SIZE / 2 - BAND * SIZE
    const axis = (v: number) => (Math.abs(v) > limit ? Math.sign(v) : 0)
    return new THREE.Vector3(axis(p.x), axis(p.y), axis(p.z))
  }

  private showHighlight(region: THREE.Vector3 | null) {
    if (!region) {
      this.highlight.visible = false
      return
    }
    const half = SIZE / 2
    const lift = 0.012
    const comp = (r: number) =>
      r === 0 ? { size: SIZE - 2 * BAND * SIZE, center: 0 } : { size: BAND * SIZE + lift, center: r * (half - (BAND * SIZE) / 2 + lift / 2) }
    const x = comp(region.x)
    const y = comp(region.y)
    const z = comp(region.z)
    this.highlight.scale.set(x.size, y.size, z.size)
    this.highlight.position.set(x.center, y.center, z.center)
    this.highlight.visible = true
  }

  private onMove = (e: PointerEvent) => {
    if (this.down && e.buttons & 1) {
      const dx = e.clientX - this.down.x
      const dy = e.clientY - this.down.y
      if (this.down.dragged || Math.hypot(dx, dy) > 3) {
        this.onDragOrbit(dx, dy)
        this.down = { x: e.clientX, y: e.clientY, dragged: true }
        this.hover = null
        this.showHighlight(null)
        this.render()
        return
      }
    }
    const r = this.pick(e)
    if ((r && this.hover && r.equals(this.hover)) || (!r && !this.hover)) return
    this.hover = r
    this.renderer.domElement.style.cursor = r ? "pointer" : "default"
    this.showHighlight(r)
    this.render()
  }

  private onLeave = () => {
    this.hover = null
    this.down = null
    this.showHighlight(null)
    this.render()
  }

  private onDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    this.down = { x: e.clientX, y: e.clientY, dragged: false }
    this.renderer.domElement.setPointerCapture(e.pointerId)
  }

  private onUp = (e: PointerEvent) => {
    const wasDrag = this.down?.dragged
    this.down = null
    if (wasDrag || e.button !== 0) return
    const r = this.pick(e)
    if (r && r.lengthSq() > 0) this.onPick(r.clone().normalize())
  }

  dispose() {
    const canvas = this.renderer.domElement
    canvas.removeEventListener("pointermove", this.onMove)
    canvas.removeEventListener("pointerleave", this.onLeave)
    canvas.removeEventListener("pointerdown", this.onDown)
    canvas.removeEventListener("pointerup", this.onUp)
    for (const d of this.disposables) d.dispose()
    for (const t of this.textures) t.dispose()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    canvas.remove()
  }
}
