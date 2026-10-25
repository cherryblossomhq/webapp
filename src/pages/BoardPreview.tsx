import { useId, useMemo } from "react"
import { boardColors, boardFinish, boardTextStrokes, boardTextStrokeWidth, finishMetal, mountingHoles, ownTexts } from "../model/board"
import { isNpth, isPhysical, pcbCourtyard, pcbPads, pcbSilk, slotEnds, type WorldPad } from "../model/instances"
import { findPart } from "../model/library"
import { pathsSvgPath } from "../model/shapes"
import type { Project } from "../model/types"
import { getZoneFills } from "../store/analysis"

/** Mix two hex colours; t = 0 gives a, 1 gives b. */
function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16)
  const pb = parseInt(b.slice(1), 16)
  const ch = (shift: number) => Math.round(((pa >> shift) & 255) * (1 - t) + ((pb >> shift) & 255) * t)
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0")}`
}

function padElement(pad: WorldPad, key: string, fill: string) {
  if (pad.shape === "circle") return <circle key={key} cx={pad.x} cy={pad.y} r={pad.width / 2} fill={fill} />
  if (pad.shape === "polygon" && pad.points) return <polygon key={key} points={pad.points.map((p) => `${p.x},${p.y}`).join(" ")} fill={fill} />
  const rx = pad.shape === "pill" ? Math.min(pad.width, pad.height) / 2 : Math.min(pad.width, pad.height) * 0.12
  return <rect key={key} x={pad.x - pad.width / 2} y={pad.y - pad.height / 2} width={pad.width} height={pad.height} rx={rx} fill={fill} />
}

/**
 * Top view of the bare board as a fab would ship it: copper under the mask shows lighter,
 * pads are plated, silkscreen on top. Part bodies are hinted with soft shadows.
 */
export function BoardPreview({ project }: { project: Project }) {
  const content = useMemo(() => {
    const b = project.board
    const { mask, silk } = boardColors(b)
    const metal = { gold: "#e1bd62", tin: "#cfd2d6", copper: "#d99a6c" }[finishMetal(boardFinish(b))]
    const copperTone = mix(mask, "#e8b04a", 0.22)
    const fills = getZoneFills(project).filter((f) => f.layer === "top")
    const parts = project.components.filter((c) => c.pcb.placed && isPhysical(findPart(c.partId)))
    const topPads = parts.flatMap((c) => pcbPads(c).filter((p) => p.layers.includes("top")))
    const pourD = fills
      .flatMap((f) => f.polygons.flatMap((poly) => poly.map((ring) => `M${ring.map((p) => `${p.x},${p.y}`).join("L")}Z`)))
      .join("")
    const outlineD = b.outline?.paths.length ? pathsSvgPath(b.outline.paths.filter((p) => p.closed)) : ""
    return { b, mask, silk, metal, copperTone, pourD, outlineD, parts, topPads }
  }, [project])

  const { b, mask, silk, metal, copperTone, pourD, outlineD, parts, topPads } = content
  // Not the project's id: the examples share one, and an SVG id is global to the page.
  const soft = `soft${useId().replace(/[^\w-]/g, "")}`
  const minX = b.x - b.width / 2
  const minY = b.y - b.height / 2
  const pad = Math.max(b.width, b.height) * 0.06
  return (
    <svg
      viewBox={`${minX - pad} ${-(minY + b.height) - pad} ${b.width + pad * 2} ${b.height + pad * 2}`}
      className="h-full w-full"
      aria-hidden
    >
      <defs>
        <filter id={soft} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation={Math.max(b.width, b.height) * 0.006} />
        </filter>
      </defs>
      <g transform="scale(1,-1)">
        {outlineD ? (
          <>
            <path d={outlineD} transform={`translate(${pad * 0.12} ${-pad * 0.18})`} fill="#000" fillRule="evenodd" opacity={0.28} filter={`url(#${soft})`} />
            <path d={outlineD} fill={mask} fillRule="evenodd" />
          </>
        ) : (
          <>
            <rect x={minX + pad * 0.12} y={minY - pad * 0.18} width={b.width} height={b.height} rx={b.cornerRadius} fill="#000" opacity={0.28} filter={`url(#${soft})`} />
            <rect x={minX} y={minY} width={b.width} height={b.height} rx={b.cornerRadius} fill={mask} />
          </>
        )}
        {pourD && <path d={pourD} fill={copperTone} fillRule="evenodd" />}
        {project.traces
          .filter((t) => t.layer === "top")
          .map((t) => (
            <polyline key={t.id} points={t.points.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={copperTone} strokeWidth={t.width} strokeLinecap="round" strokeLinejoin="round" />
          ))}
        {project.vias.map((v) => (
          <circle key={v.id} cx={v.x} cy={v.y} r={v.diameter / 2} fill={copperTone} />
        ))}
        {/* Soft footprint shadows hint at where parts sit. */}
        <g filter={`url(#${soft})`} opacity={0.3}>
          {parts.map((c) => {
            const cy = pcbCourtyard(c)
            if (!cy || c.pcb.side !== "top") return null
            const inset = Math.min(cy.maxX - cy.minX, cy.maxY - cy.minY) * 0.18
            return <rect key={c.id} x={cy.minX + inset} y={cy.minY + inset} width={cy.maxX - cy.minX - inset * 2} height={cy.maxY - cy.minY - inset * 2} fill="#000" />
          })}
        </g>
        {/* Non-plated holes have no copper; they only show as drilled holes below. */}
        {topPads.map((p, i) => (isNpth(p) ? null : padElement(p, `p${i}`, metal)))}
        {mountingHoles(b).map((h) => (
          <circle key={h.id} cx={h.x} cy={h.y} r={h.diameter / 2} fill={metal} />
        ))}
        {topPads.filter((p) => p.holeDiameter).map((p, i) => {
          const ends = slotEnds(p)
          if (!ends) return <circle key={`h${i}`} cx={p.x} cy={p.y} r={(p.holeDiameter ?? 0) / 2} fill="#141217" />
          const [a, z] = ends
          return <line key={`h${i}`} x1={a.x} y1={a.y} x2={z.x} y2={z.y} stroke="#141217" strokeWidth={p.holeDiameter} strokeLinecap="round" />
        })}
        {mountingHoles(b).map((h) => (
          <circle key={`mh${h.id}`} cx={h.x} cy={h.y} r={h.drill / 2} fill="#141217" />
        ))}
        {project.vias.map((v) => (
          <circle key={`vh${v.id}`} cx={v.x} cy={v.y} r={v.drill / 2} fill={mix(mask, "#000000", 0.45)} />
        ))}
        <g fill="none" stroke={silk} strokeLinecap="round" strokeLinejoin="round" opacity={0.92}>
          {parts
            .filter((c) => c.pcb.side === "top")
            .flatMap((c) => pcbSilk(c).map((path, i) => <polyline key={`${c.id}${i}`} points={path.map((p) => `${p.x},${p.y}`).join(" ")} strokeWidth={0.15} />))}
          {ownTexts(project)
            .filter((t) => t.side === "top")
            .flatMap((t) =>
              boardTextStrokes(t).map((path, i) => <polyline key={`${t.id}${i}`} points={path.map((p) => `${p.x},${p.y}`).join(" ")} strokeWidth={boardTextStrokeWidth(t)} />),
            )}
        </g>
      </g>
    </svg>
  )
}
