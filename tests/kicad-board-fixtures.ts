// Boards for the KiCad importer's tests, written by hand: a few lines each, in the spelling of the
// release being tested, so that each switch of the reader has a board that needs it.

export interface PadSpec {
  number?: string
  type?: string
  shape?: string
  /** `x y` or `x y angle` as the file writes `(at ...)`. */
  at: string
  size?: string
  layers?: string
  net?: string
  extra?: string
}

export const pad = (p: PadSpec) =>
  `(pad ${p.number === undefined ? "1" : /^[\w.]+$/.test(p.number) ? p.number : `"${p.number}"`} ${p.type ?? "smd"} ${p.shape ?? "rect"} (at ${p.at}) (size ${p.size ?? "1 1"}) (layers ${p.layers ?? '"F.Cu" "F.Paste" "F.Mask"'})${p.net ? ` ${p.net}` : ""}${p.extra ? ` ${p.extra}` : ""})`

export interface FootprintSpec {
  name?: string
  ref?: string
  value?: string
  at?: string
  layer?: string
  pads: string[]
  extra?: string
  /** `module` for KiCad 5. */
  token?: string
}

/** A footprint in KiCad 6 and later's spelling (`property`), or KiCad 5's (`fp_text`) for `module`. */
export function footprint(f: FootprintSpec): string {
  const token = f.token ?? "footprint"
  const ref = f.ref ?? "R1"
  const texts =
    token === "module"
      ? `(fp_text reference ${ref} (at 0 -1.5) (layer F.SilkS) (effects (font (size 1 1) (thickness 0.15)))) (fp_text value ${f.value ?? "10k"} (at 0 1.5) (layer F.Fab) (effects (font (size 1 1) (thickness 0.15))))`
      : `(property "Reference" "${ref}" (at 0 -1.5 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15)))) (property "Value" "${f.value ?? "10k"}" (at 0 1.5 0) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))`
  return `(${token} "${f.name ?? "Resistor_SMD:R_0603_1608Metric"}" (layer "${f.layer ?? "F.Cu"}") (at ${f.at ?? "0 0"}) ${texts} ${f.pads.join(" ")} ${f.extra ?? ""})`
}

export interface BoardSpec {
  version?: number
  /** The text between the header and the footprints: layers, setup, nets. Defaults to a two-layer table. */
  layers?: string
  setup?: string
  nets?: string[]
  body?: string[]
  /** A plain 20 by 10 outline on Edge.Cuts, unless false. */
  outline?: boolean | string
  header?: string
}

export const OUTLINE_MODERN = `(gr_rect (start 0 0) (end 20 10) (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts"))`
export const OUTLINE_LEGACY = `(gr_line (start 0 0) (end 20 0) (layer Edge.Cuts) (width 0.1)) (gr_line (start 20 0) (end 20 10) (layer Edge.Cuts) (width 0.1)) (gr_line (start 20 10) (end 0 10) (layer Edge.Cuts) (width 0.1)) (gr_line (start 0 10) (end 0 0) (layer Edge.Cuts) (width 0.1))`

export function board(spec: BoardSpec = {}): string {
  const version = spec.version ?? 20240108
  const modern = version >= 20211014
  const layers = spec.layers ?? (modern ? `(layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))` : `(layers (0 F.Cu signal) (31 B.Cu signal) (44 Edge.Cuts user))`)
  const outline = spec.outline === false ? "" : typeof spec.outline === "string" ? spec.outline : modern ? OUTLINE_MODERN : OUTLINE_LEGACY
  const nets = (spec.nets ?? ['(net 0 "")']).join("\n")
  const header = spec.header ?? (modern ? `(generator "pcbnew") (generator_version "8.0")` : `(host pcbnew 5.1.12)`)
  return `(kicad_pcb (version ${version}) ${header}
  (general (thickness 1.6))
  (paper "A4")
  ${layers}
  ${spec.setup ?? "(setup (pad_to_mask_clearance 0))"}
  ${nets}
  ${(spec.body ?? []).join("\n  ")}
  ${outline}
)`
}
