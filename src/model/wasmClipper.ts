/// <reference path="./clipper2-wasm.d.ts" />
import { FillRule, JoinType, type Paths64 } from "@countertype/clipper2-ts"
import factory, { type Clipper2Module, type WasmPaths64 } from "clipper2-wasm/dist/es/clipper2z.js"
import type { FastClipper } from "./zoneGeom"

// Clipper2 compiled to WebAssembly (clipper2-wasm, BSL-1.0), as the zone fill's engine for big paths (`setFastClipper`). On CERN's Macbeth the
// fill's largest offsets (330,000 points, 4,600 holes) took 35 s in the TypeScript port and 15 s here. A path crosses into the module as a
// BigInt64Array of x, y and z (the build keeps a z, which is 0 here) and comes back the same way; every object made in the module is deleted.

/** The WebAssembly engine, read from `wasmUrl` (where the bundler put `clipper2z.wasm`) or, with none, from beside the script (Node). */
export async function loadWasmClipper(wasmUrl?: string): Promise<FastClipper> {
  const m: Clipper2Module = await factory(wasmUrl ? { locateFile: () => wasmUrl } : {})
  const rules = { [FillRule.EvenOdd]: m.FillRule.EvenOdd, [FillRule.NonZero]: m.FillRule.NonZero, [FillRule.Positive]: m.FillRule.Positive, [FillRule.Negative]: m.FillRule.Negative }
  // The port's bevel join has no counterpart in this build: those offsets stay with the port.
  const joins = new Map<JoinType, { value: number }>([
    [JoinType.Square, m.JoinType.Square],
    [JoinType.Round, m.JoinType.Round],
    [JoinType.Miter, m.JoinType.Miter],
  ])
  const into = (paths: Paths64): WasmPaths64 => {
    const out = new m.Paths64()
    for (const path of paths) {
      const xyz = new BigInt64Array(path.length * 3)
      for (let i = 0; i < path.length; i++) {
        xyz[i * 3] = BigInt(path[i].x)
        xyz[i * 3 + 1] = BigInt(path[i].y)
      }
      const p = new m.Path64()
      p.assign(xyz)
      out.push_back(p)
      p.delete()
    }
    return out
  }
  const back = (paths: WasmPaths64): Paths64 => {
    const out: Paths64 = []
    for (let i = 0; i < paths.size(); i++) {
      const p = paths.get(i)
      const xyz = p.view()
      const path = new Array<{ x: number; y: number }>(xyz.length / 3)
      for (let k = 0; k < path.length; k++) path[k] = { x: Number(xyz[k * 3]), y: Number(xyz[k * 3 + 1]) }
      out.push(path)
      p.delete()
    }
    paths.delete()
    return out
  }
  const ops = { union: m.Union64, difference: m.Difference64, intersect: m.Intersect64 }
  return {
    inflate(paths, delta, join, arcTolerance) {
      const j = joins.get(join)
      if (!j) return null
      const w = into(paths)
      try {
        return back(m.InflatePaths64(w, delta, j, m.EndType.Polygon, 2, arcTolerance))
      } finally {
        w.delete()
      }
    },
    boolean(op, a, b, rule) {
      const wa = into(a)
      const wb = into(b)
      try {
        return back(ops[op].call(m, wa, wb, rules[rule]))
      } finally {
        wa.delete()
        wb.delete()
      }
    },
  }
}
