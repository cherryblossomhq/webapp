import { ArrowDownToLine, House } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { pcbCourtyard } from "../../model/instances"
import { findPart } from "../../model/library"
import { createProject } from "../../model/ops"
import type { BoardDef, ComponentInstance, Model3D, Project } from "../../model/types"
import { useUi } from "../../store/uiStore"
import { IconButton } from "../../ui/controls"
import { backdropCss, BoardScene } from "./boardScene"

// One part in 3D for the part editor: alone on a scrap of board just bigger than its courtyard, in
// the project's board colours, drawn by the same scene as the 3D view, so the model sits exactly
// as it will on the board. Loaded on demand, like the 3D view, to keep three.js out of the page.

const MARGIN = 1.5

/** The part on its footprint, with its model, as a project of its own. */
function previewProject(partId: string, footprint: string, model: Model3D | null, board: BoardDef): Project {
  const part = findPart(partId)
  const c: ComponentInstance = {
    id: "preview",
    partId,
    ref: `${part?.refPrefix ?? "U"}1`,
    props: { ...part?.defaultProps },
    footprint,
    sch: { x: 0, y: 0, rot: 0 },
    pcb: { x: 0, y: 0, rot: 0, side: "top", placed: true },
  }
  const box = pcbCourtyard(c) ?? { minX: -2, minY: -2, maxX: 2, maxY: 2 }
  return {
    ...createProject("Part preview"),
    board: {
      x: (box.minX + box.maxX) / 2,
      y: (box.minY + box.maxY) / 2,
      width: Math.max(box.maxX - box.minX + 2 * MARGIN, 4),
      height: Math.max(box.maxY - box.minY + 2 * MARGIN, 4),
      thickness: board.thickness,
      cornerRadius: 0.5,
      ...(board.maskColor && { maskColor: board.maskColor }),
      ...(board.silkColor && { silkColor: board.silkColor }),
      ...(board.finish && { finish: board.finish }),
    },
    components: [c],
    ...(model && { models: [{ part: partId, footprint, model }] }),
  }
}

export function PartPreview3D({ partId, footprint, model, board }: { partId: string; footprint: string; model: Model3D | null; board: BoardDef }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<BoardScene | null>(null)
  const [failed, setFailed] = useState(false)
  const realModels = useUi((s) => s.settings.realModels)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let scene: BoardScene
    try {
      scene = new BoardScene(host, null)
    } catch {
      setFailed(true)
      return
    }
    sceneRef.current = scene
    return () => {
      sceneRef.current = null
      scene.dispose()
    }
  }, [])

  useEffect(() => sceneRef.current?.setRealModels(realModels), [realModels])
  useEffect(() => {
    sceneRef.current?.setProject(previewProject(partId, footprint, model, board), [])
  }, [partId, footprint, model, board])

  return (
    <div className="relative h-full w-full overflow-hidden" style={{ background: backdropCss }}>
      <div ref={hostRef} className="absolute inset-0" />
      {failed ? (
        <p className="absolute inset-0 flex items-center justify-center p-4 text-center text-[12px] text-[#c9c4d6]">The 3D preview needs WebGL, and this browser has it turned off.</p>
      ) : (
        <div className="absolute left-2 top-2 flex gap-0.5 rounded-[8px] border border-line bg-surface/90 p-0.5 shadow-float">
          <IconButton label="Fit" onClick={() => sceneRef.current?.view("home")}>
            <House size={15} />
          </IconButton>
          <IconButton label="Top view" onClick={() => sceneRef.current?.view("top")}>
            <ArrowDownToLine size={15} />
          </IconButton>
        </div>
      )}
    </div>
  )
}
