import { ArrowDownToLine, ArrowUpFromLine, Box, Camera, FileBox, Grid3x3, House, LoaderCircle } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { downloadText, projectFileName } from "../../export/bundle"
import { boardColors, boardFinish, DEFAULT_MASK_COLOR, defaultSilkColor, SURFACE_FINISHES } from "../../model/board"
import { ColorField } from "../../ui/form"
import type { SurfaceFinish } from "../../model/types"
import { getLiveZoneFills, useFillTick } from "../../store/analysis"
import { projectApi, useProjectStore } from "../../store/projectStore"
import { selectionIds, uiApi, useUi } from "../../store/uiStore"
import { IconButton } from "../../ui/controls"
import { Tooltip } from "../../ui/Tooltip"
import { backdropCss, BoardScene, type CameraPreset, type ModelStatus } from "./boardScene"
import { placedComponents } from "./buildBoard"

const REBUILD_DEBOUNCE_MS = 120
const shell =
  "pointer-events-auto flex items-center gap-0.5 rounded-[10px] border border-line bg-surface/95 p-1 shadow-float backdrop-blur"

const MISSING_LISTED = 6

/** "No 3D model: J1, SW1 and U2", listing a few. */
function missingText(refs: string[]): string {
  const listed = refs.slice(0, MISSING_LISTED)
  const more = refs.length - listed.length
  const names = more > 0 ? `${listed.join(", ")} and ${more} more` : listed.length > 1 ? `${listed.slice(0, -1).join(", ")} and ${listed.at(-1)}` : listed[0]
  return `No 3D model: ${names}`
}

function fileName(name: string) {
  const base = name.trim().replace(/[^\w\- ]+/g, "").replace(/\s+/g, "-").toLowerCase() || "board"
  return `${base}-3d.png`
}

export function Board3D() {
  const project = useProjectStore((s) => s.project)
  const fillTick = useFillTick((s) => s.tick)
  const selection = useUi((s) => s.selection)
  const hostRef = useRef<HTMLDivElement>(null)
  const cubeRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<BoardScene | null>(null)
  const [failed, setFailed] = useState(false)
  const [showParts, setShowParts] = useState(true)
  const [showGrid, setShowGrid] = useState(true)
  const [finishOpen, setFinishOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null)
  const [building, setBuilding] = useState(false)
  const [stepNotice, setStepNotice] = useState<{ text: string; notes: string[] } | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let scene: BoardScene
    try {
      scene = new BoardScene(host, cubeRef.current)
    } catch {
      setFailed(true)
      return
    }
    sceneRef.current = scene
    if (process.env.NODE_ENV === "development") Object.assign(window, { __board3d: scene })
    scene.onPickPart = (id) => uiApi().select(id ? [`c:${id}`] : [])
    scene.onModelStatus = setModelStatus
    scene.onBoardBuilding = setBuilding
    const p = useProjectStore.getState().project
    scene.setProject(p, p ? getLiveZoneFills(p) : [])
    return () => {
      sceneRef.current = null
      scene.dispose()
    }
  }, [])

  // Rebuild meshes when the document changes; drags fire many updates, so debounce.
  const builtOnce = useRef(false)
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    if (!builtOnce.current) {
      builtOnce.current = true
      return
    }
    const timer = setTimeout(() => scene.setProject(project, project ? getLiveZoneFills(project) : []), REBUILD_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [project, fillTick])

  useEffect(() => sceneRef.current?.setPartsVisible(showParts), [showParts])
  useEffect(() => sceneRef.current?.setGridVisible(showGrid), [showGrid])
  useEffect(() => {
    const comps = selectionIds(selection, "c")
    sceneRef.current?.setSelected(comps.length === 1 ? comps[0] : null)
  }, [selection, project])

  useEffect(() => {
    if (!finishOpen) return
    const close = (e: KeyboardEvent) => e.key === "Escape" && setFinishOpen(false)
    window.addEventListener("keydown", close)
    return () => window.removeEventListener("keydown", close)
  }, [finishOpen])

  const placedCount = project ? placedComponents(project).length : 0
  const view = (preset: CameraPreset) => sceneRef.current?.view(preset)
  const colors = project ? boardColors(project.board) : null
  const finish = project ? boardFinish(project.board) : "enig"

  const setBoard = (patch: Partial<NonNullable<typeof project>["board"]>) =>
    projectApi().commit((p) => ({ ...p, updatedAt: Date.now(), board: { ...p.board, ...patch } }))

  const screenshot = async () => {
    const scene = sceneRef.current
    if (!scene || busy) return
    setBusy(true)
    try {
      const blob = await scene.screenshot()
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = fileName(project?.name ?? "board")
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } finally {
      setBusy(false)
    }
  }

  const exportStep = async () => {
    const p = useProjectStore.getState().project
    if (!p || busy) return
    setBusy(true)
    setStepNotice({ text: "Writing STEP...", notes: [] })
    try {
      const { stepFile } = await import("../../export/step3d")
      const { text, notes } = await stepFile(p, {
        onProgress: ({ done, total }) => total > 0 && setStepNotice({ text: `Reading 3D models: ${done} of ${total}`, notes: [] }),
      })
      downloadText(text, projectFileName(p, "step"), "model/step")
      setStepNotice(notes.length ? { text: "Exported the STEP assembly.", notes } : null)
    } catch (e) {
      setStepNotice({ text: `The STEP export failed: ${e instanceof Error ? e.message : String(e)}`, notes: [] })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="absolute inset-0" style={{ background: backdropCss }}>
      <div ref={hostRef} className="absolute inset-0" />

      {failed ? (
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <p className="max-w-sm text-center text-[13px] text-[#c9c4d6]">
            The 3D view needs WebGL, and this browser has it turned off. Turn on hardware acceleration and reload.
          </p>
        </div>
      ) : (
        <>
          <div className="pointer-events-none absolute left-3 top-3 z-10 flex items-start gap-2">
            <div className={shell}>
              <IconButton label="Fit board" onClick={() => view("home")}>
                <House size={16} />
              </IconButton>
              <IconButton label="Top view" onClick={() => view("top")}>
                <ArrowDownToLine size={16} />
              </IconButton>
              <IconButton label="Bottom view" onClick={() => view("bottom")}>
                <ArrowUpFromLine size={16} />
              </IconButton>
              <span className="mx-1 h-5 w-px bg-line" />
              <IconButton label={showParts ? "Hide components" : "Show components"} active={showParts} onClick={() => setShowParts((v) => !v)}>
                <Box size={16} />
              </IconButton>
              <IconButton label={showGrid ? "Hide grid" : "Show grid"} active={showGrid} onClick={() => setShowGrid((v) => !v)}>
                <Grid3x3 size={16} />
              </IconButton>
              <span className="mx-1 h-5 w-px bg-line" />
              <Tooltip label="Board colour and finish">
                <button
                  aria-label="Board colour and finish"
                  aria-expanded={finishOpen}
                  onClick={() => setFinishOpen((v) => !v)}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-ctl)] px-2 text-[12.5px] font-medium transition-colors ${
                    finishOpen ? "bg-chrome-2 text-ink" : "text-ink-2 hover:bg-chrome-2 hover:text-ink"
                  }`}
                >
                  <span className="h-4 w-4 rounded-full border border-ink/20" style={{ background: colors?.mask }} />
                  {SURFACE_FINISHES.find((f) => f.value === finish)?.label}
                </button>
              </Tooltip>
              <IconButton label="Save image" onClick={screenshot} disabled={busy}>
                <Camera size={16} />
              </IconButton>
              <IconButton label="Export STEP" hint="The board and every part, for mechanical CAD" onClick={exportStep} disabled={busy}>
                <FileBox size={16} />
              </IconButton>
            </div>

            {finishOpen && project && colors && (
              <div className={`${shell} w-[236px] flex-col items-stretch gap-1.5 p-2.5`} role="dialog" aria-label="Board colour and finish">
                <span className="text-[12px] text-ink-2">Solder mask</span>
                <ColorField label="Solder mask colour" value={project.board.maskColor} fallback={DEFAULT_MASK_COLOR} onCommit={(maskColor) => setBoard({ maskColor })} />
                <span className="mt-1 text-[12px] text-ink-2">Silkscreen</span>
                <ColorField label="Silkscreen colour" value={project.board.silkColor} fallback={defaultSilkColor(colors.mask)} onCommit={(silkColor) => setBoard({ silkColor })} />
                <span className="mt-1 text-[12px] text-ink-2">Surface finish</span>
                <select aria-label="Surface finish" className="field h-8" value={finish} onChange={(e) => setBoard({ finish: e.target.value as SurfaceFinish })}>
                  {SURFACE_FINISHES.map((f) => (
                    <option key={f.value} value={f.value} title={f.title}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {stepNotice && (
            <div role="status" className="absolute left-3 top-14 z-10 max-w-[340px] rounded-[10px] bg-ink px-3 py-2 text-[12.5px] text-surface shadow-lg">
              <div className="flex items-start justify-between gap-2">
                <span>{stepNotice.text}</span>
                {!busy && (
                  <button onClick={() => setStepNotice(null)} className="shrink-0 underline" aria-label="Close">
                    Close
                  </button>
                )}
              </div>
              {stepNotice.notes.length > 0 && (
                <ul className="mt-1.5 list-disc space-y-0.5 border-t border-surface/20 pl-4 pt-1.5">
                  {stepNotice.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div ref={cubeRef} className="absolute right-3 top-3 z-10 h-[104px] w-[104px]" aria-label="View cube: click a face, edge or corner to look from there" />

          {building && (
            <div role="status" className="absolute left-1/2 top-16 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/10 bg-black/45 px-3 py-1 text-[12px] text-[#d9d4e6] backdrop-blur">
              <LoaderCircle size={13} className="animate-spin" />
              <span>Building the 3D board</span>
            </div>
          )}

          {showParts && modelStatus && (modelStatus.loading > 0 || modelStatus.failed.length > 0 || modelStatus.missing.length > 0) && (
            <div className="absolute bottom-3 left-3 z-10 flex max-w-[calc(100%-1.5rem)] items-center gap-2 rounded-full border border-white/10 bg-black/45 px-3 py-1 text-[12px] text-[#d9d4e6] backdrop-blur">
              {modelStatus.loading > 0 ? (
                <>
                  <LoaderCircle size={13} className="animate-spin" />
                  <span>
                    Loading 3D models: {modelStatus.total - modelStatus.loading} of {modelStatus.total}
                  </span>
                </>
              ) : modelStatus.failed.length > 0 ? (
                <>
                  <span title={modelStatus.failed.map((f) => `${f.name}: ${f.error}`).join("\n")}>
                    {modelStatus.failed.length === 1
                      ? `${modelStatus.failed[0].name} couldn't be drawn: ${modelStatus.failed[0].error}`
                      : `${modelStatus.failed.length} 3D models couldn't be drawn, so their parts show only their pads.`}
                  </span>
                  <button className="font-medium text-white underline underline-offset-2" onClick={() => sceneRef.current?.retryModels()}>
                    Retry
                  </button>
                </>
              ) : (
                <span className="truncate" title={`Only their pads are drawn. Select one to add its model in the Inspector.\n${modelStatus.missing.join(", ")}`}>
                  {missingText(modelStatus.missing)}
                </span>
              )}
            </div>
          )}

          {project && placedCount === 0 && (
            <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center px-4">
              <p className="rounded-full border border-white/10 bg-black/40 px-3 py-1 text-[12px] text-[#d9d4e6] backdrop-blur">
                Place parts on the PCB to see them here.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  )
}
