import type { OtherFill } from "../../model/nonCopperFill"
import { withPartZones } from "../../model/partZones"
import { pathsSvgPath } from "../../model/shapes"
import { otherLayerKind } from "../../model/zoneLayers"
import { zoneLayers } from "../../model/zones"
import { zoneCorners } from "../../model/zoneOps"
import type { CopperLayer, Project, Vec2 } from "../../model/types"
import { copperColor, PCB } from "../theme"
import { shapeLayerColor } from "./ShapeGraphics"

/**
 * The fills of the zones that are on layers that are not copper (X29), in their layer's colour: the silkscreen ones solid, the others as light as the drawings on those layers. `silk` picks which of the two
 * is drawn, so the silkscreen's goes with the silkscreen and the rest under it. `shown` says whether a layer is on screen, `opacityOf` how faint its side is.
 */
export function OtherZoneFills({ fills, silk, shown, opacityOf }: { fills: OtherFill[]; silk: boolean; shown: (layer: string) => boolean; opacityOf: (layer: string) => number }) {
  const list = fills.filter((f) => f.polygons.length > 0 && (otherLayerKind(f.layer) === "silk") === silk && shown(f.layer))
  if (!list.length) return null
  return (
    <g>
      {list.map((f) => {
        const d = f.polygons.flatMap((poly) => poly.map((ring) => `M${ring.map((p) => `${p.x} ${p.y}`).join("L")}Z`)).join("")
        return <path key={`${f.zoneId}|${f.layer}`} d={d} fill={shapeLayerColor(f.layer)} fillOpacity={silk ? 1 : 0.4} fillRule="evenodd" opacity={opacityOf(f.layer)} />
      })}
    </g>
  )
}

/**
 * The outlines of the zones with a polygon (a dashed line on the layer's colour, a rule area tinted and hatched), and the corners and edge
 * middles of the selected ones. The copper of the pours is drawn with the layers, where it belongs.
 */
export function ZoneOutlines({ project, selected, px, active }: { project: Project; selected: Set<string>; px: number; active: CopperLayer }) {
  // The zones inside parts are drawn where their parts are (X30); they are the part's, so they are never selected on their own.
  const zones = withPartZones(project).zones.filter((z) => z.outline)
  if (!zones.length) return null
  return (
    <g>
      <defs>
        <pattern id="keepout-hatch" width={6 * px} height={6 * px} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1={0} y1={0} x2={0} y2={6 * px} stroke="#ff5470" strokeWidth={px} />
        </pattern>
      </defs>
      {zones.map((z) => {
        const d = pathsSvgPath(z.outline!)
        const sel = selected.has(`z:${z.id}`)
        const copper = zoneLayers(z)
        // A zone that is on layers that are not copper is drawn in the colour of the first of them, at full strength (it is not on any copper layer to be dimmed on).
        const here = copper.includes(active) || (copper.length === 0 && (z.other?.length ?? 0) > 0)
        const color = z.keepout ? "#ff5470" : copper.length === 0 && z.other?.length ? shapeLayerColor(z.other[0]) : copperColor(here ? active : copper[0] ?? z.layer)
        return (
          <g key={z.id} opacity={here ? 1 : 0.45}>
            {z.keepout && <path d={d} fill="url(#keepout-hatch)" fillOpacity={0.5} fillRule="evenodd" />}
            {z.keepout && <path d={d} fill="#ff5470" fillOpacity={0.08} fillRule="evenodd" />}
            <path d={d} fill="none" stroke={sel ? PCB.select : color} strokeWidth={(sel ? 2 : 1.2) * px} strokeDasharray={z.keepout ? undefined : `${6 * px} ${4 * px}`} />
          </g>
        )
      })}
      {zones
        .filter((z) => selected.has(`z:${z.id}`) && !z.locked)
        .flatMap((z) => [
          ...zoneCorners(z).map((c) => <rect key={`${z.id}:${c.ring}:${c.index}`} x={c.at.x - 3.5 * px} y={c.at.y - 3.5 * px} width={7 * px} height={7 * px} fill="#fff" stroke={PCB.select} strokeWidth={px} />),
          ...(z.outline ?? []).flatMap((p, ring) =>
            p.segs.map((s, index) =>
              s.kind === "line" ? (
                <circle key={`${z.id}:m:${ring}:${index}`} cx={(s.a.x + s.b.x) / 2} cy={(s.a.y + s.b.y) / 2} r={2.5 * px} fill={PCB.select} opacity={0.7} />
              ) : null,
            ),
          ),
        ])}
    </g>
  )
}

/** The polygon being drawn with the zone tool: the corners so far, a line to the cursor, and a ring on the first corner when the next click closes it. */
export function ZonePreview({ points, cursor, keepout, px, closes }: { points: Vec2[]; cursor: Vec2 | null; keepout: boolean; px: number; closes: boolean }) {
  const color = keepout ? "#ff5470" : PCB.select
  const all = cursor ? [...points, cursor] : points
  return (
    <g>
      {points.length >= 2 && <polygon points={points.map((p) => `${p.x},${p.y}`).join(" ")} fill={color} fillOpacity={0.12} stroke="none" />}
      {all.length >= 2 && <polyline points={all.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={color} strokeWidth={1.5 * px} strokeDasharray={`${5 * px} ${3 * px}`} />}
      {points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={2.5 * px} fill="#fff" />
      ))}
      {closes && points[0] && <circle cx={points[0].x} cy={points[0].y} r={6 * px} fill="none" stroke="#fff" strokeWidth={1.5 * px} />}
      {cursor && <circle cx={cursor.x} cy={cursor.y} r={4 * px} fill="none" stroke="#fff" strokeWidth={px} />}
    </g>
  )
}
