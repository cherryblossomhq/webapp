import * as THREE from "three"
import { getFootprint } from "../../../model/footprints"
import type { Model3D } from "../../../model/types"
import { boundsUnder, placementMatrix } from "./placement"

/**
 * A file placed by its own origin, as KiCad places one, unless that lands it off its footprint
 * (a manufacturer's model drawn about some other point): then centred on the footprint instead.
 */
export function fitToFootprint(model: Model3D, object: THREE.Group, footprint: string): Model3D {
  const box = boundsUnder(object, placementMatrix(model, object))
  if (box.isEmpty()) return model
  const cy = getFootprint(footprint).courtyard
  const mid = box.getCenter(new THREE.Vector3())
  const inside = mid.x >= cy.minX - 1 && mid.x <= cy.maxX + 1 && mid.y >= cy.minY - 1 && mid.y <= cy.maxY + 1
  if (inside && Math.abs(box.min.z) < 5) return model
  return { ...model, origin: "center", offset: { x: (cy.minX + cy.maxX) / 2, y: (cy.minY + cy.maxY) / 2, z: 0 } }
}
