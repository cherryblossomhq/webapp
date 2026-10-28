// Writes a table of decisions as the source of an array, one rule on a line, so a rule can be found and compared line by line.
export const rows = (items) => (items.length ? `[\n${items.map((r) => `  ${JSON.stringify(r)}`).join(",\n")},\n]` : "[]")
