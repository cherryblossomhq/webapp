import type { PartCandidate, PartSearchResponse, SupplierPart, SupplierPin } from "@cherryblossom/api-contract"
import type { SupplierPartsSource } from "../../../src/ai/supplierParts"
import { pinRole } from "../../../src/model/supplier/roles"

// Hand-built supplier answers for the cases a recording doesn't have: the shape of a family of
// part numbers (variants in one package, in two, a user's upload among them), without a network.

/** `1:VIN 2:GND 3:EN` as the supplier's pins, each with the role its name declares. */
export const pinsOf = (map: string): SupplierPin[] =>
  map
    .trim()
    .split(/\s+/)
    .map((pair) => {
      const i = pair.indexOf(":")
      const name = pair.slice(i + 1)
      return { number: pair.slice(0, i), name, aliases: [], role: pinRole(name) }
    })

export const candidate = (over: Partial<PartCandidate> & { pinMap?: string }): PartCandidate => {
  const { pinMap, ...rest } = over
  const pins = pinMap ? pinsOf(pinMap) : (rest.pins ?? null)
  return {
    lcsc: "C1",
    mpn: "PART",
    manufacturer: null,
    package: "SOIC-8_L4.9-W3.9-P1.27-LS6.0-BL",
    description: null,
    stock: 10,
    match: "prefix",
    pinCount: pins ? pins.length : 8,
    hasVendorPinout: true,
    hasVendorLand: true,
    pins,
    ...rest,
  }
}

/** A source whose search answers with `candidates` and whose parts are built from them. */
export function candidateSource(...candidates: PartCandidate[]): SupplierPartsSource & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    search: async (query): Promise<PartSearchResponse> => ({ query, candidates, source: "easyeda", fetchedAt: "2026-10-20T00:00:00.000Z", attribution: "test" }),
    part: async (lcsc): Promise<SupplierPart | null> => {
      reads.push(lcsc)
      const c = candidates.find((x) => x.lcsc === lcsc)
      if (!c) return null
      return {
        lcsc: c.lcsc,
        mpn: c.mpn,
        manufacturer: c.manufacturer,
        package: c.package,
        description: c.description,
        datasheet: null,
        stock: c.stock,
        pins: c.pins ?? null,
        land: null,
        provenance: {
          source: "easyeda",
          fetchedAt: "2026-10-20T00:00:00.000Z",
          confidence: "single_source",
          vendors: 1,
          references: [c.lcsc],
          disputes: [],
          ...(c.userUpload ? { userUpload: true as const } : {}),
          attribution: "test",
        },
      }
    },
  }
}
