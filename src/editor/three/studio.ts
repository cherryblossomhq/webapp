import * as THREE from "three"

export interface StudioBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
  /** Height of the floor plane. */
  z: number
}

const gridVertex = /* glsl */ `
  varying vec2 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xy;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`

// Anti-aliased minor/major lines, faded out with distance from the board.
const gridFragment = /* glsl */ `
  uniform vec2 uOrigin;
  uniform float uMinor;
  uniform float uMajor;
  uniform vec3 uMinorColor;
  uniform vec3 uMajorColor;
  uniform vec2 uCenter;
  uniform float uFadeStart;
  uniform float uFadeEnd;
  varying vec2 vWorld;

  float lineMask(vec2 p, float step, float width) {
    vec2 c = (p - uOrigin) / step;
    vec2 d = fwidth(c);
    vec2 g = abs(fract(c - 0.5) - 0.5) / max(d, vec2(1e-5));
    float l = min(g.x, g.y);
    return 1.0 - min(l / width, 1.0);
  }

  void main() {
    float minor = lineMask(vWorld, uMinor, 1.0);
    float major = lineMask(vWorld, uMajor, 1.4);
    float r = length(vWorld - uCenter);
    float fade = 1.0 - smoothstep(uFadeStart, uFadeEnd, r);
    // Thin lines shimmer at grazing angles; let the minor grid drop out as cells get small on screen.
    vec2 cell = fwidth(vWorld) / uMinor;
    float minorVis = 1.0 - smoothstep(0.18, 0.45, max(cell.x, cell.y));
    float a = max(minor * 0.22 * minorVis, major * 0.5) * fade;
    vec3 col = mix(uMinorColor, uMajorColor, step(minor * 0.22 * minorVis, major * 0.5));
    if (a < 0.003) discard;
    gl_FragColor = vec4(col, a);
  }
`

function labelTexture(text: string, color: string): { texture: THREE.CanvasTexture; aspect: number } {
  const h = 64
  const canvas = document.createElement("canvas")
  const ctx = canvas.getContext("2d")!
  const font = `500 ${h * 0.72}px "Geist Variable", ui-sans-serif, system-ui, sans-serif`
  ctx.font = font
  const w = Math.ceil(ctx.measureText(text).width + h * 0.2)
  canvas.width = w
  canvas.height = h
  ctx.font = font
  ctx.fillStyle = color
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.fillText(text, w / 2, h / 2 + 2)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return { texture, aspect: w / h }
}

const fmt = (n: number) => (Math.abs(n) < 1e-9 ? "0" : String(Math.round(n * 100) / 100))

/** Floor grid with dimension labels plus a shadow catcher, measured from the board's lower-left corner. */
export class StudioFloor {
  readonly group = new THREE.Group()
  private disposables: { dispose(): void }[] = []

  constructor(bounds: StudioBounds) {
    this.group.name = "studio"
    const w = bounds.maxX - bounds.minX
    const h = bounds.maxY - bounds.minY
    const size = Math.max(w, h, 10)
    const major = size > 220 ? 50 : size > 120 ? 20 : 10
    const minor = major / (major === 20 ? 4 : 5) / (size < 40 ? 2 : 1)
    const cx = (bounds.minX + bounds.maxX) / 2
    const cy = (bounds.minY + bounds.maxY) / 2
    const extent = size * 2.2 + 60

    const gridGeom = new THREE.PlaneGeometry(extent * 2, extent * 2)
    const gridMat = new THREE.ShaderMaterial({
      vertexShader: gridVertex,
      fragmentShader: gridFragment,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uOrigin: { value: new THREE.Vector2(bounds.minX, bounds.minY) },
        uMinor: { value: minor },
        uMajor: { value: major },
        uMinorColor: { value: new THREE.Color("#8d88a0") },
        uMajorColor: { value: new THREE.Color("#b7b2c9") },
        uCenter: { value: new THREE.Vector2(cx, cy) },
        uFadeStart: { value: size * 0.7 },
        uFadeEnd: { value: size * 1.9 + 20 },
      },
    })
    const grid = new THREE.Mesh(gridGeom, gridMat)
    grid.position.set(cx, cy, bounds.z)
    grid.renderOrder = -1
    grid.name = "grid"
    this.group.add(grid)
    this.disposables.push(gridGeom, gridMat)

    // Shadow catcher slightly above the grid so the board shadow darkens the lines too.
    const shadowGeom = new THREE.PlaneGeometry(extent * 2, extent * 2)
    const shadowMat = new THREE.ShadowMaterial({ color: "#000000", opacity: 0.42, depthWrite: false })
    const catcher = new THREE.Mesh(shadowGeom, shadowMat)
    catcher.position.set(cx, cy, bounds.z + 0.002)
    catcher.receiveShadow = true
    catcher.name = "shadow-catcher"
    this.group.add(catcher)
    this.disposables.push(shadowGeom, shadowMat)

    // Labels along the front edge (x) and the left edge (y), lying on the floor.
    const labelH = Math.min(4, Math.max(1.4, size * 0.036))
    const gap = labelH * 1.3
    const color = "rgba(198,193,214,0.78)"
    // Label every major line only while "NN mm" fits comfortably between them.
    const step = labelH * 3.4 < major * 0.7 ? major : major * 2
    const xs: number[] = []
    const ys: number[] = []
    const span = Math.ceil((size * 0.9) / step) * step
    for (let x = 0; x <= Math.max(w, span) + step * 0.01; x += step) xs.push(x)
    for (let y = 0; y <= Math.max(h, span) + step * 0.01; y += step) ys.push(y)
    const addLabel = (text: string, x: number, y: number, rotate: boolean) => {
      const { texture, aspect } = labelTexture(text, color)
      const geom = new THREE.PlaneGeometry(labelH * aspect, labelH)
      const mat = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false })
      const mesh = new THREE.Mesh(geom, mat)
      mesh.position.set(x, y, bounds.z + 0.004)
      if (rotate) mesh.rotation.z = Math.PI / 2
      mesh.renderOrder = 1
      this.group.add(mesh)
      this.disposables.push(texture, geom, mat)
    }
    for (const x of xs) addLabel(`${fmt(x)} mm`, bounds.minX + x, bounds.minY - gap - major * 0.35, false)
    for (const y of ys) {
      if (Math.abs(y) < 1e-9) continue
      addLabel(`${fmt(y)} mm`, bounds.minX - gap - major * 0.35, bounds.minY + y, true)
    }
  }

  dispose() {
    for (const d of this.disposables) d.dispose()
    this.disposables = []
    this.group.clear()
  }
}
