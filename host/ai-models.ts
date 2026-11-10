/**
 * `@cherryblossom/ai-models`: how the copilot's model picker names a model.
 *
 * The hosted app keeps the roster of models each plan includes, with the
 * product name, tagline and credit weight of each, and the picker lists what
 * the signed-in plan has. This build has no managed AI, so the picker never
 * opens, a model is named by its id, and every model counts one credit a token.
 */

/** The plans, in the order they are bought up. */
export type ModelAccessPlan = "free" | "pro" | "ultra" | "enterprise";

export interface ManagedModel {
  id: string;
  label: string;
  tagline: string;
  /** How many credits one metered token on this model counts as. */
  creditWeight: number;
}

/** The roster the picker shows locked, under the plan that has each: none here. */
export const MANAGED_MODELS: readonly ManagedModel[] = [];

/** The first plan that grants the model; with no roster, none does. */
export function firstPlanWith(_id: string): ModelAccessPlan | null {
  return null;
}

export function describeManagedModel(id: string): ManagedModel {
  return { id, label: id, tagline: "", creditWeight: 1 };
}

/** "4× credits" for a model that counts more than one credit a token; never, here. */
export function creditWeightLabel(_id: string): string | null {
  return null;
}

/** The model's name, with its weight when it has one. */
export function modelNameWithWeight(id: string): string {
  return describeManagedModel(id).label;
}

/** What a model costs against the cheapest; null for one that counts 1:1, which is every one here. */
export function creditWeightNote(_id: string): string | null {
  return null;
}
