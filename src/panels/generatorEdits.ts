import type { GenValue, Project } from "../model/types"

// X21: the edits the group panel makes to a generated item's parameters. A `null` clears a parameter; anything that is not a usable number changes nothing.

/** The numbers of a tuning pattern the panel lets a person change. */
export const TUNING_KEYS = ["target_length", "target_length_min", "target_length_max", "min_spacing", "max_amplitude"] as const
export type TuningKey = (typeof TUNING_KEYS)[number]

/** The group's generator with the numbers in `patch` set (or cleared by null). The same project when nothing changes or the group has no generator. */
export function updateGeneratorProps(project: Project, groupId: string, patch: Partial<Record<TuningKey, number | null>>): Project {
  const group = project.groups?.find((g) => g.id === groupId)
  if (!group?.gen) return project
  const props: Record<string, GenValue> = { ...group.gen.props }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (value === null) delete props[key]
    else if (Number.isFinite(value) && value >= 0) props[key] = value
  }
  if (JSON.stringify(props) === JSON.stringify(group.gen.props)) return project
  return { ...project, updatedAt: Date.now(), groups: project.groups!.map((g) => (g.id === groupId ? { ...g, gen: { ...group.gen!, props } } : g)) }
}
