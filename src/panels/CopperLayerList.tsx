import { Eye, EyeOff } from "lucide-react"
import { copperColor } from "../editor/theme"
import { copperLayers, layerLabel } from "../model/stack"
import type { BoardDef, CopperLayer } from "../model/types"
import { copperShown, useUi } from "../store/uiStore"

// The board's copper layers as a list: each with its colour (`copperColor`, the one function that colours a layer on the board, in the layer menus and in
// Sakura's pictures), its name, and an eye to hide it. With `pick` a row is also how the layer to work on is chosen, and the one being worked on is marked.
// It is the same list in the toolbar's layer menu, in its Layers menu and in the Inspector, so a colour is the same layer wherever it is seen.

export function CopperLayerList({ board, pick, onPicked }: { board: Pick<BoardDef, "stack">; pick?: boolean; onPicked?: (layer: CopperLayer) => void }) {
  const layers = useUi((s) => s.layers)
  const hiddenCopper = useUi((s) => s.hiddenCopper)
  const toggleCopper = useUi((s) => s.toggleCopper)
  const active = useUi((s) => s.activeLayer)
  const setActive = useUi((s) => s.setActiveLayer)
  return (
    <ul className="max-h-[260px] min-w-0 space-y-0.5 overflow-y-auto overflow-x-hidden" aria-label="Copper layers">
      {copperLayers(board).map((l) => {
        const shown = copperShown({ layers, hiddenCopper }, l)
        const name = layerLabel(board, l)
        return (
          <li key={l} className={`flex min-w-0 items-center gap-2 whitespace-nowrap rounded-[6px] px-2 py-1 text-[12.5px] ${pick && l === active ? "bg-chrome font-[600]" : "hover:bg-chrome"}`}>
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${shown ? "" : "opacity-30"}`} style={{ background: copperColor(l) }} data-layer-swatch={l} aria-hidden />
            {pick ? (
              <button
                type="button"
                className={`min-w-0 flex-1 truncate whitespace-nowrap text-left ${shown ? "" : "text-ink-3"}`}
                aria-current={l === active ? "true" : undefined}
                title={`Work on ${name} copper`}
                onClick={() => {
                  setActive(l)
                  onPicked?.(l)
                }}
              >
                {name}
              </button>
            ) : (
              <span className={`min-w-0 flex-1 truncate whitespace-nowrap ${shown ? "" : "text-ink-3"}`} title={name}>{name}</span>
            )}
            <button type="button" className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-2 hover:text-ink" aria-label={`${shown ? "Hide" : "Show"} ${name} copper`} aria-pressed={shown} title={shown ? "Hide this layer" : "Show this layer"} onClick={() => toggleCopper(l)}>
              {shown ? <Eye size={14} /> : <EyeOff size={14} />}
            </button>
          </li>
        )
      })}
    </ul>
  )
}
