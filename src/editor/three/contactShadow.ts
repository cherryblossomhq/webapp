import * as THREE from "three"

// The soft dark patch on the board where a model meets it, standing in for ambient occlusion.
// It is part of the model's holder, sized from the model's own box, so it appears only where a
// model is drawn: a part with no model shows its pads and no shadow of a body it doesn't have.

/** Above the mask (the board face is at 0) and below the pads' copper (0.0015 to 0.0365). */
const Z = 0.008
const OPACITY = 0.3

const vertex = /* glsl */ `
  attribute vec4 shape;
  varying vec2 vPos;
  varying vec4 vShape;
  void main() {
    vPos = position.xy;
    vShape = shape;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

// A rounded rectangle (half sizes, corner radius) faded out over its blur on either side of its edge.
const fragment = /* glsl */ `
  uniform float uOpacity;
  varying vec2 vPos;
  varying vec4 vShape;
  void main() {
    vec2 q = abs(vPos) - vShape.xy + vShape.z;
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - vShape.z;
    float a = uOpacity * (1.0 - smoothstep(-vShape.w, vShape.w, d));
    if (a < 0.003) discard;
    gl_FragColor = vec4(0.0, 0.0, 0.0, a);
  }
`

/** One material for every part's contact shadow: the shape is in each one's geometry. */
export function createContactShadowMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: fragment,
    uniforms: { uOpacity: { value: OPACITY } },
    transparent: true,
    depthWrite: false,
  })
}

/**
 * The contact shadow of a model placed in its footprint's frame (mm, z up from the board), or
 * null when it has no size. Its geometry is its own, so disposing the part's geometries frees it.
 */
export function contactShadow(model: THREE.Object3D, material: THREE.Material): THREE.Mesh | null {
  const box = new THREE.Box3().setFromObject(model)
  if (box.isEmpty()) return null
  const size = box.getSize(new THREE.Vector3())
  if (size.x <= 0 || size.y <= 0) return null
  const blur = THREE.MathUtils.clamp(Math.min(size.x, size.y) * 0.25, 0.2, 0.8)
  const hx = Math.max(size.x / 2 - Math.min(0.2, size.x * 0.05), 0.05)
  const hy = Math.max(size.y / 2 - Math.min(0.2, size.y * 0.05), 0.05)
  const radius = Math.min(hx, hy) * 0.4
  const geometry = new THREE.PlaneGeometry(2 * (hx + blur), 2 * (hy + blur))
  const shape = new Float32Array(4 * geometry.attributes.position.count)
  for (let i = 0; i < shape.length; i += 4) shape.set([hx, hy, radius, blur], i)
  geometry.setAttribute("shape", new THREE.BufferAttribute(shape, 4))
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = "contact-shadow"
  mesh.position.set((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, Z)
  mesh.userData.contactShadow = true
  return mesh
}

/** A part's box without its contact shadow: what the selection outlines. */
export function partBox(holder: THREE.Object3D): THREE.Box3 {
  holder.updateWorldMatrix(true, true)
  const box = new THREE.Box3()
  holder.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && !o.userData.contactShadow) box.expandByObject(o)
  })
  return box
}
