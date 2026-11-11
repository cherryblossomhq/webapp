import CFB from "cfb"

// A reader of the Altium files the export writes, for the tests: the compound file is read by SheetJS's `cfb` (not the export's own writer), and the
// records as KiCad's Altium importer reads them (`common/io/altium/altium_binary_parser.h`, `pcbnew/pcb_io/altium/altium_parser_pcb.cpp`).

export type Props = Map<string, string>

/** Every stream of a compound file by its path below the root (`Board6/Data`, `FileHeader`). */
export function readStreams(bytes: Uint8Array): Map<string, Uint8Array> {
  const cfb = CFB.read(Buffer.from(bytes), { type: "buffer" })
  const out = new Map<string, Uint8Array>()
  cfb.FullPaths.forEach((path, i) => {
    const e = cfb.FileIndex[i]
    if (e.type !== 2) return
    out.set(path.replace(/^Root Entry\//, ""), Uint8Array.from((e.content ?? []) as ArrayLike<number>))
  })
  return out
}

const latin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join("")

/** One property list, keys in upper case, a `%UTF8%` value in place of its Windows-1252 one. */
export function parseProps(text: Uint8Array): Props {
  const s = latin1(text).replace(/\0$/, "")
  const props: Props = new Map()
  const utf8: [string, string][] = []
  for (const part of s.split("|")) {
    const eq = part.indexOf("=")
    if (eq < 0) continue
    const key = part.slice(0, eq).trim().toUpperCase()
    const value = part.slice(eq + 1)
    if (key.startsWith("%UTF8%")) utf8.push([key.slice(6), new TextDecoder().decode(Uint8Array.from(value, (c) => c.charCodeAt(0)))])
    else if (!props.has(key)) props.set(key, value)
  }
  for (const [k, v] of utf8) props.set(k, v)
  return props
}

/** The property records of a stream: a u32 length (the record type in its top byte), then the list. */
export function propRecords(data: Uint8Array): Props[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const out: Props[] = []
  let o = 0
  while (o + 4 <= data.length) {
    const len = view.getUint32(o, true) & 0xffffff
    out.push(parseProps(data.subarray(o + 4, o + 4 + len)))
    o += 4 + len
  }
  return out
}

/** A schematic's records, the header first. */
export function schRecords(bytes: Uint8Array): Props[] {
  return propRecords(readStreams(bytes).get("FileHeader")!)
}

/** A board's rules: a u16 kind, then a property record. */
export function ruleRecords(data: Uint8Array): { kind: number; props: Props }[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const out: { kind: number; props: Props }[] = []
  let o = 0
  while (o + 6 <= data.length) {
    const kind = view.getUint16(o, true)
    const len = view.getUint32(o + 2, true)
    out.push({ kind, props: parseProps(data.subarray(o + 6, o + 6 + len)) })
    o += 6 + len
  }
  return out
}

/** Binary records of a primitive storage: the type byte, then its subrecords, each a u32 length and its bytes. */
export function binaryRecords(data: Uint8Array): { type: number; subs: DataView[] }[] {
  const SUBS: Record<number, number> = { 1: 1, 2: 6, 3: 1, 4: 1, 5: 2, 6: 1, 11: 1, 12: 1 }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const out: { type: number; subs: DataView[] }[] = []
  let o = 0
  while (o < data.length) {
    const type = data[o++]
    const subs: DataView[] = []
    for (let i = 0; i < SUBS[type]; i++) {
      const len = view.getUint32(o, true) & 0xffffff
      subs.push(new DataView(data.buffer, data.byteOffset + o + 4, len))
      o += 4 + len
    }
    out.push({ type, subs })
  }
  return out
}

/** Altium's PCB unit (a ten-thousandth of a mil) in millimetres. */
export const mm = (units: number) => (units / 10000) * 0.0254

/** A `12.5mil` property in millimetres. */
export const milProp = (v: string | undefined) => (v === undefined ? NaN : Number(v.replace(/mil$/, "")) * 0.0254)

export interface ReadPad {
  name: string
  layer: number
  net: number
  component: number
  x: number
  y: number
  w: number
  h: number
  hole: number
  shape: number
  rot: number
  plated: boolean
  /** From the size and shape block, when the pad has one. */
  slot?: { length: number; angle: number }
  cornerPercent?: number
  holeOffset?: { x: number; y: number }
}

export function readPads(data: Uint8Array): ReadPad[] {
  return binaryRecords(data).map(({ subs }) => {
    const name = latin1(new Uint8Array(subs[0].buffer, subs[0].byteOffset + 1, subs[0].getUint8(0)))
    const r = subs[4]
    const pad: ReadPad = {
      name,
      layer: r.getUint8(0),
      net: r.getUint16(3, true),
      component: r.getUint16(7, true),
      x: mm(r.getInt32(13, true)),
      y: mm(r.getInt32(17, true)),
      w: mm(r.getInt32(21, true)),
      h: mm(r.getInt32(25, true)),
      hole: mm(r.getInt32(45, true)),
      shape: r.getUint8(49),
      rot: r.getFloat64(52, true),
      plated: r.getUint8(60) !== 0,
    }
    const s = subs[5]
    if (s.byteLength >= 596) {
      if (s.getUint8(262) === 2) pad.slot = { length: mm(s.getInt32(263, true)), angle: s.getFloat64(267, true) }
      pad.holeOffset = { x: mm(s.getInt32(275, true)), y: mm(s.getInt32(403, true)) }
      if (s.getUint8(532) === 9) pad.cornerPercent = s.getUint8(564)
    }
    return pad
  })
}

export function readTracks(data: Uint8Array) {
  return binaryRecords(data).map(({ subs: [r] }) => ({
    layer: r.getUint8(0),
    net: r.getUint16(3, true),
    component: r.getUint16(7, true),
    a: { x: mm(r.getInt32(13, true)), y: mm(r.getInt32(17, true)) },
    b: { x: mm(r.getInt32(21, true)), y: mm(r.getInt32(25, true)) },
    width: mm(r.getInt32(29, true)),
    length: r.byteLength,
  }))
}

export function readArcs(data: Uint8Array) {
  return binaryRecords(data).map(({ subs: [r] }) => ({
    layer: r.getUint8(0),
    net: r.getUint16(3, true),
    component: r.getUint16(7, true),
    c: { x: mm(r.getInt32(13, true)), y: mm(r.getInt32(17, true)) },
    r: mm(r.getInt32(21, true)),
    start: r.getFloat64(25, true),
    end: r.getFloat64(33, true),
    width: mm(r.getInt32(41, true)),
  }))
}

export function readVias(data: Uint8Array) {
  return binaryRecords(data).map(({ subs: [r] }) => ({
    net: r.getUint16(3, true),
    flags: r.getUint16(1, true),
    x: mm(r.getInt32(13, true)),
    y: mm(r.getInt32(17, true)),
    diameter: mm(r.getInt32(21, true)),
    hole: mm(r.getInt32(25, true)),
    from: r.getUint8(29),
    to: r.getUint8(30),
    length: r.byteLength,
  }))
}

export function readTexts(data: Uint8Array, wide: Uint8Array) {
  const view = new DataView(wide.buffer, wide.byteOffset, wide.byteLength)
  const table = new Map<number, string>()
  for (let o = 0; o + 8 <= wide.length; ) {
    const index = view.getUint32(o, true)
    const len = view.getUint32(o + 4, true)
    table.set(index, new TextDecoder("utf-16le").decode(wide.subarray(o + 8, o + 8 + Math.max(0, len - 2))))
    o += 8 + len
  }
  return binaryRecords(data).map(({ subs: [r, s] }) => ({
    layer: r.getUint8(0),
    component: r.getUint16(7, true),
    x: mm(r.getInt32(13, true)),
    y: mm(r.getInt32(17, true)),
    height: mm(r.getInt32(21, true)),
    rot: r.getFloat64(27, true),
    comment: r.getUint8(40) === 1,
    designator: r.getUint8(41) === 1,
    text: table.get(r.getUint32(115, true)) ?? latin1(new Uint8Array(s.buffer, s.byteOffset + 1, s.getUint8(0))),
    length: r.byteLength,
  }))
}

/** The regions of `Regions6`, or with `shapeBased` of `ShapeBasedRegions6`, whose outline is Altium's vertices (37 bytes each) closed by its first again. */
export function readRegions(data: Uint8Array, shapeBased = false) {
  return binaryRecords(data).map(({ subs: [r] }) => {
    const holes = r.getUint16(14, true)
    const len = r.getUint32(18, true)
    const props = parseProps(new Uint8Array(r.buffer, r.byteOffset + 22, len))
    let o = 22 + len
    const shaped = () => {
      const n = r.getUint32(o, true)
      o += 4
      const pts: { x: number; y: number }[] = []
      for (let i = 0; i <= n; i++) {
        if (i < n) pts.push({ x: mm(r.getInt32(o + 1, true)), y: mm(r.getInt32(o + 5, true)) })
        o += 37
      }
      return pts
    }
    const ring = () => {
      const n = r.getUint32(o, true)
      o += 4
      const pts: { x: number; y: number }[] = []
      for (let i = 0; i < n; i++) {
        pts.push({ x: mm(r.getFloat64(o, true)), y: mm(r.getFloat64(o + 8, true)) })
        o += 16
      }
      return pts
    }
    const outline = shapeBased ? shaped() : ring()
    const cut: { x: number; y: number }[][] = []
    for (let i = 0; i < holes; i++) cut.push(ring())
    return { layer: r.getUint8(0), net: r.getUint16(3, true), polygon: r.getUint16(5, true), component: r.getUint16(7, true), props, outline, holes: cut, end: o, length: r.byteLength }
  })
}

/** A schematic coordinate (whole and hundred-thousandths) in Altium's unit. */
export const schCoord = (p: Props, key: string) => Number(p.get(key) ?? 0) + Number(p.get(`${key}_FRAC`) ?? 0) / 100000
