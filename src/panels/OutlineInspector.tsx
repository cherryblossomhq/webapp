import { Trash2 } from "lucide-react"
import { flattenPath, pathsBox } from "../model/shapes"
import { outlineGeometry } from "../model/outline"
import { outlineSlots, parseOutlineSelectionId, removeOutlinePath } from "../model/outlineOps"
import type { Project } from "../model/types"
import { projectApi } from "../store/projectStore"
import { uiApi } from "../store/uiStore"
import { Button } from "../ui/controls"
import { Row, Section } from "../ui/form"

/** What is selected on the board's own outline: a piece of board, a cutout, a slot, or an edge that does not close. */
export function OutlineInspector({ project, selection }: { project: Project; selection: string[] }) {
  const pieces = selection.map(parseOutlineSelectionId).filter((x): x is { path: number; seg: number } => x !== null)
  const paths = project.board.outline?.paths ?? []
  const first = paths[pieces[0]?.path]
  if (!first) return null
  const g = outlineGeometry(project.board)
  const ring = g?.rings.find((r) => r.path === pieces[0].path)
  const slot = outlineSlots(paths).find((s) => s.path === pieces[0].path)
  const kind = !first.closed ? "An open edge" : slot ? "A slot" : ring?.hole ? "A cutout" : "A piece of the board"
  const b = pathsBox([first])
  let length = 0
  const pts = flattenPath(first)
  for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  if (first.closed && pts.length > 1) length += Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y)
  const remove = () => {
    projectApi().commit((p) => [...new Set(pieces.map((x) => x.path))].sort((a, c) => c - a).reduce((acc, idx) => removeOutlinePath(acc, idx), p))
    uiApi().clearSelection()
  }
  return (
    <Section title="Board outline">
      <div className="space-y-1">
        <Row label="Shape" value={kind} />
        <Row label="Edges" value={first.segs.length} />
        <Row label="Size" value={`${(b.maxX - b.minX).toFixed(2)} x ${(b.maxY - b.minY).toFixed(2)} mm`} />
        <Row label="Length" value={`${length.toFixed(2)} mm`} />
        {slot ? <Row label="Slot width" value={`${slot.width.toFixed(2)} mm`} /> : null}
      </div>
      {!first.closed ? <p className="text-[12.5px] text-ink-2">This edge does not close, so the board cannot be fabricated. Draw the rest of the shape on Edge.Cuts, ending on its start.</p> : null}
      <p className="text-[12.5px] text-ink-3">Drag a square to move a corner, the dot to bend an arc, the edge to move the whole shape. The bar above the edge bends it or adds a corner.</p>
      <Button variant="danger" onClick={remove}>
        <Trash2 size={14} /> Delete shape
      </Button>
    </Section>
  )
}
