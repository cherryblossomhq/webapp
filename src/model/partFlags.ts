import type { ComponentInstance, PartFlags, Project } from "./types"

// What a footprint's KiCad attributes do in the editor (`ComponentInstance.flags`). A part with no
// flags, which is every part drawn here, is in the BOM and the position file and has no net ties.

/**
 * Whether the part is in the BOM: not virtual, not excluded, not do-not-populate. Board only (no
 * schematic symbol) does not take a part out: KiCad's board-side BOM lists such a part unless it is also excluded.
 * Do not populate is the editor's assembly default, where KiCad keeps the part by default.
 */
export function inBom(c: Pick<ComponentInstance, "flags">): boolean {
  const f = c.flags
  return !f || !(f.virtual || f.excludeFromBom || f.dnp)
}

/** Whether the part is in the position (pick and place) file: not virtual, not excluded, not do-not-populate. */
export function inPositionFile(c: Pick<ComponentInstance, "flags">): boolean {
  const f = c.flags
  return !f || !(f.virtual || f.excludeFromPos || f.dnp)
}

/** The flags a part has, in words for a person or for Sakura: "do not populate, not in the BOM". Empty for none. */
export function flagWords(flags: PartFlags | undefined): string[] {
  if (!flags) return []
  const out: string[] = []
  if (flags.mount) out.push(flags.mount === "smd" ? "surface mount" : "through-hole")
  if (flags.virtual) out.push("virtual")
  if (flags.dnp) out.push("do not populate")
  if (flags.excludeFromBom) out.push("not in the BOM")
  if (flags.excludeFromPos) out.push("not in the position file")
  if (flags.boardOnly) out.push("board only")
  if (flags.allowMissingCourtyard) out.push("missing courtyard allowed")
  if (flags.allowMaskBridges) out.push("mask bridges allowed")
  if (flags.jumperDuplicates) out.push("pads that share a number are jumpers")
  return out
}

/** A flag object with only what is set, or undefined when nothing is: how a part with no flags is stored. */
export function cleanFlags(flags: unknown): PartFlags | undefined {
  if (!flags || typeof flags !== "object" || Array.isArray(flags)) return undefined
  const f = flags as Record<string, unknown>
  const out: PartFlags = {}
  if (f.mount === "smd" || f.mount === "through_hole") out.mount = f.mount
  for (const key of ["virtual", "excludeFromBom", "excludeFromPos", "boardOnly", "dnp", "allowMissingCourtyard", "allowMaskBridges", "jumperDuplicates"] as const) {
    if (f[key] === true) out[key] = true
  }
  const groups = (g: unknown) =>
    (Array.isArray(g) ? g : [])
      .filter(Array.isArray)
      .map((x: unknown[]) => x.filter((p): p is string => typeof p === "string" && p !== ""))
      .filter((x) => x.length > 0)
  const ties = groups(f.netTies)
  if (ties.length) out.netTies = ties
  const jumpers = groups(f.jumperGroups)
  if (jumpers.length) out.jumperGroups = jumpers
  return Object.keys(out).length ? out : undefined
}

/**
 * The attribute words KiCad's board file writes for a part (`(attr smd exclude_from_bom)`). KiCad 6
 * and later read the old `virtual` as "not in the BOM and not in the position files", so a virtual
 * part is written as those two.
 */
export function kicadAttributes(flags: PartFlags | undefined): string[] {
  if (!flags) return []
  const out: string[] = []
  if (flags.mount === "smd") out.push("smd")
  if (flags.mount === "through_hole") out.push("through_hole")
  if (flags.boardOnly) out.push("board_only")
  if (flags.excludeFromPos || flags.virtual) out.push("exclude_from_pos_files")
  if (flags.excludeFromBom || flags.virtual) out.push("exclude_from_bom")
  if (flags.allowMaskBridges) out.push("allow_soldermask_bridges")
  if (flags.allowMissingCourtyard) out.push("allow_missing_courtyard")
  if (flags.dnp) out.push("dnp")
  return out
}

/**
 * The net tie groups of a part as sets of pad numbers. Two pads in one group may be on different nets,
 * and copper of those nets may touch the group's pads, without that being a short.
 */
export function netTieGroups(c: Pick<ComponentInstance, "flags">): Set<string>[] {
  return (c.flags?.netTies ?? []).map((g) => new Set(g))
}

/** The part with its flags changed: the keys of `patch` are set (`false` or undefined clears one), the rest stay. */
export function setFlags(project: Project, id: string, patch: { [K in keyof PartFlags]?: PartFlags[K] | false }): Project {
  return {
    ...project,
    updatedAt: Date.now(),
    components: project.components.map((c) => {
      if (c.id !== id) return c
      const flags = cleanFlags({ ...c.flags, ...patch })
      const { flags: _old, ...rest } = c
      return flags ? { ...rest, flags } : rest
    }),
  }
}

/**
 * The flags KiCad keeps on a symbol, and the footprint's own. A project import has both for a part, and each
 * says what only it knows: the symbol wins for do not populate, the BOM, the position file, simulation and being on the
 * board (KiCad copies them from the symbol to the footprint when the board is updated from the schematic, so a
 * footprint that says otherwise is a board not updated); the footprint wins for mounting, board only, virtual, the
 * courtyard and mask allowances, the jumper groups and the net ties, which a symbol has no word for.
 */
const SYMBOL_KEYS = ["dnp", "excludeFromBom", "excludeFromPos", "excludeFromSim", "notOnBoard"] as const
const FOOTPRINT_KEYS = ["mount", "virtual", "boardOnly", "allowMissingCourtyard", "allowMaskBridges", "jumperDuplicates", "jumperGroups", "netTies"] as const

/** The words of the three flags a footprint also has, for saying where the two disagree. */
const SHARED_WORDS: { [K in "dnp" | "excludeFromBom" | "excludeFromPos"]: string } = { dnp: "do not populate", excludeFromBom: "not in the BOM", excludeFromPos: "not in the position file" }

export function joinFlags(symbol: PartFlags | undefined, footprint: PartFlags | undefined): { flags: PartFlags | undefined; differ: string[] } {
  const out: PartFlags = {}
  for (const key of SYMBOL_KEYS) if (symbol?.[key]) out[key] = true
  for (const key of FOOTPRINT_KEYS) if (footprint?.[key] !== undefined) (out as Record<string, unknown>)[key] = footprint[key]
  const differ = (Object.keys(SHARED_WORDS) as (keyof typeof SHARED_WORDS)[]).filter((k) => !!symbol?.[k] !== !!footprint?.[k]).map((k) => `${SHARED_WORDS[k]} (the symbol says ${symbol?.[k] ? "yes" : "no"}, the footprint ${footprint?.[k] ? "yes" : "no"})`)
  return { flags: cleanFlags(out), differ }
}
