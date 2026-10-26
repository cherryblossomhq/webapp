import * as THREE from "three"

// Authored z-up to match the board. Directions point from the board towards each light.
const DOME_VERTEX = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const DOME_FRAGMENT = /* glsl */ `
  varying vec3 vDir;
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uGround;
  void main() {
    float z = vDir.z;
    vec3 sky = mix(uHorizon, uZenith, smoothstep(0.0, 0.85, z));
    vec3 col = z >= 0.0 ? sky : mix(uHorizon * 0.35, uGround, smoothstep(0.0, 0.4, -z));
    gl_FragColor = vec4(col, 1.0);
  }
`

interface Softbox {
  dir: [number, number, number]
  size: [number, number]
  intensity: number
  color?: string
}

// A large overhead box (broad, soft fill on metals), a key box front-left, and a long strip
// behind the board that gives the mask a clean sheen from the usual three-quarter views.
const SOFTBOXES: Softbox[] = [
  { dir: [-0.15, 0.1, 1], size: [70, 56], intensity: 1.1 },
  { dir: [-0.55, -0.7, 0.75], size: [26, 18], intensity: 3.2, color: "#fff4e6" },
  { dir: [0.25, 1, 0.42], size: [64, 7], intensity: 2.6, color: "#eef2ff" },
  { dir: [1, -0.25, 0.3], size: [8, 30], intensity: 1.2 },
  // Broad, dim fill behind and above: what metal pads mirror from the default view.
  { dir: [0.15, 0.9, 0.85], size: [80, 50], intensity: 1.15 },
  // Under-light so the bottom side reads when the board is flipped.
  { dir: [0.2, 0.35, -1], size: [60, 44], intensity: 0.9 },
]

/** Diffuser falloff: bright centre feathering to nothing, so reflections have no hard edges. */
function featherTexture(): THREE.CanvasTexture {
  const n = 128
  const canvas = document.createElement("canvas")
  canvas.width = n
  canvas.height = n
  const ctx = canvas.getContext("2d")!
  const img = ctx.createImageData(n, n)
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = Math.abs((x + 0.5) / n - 0.5) * 2
      const v = Math.abs((y + 0.5) / n - 0.5) * 2
      const edge = Math.max(u, v)
      const t = 1 - Math.min(1, Math.max(0, (edge - 0.35) / 0.65))
      const a = Math.round(255 * t * t * (3 - 2 * t))
      const i = (y * n + x) * 4
      img.data[i] = img.data[i + 1] = img.data[i + 2] = a
      img.data[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  const t = new THREE.CanvasTexture(canvas)
  t.colorSpace = THREE.NoColorSpace
  return t
}

/** Prefiltered studio environment for PBR reflections. */
export function createStudioEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const scene = new THREE.Scene()
  const disposables: { dispose(): void }[] = []
  const feather = featherTexture()
  disposables.push(feather)

  const domeGeom = new THREE.SphereGeometry(100, 48, 24)
  const domeMat = new THREE.ShaderMaterial({
    vertexShader: DOME_VERTEX,
    fragmentShader: DOME_FRAGMENT,
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uZenith: { value: new THREE.Color("#67636f") },
      uHorizon: { value: new THREE.Color("#2b2931") },
      uGround: { value: new THREE.Color("#1c1a21") },
    },
  })
  scene.add(new THREE.Mesh(domeGeom, domeMat))
  disposables.push(domeGeom, domeMat)

  for (const box of SOFTBOXES) {
    const dir = new THREE.Vector3(...box.dir).normalize()
    const geom = new THREE.PlaneGeometry(box.size[0], box.size[1])
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(box.color ?? "#ffffff").multiplyScalar(box.intensity),
      map: feather,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    const mesh = new THREE.Mesh(geom, mat)
    mesh.position.copy(dir).multiplyScalar(60)
    mesh.up.set(0, 0, 1)
    mesh.lookAt(0, 0, 0)
    scene.add(mesh)
    disposables.push(geom, mat)
  }

  const pmrem = new THREE.PMREMGenerator(renderer)
  const texture = pmrem.fromScene(scene, 0.02, 0.1, 200).texture
  pmrem.dispose()
  for (const d of disposables) d.dispose()
  return texture
}
