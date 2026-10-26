/**
 * `@cherryblossom/ai-models`: how the copilot's model picker names a model.
 *
 * The hosted app keeps the roster of models each plan includes, with the
 * product name and tagline of each, and the picker lists what the signed-in
 * plan has. This build has no managed AI, so the picker never opens, and a
 * model is named by its id.
 */

export interface ManagedModel {
  id: string;
  label: string;
  tagline: string;
}

export function describeManagedModel(id: string): ManagedModel {
  return { id, label: id, tagline: "" };
}
