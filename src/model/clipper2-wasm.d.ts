// The part of clipper2-wasm (Clipper2 compiled to WebAssembly, BSL-1.0) the fill worker uses (`wasmClipper.ts`). The package points its types at a
// file it does not ship, so these are written out here, from its own `dist/clipper2z.d.ts`.
declare module "clipper2-wasm/dist/es/clipper2z.js" {
  interface Value<T extends number> {
    value: T
  }
  export interface WasmPath64 {
    view(): BigInt64Array
    assign(coordinates: BigInt64Array): void
    delete(): void
  }
  export interface WasmPaths64 {
    push_back(path: WasmPath64): void
    size(): number
    get(index: number): WasmPath64
    delete(): void
  }
  export interface Clipper2Module {
    Path64: { new (): WasmPath64 }
    Paths64: { new (): WasmPaths64 }
    FillRule: { EvenOdd: Value<0>; NonZero: Value<1>; Positive: Value<2>; Negative: Value<3> }
    JoinType: { Square: Value<0>; Round: Value<2>; Miter: Value<3> }
    EndType: { Polygon: Value<0> }
    Union64(subjects: WasmPaths64, clips: WasmPaths64, fillRule: Value<number>): WasmPaths64
    Difference64(subjects: WasmPaths64, clips: WasmPaths64, fillRule: Value<number>): WasmPaths64
    Intersect64(subjects: WasmPaths64, clips: WasmPaths64, fillRule: Value<number>): WasmPaths64
    InflatePaths64(paths: WasmPaths64, delta: number, joinType: Value<number>, endType: Value<number>, miterLimit: number, arcTolerance: number): WasmPaths64
  }
  const factory: (options?: { locateFile?: (path: string) => string }) => Promise<Clipper2Module>
  export default factory
}
