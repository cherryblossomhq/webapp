export interface RawItem {
  kind: "text" | "textbox" | "polyline" | "rectangle" | "circle" | "arc" | "bezier" | "image" | "table"
  /** The item's numbers in millimetres as the file writes them. */
  nums: number[]
  /** The drawn boxes of a text box or table cells as [x0, y0, x1, y1] in the file's own frame (y down). */
  rects?: number[][]
  /** Where the text of each box or cell is anchored, [x, y] in the file's frame (y down). */
  anchors?: number[][]
  text?: string
}
export function rawItems(text: string): RawItem[]
