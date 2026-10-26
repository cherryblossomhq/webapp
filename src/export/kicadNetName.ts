import type { Net } from "../model/types"

/**
 * The name KiCad 9's files give a net. Its file has no local power symbol, so a net a local power symbol names is written as a global one, without the
 * sheet's path: the board (`kicadBoard.ts`) and the schematic export (`circuitJson.ts`) both ask this, so the two files agree.
 */
export const kicadNetName = (net: Pick<Net, "name" | "power">): string => (net.power?.local ? net.power.text : net.name)
