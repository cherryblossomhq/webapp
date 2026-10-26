export interface RawItem {
  kind: "text" | "textbox" | "polyline" | "rectangle" | "circle" | "arc" | "bezier" | "image" | "table" | "directive" | "rule_area"
  /** The item's numbers in millimetres as the file writes them. */
  nums: number[]
  /** The drawn boxes of a text box or table cells as [x0, y0, x1, y1] in the file's own frame (y down). */
  rects?: number[][]
  /** Where the text of each box or cell is anchored, [x, y] in the file's frame (y down). */
  anchors?: number[][]
  text?: string
  /** A directive label's shape word, its properties as [name, value] and the file's place of each (`at`). */
  shape?: string
  fields?: [string, string][]
  fieldAt?: number[][]
  /** A rule area's flags as the file says them. */
  flags?: { dnp: boolean; noBom: boolean; noBoard: boolean; noSim: boolean }
}
export function rawItems(text: string): RawItem[]

export interface RawBuses {
  /** Each bus as `[x1, y1, x2, y2]`, in millimetres as the file writes them (y down). */
  buses: number[][]
  entries: { at: number[]; size: number[]; toBus: boolean }[]
  aliases: { name: string; members: string[] }[]
}
export function rawBuses(text: string): RawBuses
