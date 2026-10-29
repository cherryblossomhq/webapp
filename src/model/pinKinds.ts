import { pinRole } from "./supplier/roles"
import type { PinDef, PinType } from "./types"

/**
 * KiCad's electrical pin type as the editor's coarser role, which Tidy, Checks and the box symbols
 * read. The same mapping the KiCad library and board imports use (`pinKindOf` in
 * `kicad/board/build.ts`); a pin whose type says nothing (free, unspecified) has no role.
 */
export function pinKindOfType(type: string, name: string): PinDef["kind"] | "unknown" {
  const types = type.split("+")
  if (types.includes("no_connect")) return "nc"
  switch (types[0]) {
    case "input":
      return "input"
    case "output":
    case "tri_state":
    case "open_collector":
    case "open_emitter":
      return "output"
    case "bidirectional":
      return "io"
    case "passive":
      return "passive"
    case "power_in":
    case "power_out":
      return pinRole(name) === "ground" ? "ground" : "power"
    case "free":
    case "unspecified":
      return undefined
    default:
      return "unknown"
  }
}

export const PIN_TYPES: readonly PinType[] = ["input", "output", "bidirectional", "tri_state", "passive", "free", "unspecified", "power_in", "power_out", "open_collector", "open_emitter", "no_connect"]

/**
 * The KiCad electrical type an editor role is written as, the inverse of `pinKindOfType` where the role says everything: an input is an input, an output an output, a
 * pin that drives and takes is bidirectional, power and ground are power inputs (the import tells the two by the pin's name), no connect is no connect. A role the
 * pin has none of is no type, which the file's own default (passive) stands for.
 */
export function pinTypeOfKind(kind: PinDef["kind"]): PinType | undefined {
  switch (kind) {
    case "input":
      return "input"
    case "output":
      return "output"
    case "io":
      return "bidirectional"
    case "passive":
      return "passive"
    case "power":
    case "ground":
      return "power_in"
    case "nc":
      return "no_connect"
    default:
      return undefined
  }
}
