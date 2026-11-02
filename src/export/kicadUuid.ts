/** A uuid in KiCad's shape, numbered so the same project writes the same file. `kind` is the fourth group, which keeps one writer's uuids from meeting another's. */
export const stableUuid = (kind: string, n: number) => `00000000-0000-4000-${kind}-${n.toString(16).padStart(12, "0")}`

/** A uuid made from a text, the same every time: a project's ids are short, KiCad's are uuids. */
export function uuidFrom(text: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193
  let c = 0x9747b28c
  let d = 0x85ebca6b
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i)
    a = Math.imul(a ^ k, 0x01000193) >>> 0
    b = Math.imul(b ^ (k + i), 0x85ebca6b) >>> 0
    c = Math.imul(c ^ (k << 1), 0xc2b2ae35) >>> 0
    d = Math.imul(d + k, 0x27d4eb2f) >>> 0
  }
  const hex = (n: number) => n.toString(16).padStart(8, "0")
  const h = hex(a) + hex(b) + hex(c) + hex(d)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}
