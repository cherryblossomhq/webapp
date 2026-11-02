// The blocks of a KiCad file the export's text writers find and rewrite: written by `circuit-json-to-kicad` or the editor's own writers, two spaces a level.

/** A board file's footprint blocks: each from its line to the next item at the top or the file's end. */
export const FOOTPRINT_BLOCK = /\n {2}\(footprint\b[\s\S]*?(?=\n {2}\(|\n\)\s*$)/g

/** The reference a block's Reference property names, as the file writes it. */
export const referenceOf = (block: string): string | undefined => block.match(/\(property "Reference" "([^"]*)"/)?.[1]
