/**
 * `@cherryblossom/editor/kicad`: KiCad's symbol and footprint files as parts in the editor's
 * shapes (pins with roles, a land in millimetres). The parts database's import
 * runs it to store each KiCad part whole, so the editor places one without
 * converting anything. Pure functions over file text: no DOM, store or footprinter.
 */
export { convertSymbol, type Conversion, type ConvertContext, type KicadLandRow, type KicadPartRow, type SkipCode } from "./convert"
export { convertFootprint, type FootprintResult } from "./footprint"
export { all, first, flag, num, parseSexpr, str, type SNode } from "./sexpr"
export { parseSymbols, resolveExtends, type KicadPin, type RawSymbol } from "./symbol"
