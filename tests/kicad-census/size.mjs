// A rough size of a board's project file once imported, in bytes, from the census record.
//
// A fixed byte count per object, from the shapes `serializeProject` writes (a track segment as its
// own two-point trace is about 125 bytes, a via 80, a pad 95, a pad's net label and wire on the
// generated schematic 170, a component with its project part 400, a footprint graphic 42, a board
// graphic 90, a text with its place 90, a zone vertex 22), with nothing merged. Phase 1 replaces
// it with a measurement against `serializeProject`.

const count = (b, re) =>
  Object.entries(b.nodes)
    .filter(([k]) => re.test(k.replace(/^module/, "footprint")))
    .reduce((sum, [, v]) => sum + v, 0)

export function estimateBytes(b) {
  const footprintGraphics = count(b, /^footprint>fp_(line|arc|circle|poly|rect|curve)$/)
  const boardGraphics = count(b, /^gr_(line|arc|circle|poly|rect|curve)$/)
  const texts = count(b, /^(footprint>(fp_text|property)|gr_text)$/)
  const netted = b.pads.flags["has-net"] ?? 0
  return b.tracks.segments * 125 + b.tracks.arcs * 200 + b.tracks.vias * 80 + b.pads.total * 95 + netted * 170 + b.fps.total * 400 + footprintGraphics * 42 + boardGraphics * 90 + texts * 90 + b.zones.vertices * 22
}
