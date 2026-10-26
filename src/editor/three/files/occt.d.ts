// occt-import-js (OpenCascade's STEP reader in WebAssembly) ships no types; this is the part of
// its interface the editor uses, as its README and its output describe it.
declare module "occt-import-js" {
  export interface OcctMesh {
    name?: string
    /** Linear RGB, 0..1; absent when the shape has no colour of its own. */
    color?: number[]
    /** Triangle ranges (inclusive, in triangles) of each B-rep face, with its own colour when it has one. */
    brep_faces?: { first: number; last: number; color: number[] | null }[]
    attributes: { position: { array: ArrayLike<number> }; normal?: { array: ArrayLike<number> } }
    index: { array: ArrayLike<number> }
  }
  export interface OcctNode {
    name: string
    meshes: number[]
    children: OcctNode[]
  }
  export interface OcctResult {
    success: boolean
    root: OcctNode
    meshes: OcctMesh[]
  }
  export interface OcctParams {
    linearUnit?: "millimeter" | "centimeter" | "meter" | "inch" | "foot"
    linearDeflectionType?: "bounding_box_ratio" | "absolute_value"
    linearDeflection?: number
    angularDeflection?: number
  }
  export interface Occt {
    ReadStepFile(content: Uint8Array, params: OcctParams | null): OcctResult
  }
  export default function occtimportjs(module?: { locateFile?: (path: string) => string; wasmBinary?: ArrayBuffer }): Promise<Occt>
}
