/** A uuid in KiCad's shape, numbered so the same project writes the same file. `kind` is the fourth group, which keeps one writer's uuids from meeting another's. */
export const stableUuid = (kind: string, n: number) => `00000000-0000-4000-${kind}-${n.toString(16).padStart(12, "0")}`
