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
 * The flags KiCad keeps on a symbol, and the footprint's own. A project import has both for a part, and each says
 * what only it knows. Three flags are on both: do not populate, not in the BOM and not in the position file. KiCad's
 * "Update PCB from Schematic" copies a symbol's flag to its footprint only from some release on (6 and 7: the BOM; 8
 * and 9: also do not populate; 10: also the position file; simulation, a flag only symbols have in our model, only on
 * the development branch after 10), and a KiCad 9 symbol has no word for the position file at all. So the symbol
 * wins for one of these only when its file's release copies it and the symbol has the word (`flagVoice`, in
 * `kicad/schematic/read.ts`); otherwise the footprint's flag stands, and a symbol that states "yes" still adds it
 * (a KiCad 7 symbol's do not populate is the only word the part has). Simulation and being on the board are the
 * symbol's alone. The footprint wins for mounting, board only, virtual, the courtyard and mask allowances, the jumper
 * groups and the net ties, which a symbol has no word for.
 */
const SYMBOL_ONLY_KEYS = ["excludeFromSim", "notOnBoard"] as const
const SHARED_KEYS = ["dnp", "excludeFromBom", "excludeFromPos"] as const
export type SharedFlag = (typeof SHARED_KEYS)[number]
const FOOTPRINT_KEYS = ["mount", "virtual", "boardOnly", "allowMissingCourtyard", "allowMaskBridges", "jumperDuplicates", "jumperGroups", "netTies"] as const

/** The words of the three flags a footprint also has, for saying where the two disagree. */
const SHARED_WORDS: { [K in SharedFlag]: string } = { dnp: "do not populate", excludeFromBom: "not in the BOM", excludeFromPos: "not in the position file" }

/**
 * The part's flags from its symbol's and its footprint's. `voice` says, for the three shared flags, which ones the
 * symbol is the authority for and which ones it states; without it the symbol is the authority for all three.
 */
export function joinFlags(symbol: PartFlags | undefined, footprint: PartFlags | undefined, voice?: { authority: ReadonlySet<SharedFlag>; stated: ReadonlySet<SharedFlag> }): { flags: PartFlags | undefined; differ: string[] } {
  const out: PartFlags = {}
  const authority = (k: SharedFlag) => voice?.authority.has(k) ?? true
  for (const key of SYMBOL_ONLY_KEYS) if (symbol?.[key]) out[key] = true
  for (const key of SHARED_KEYS) {
    if (authority(key)) {
      if (symbol?.[key]) out[key] = true
    } else if (footprint?.[key] || (voice?.stated.has(key) && symbol?.[key])) out[key] = true
  }
  for (const key of FOOTPRINT_KEYS) if (footprint?.[key] !== undefined) (out as Record<string, unknown>)[key] = footprint[key]
  const differ = SHARED_KEYS.filter((k) => authority(k) && !!symbol?.[k] !== !!footprint?.[k]).map((k) => `${SHARED_WORDS[k]} (the symbol says ${symbol?.[k] ? "yes" : "no"}, the footprint ${footprint?.[k] ? "yes" : "no"})`)
  return { flags: cleanFlags(out), differ }
}
