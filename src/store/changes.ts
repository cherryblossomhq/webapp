import { diffDocuments, type Change, type DocumentShape } from "@cherryblossom/project-changes"
import type { Project } from "../model/types"

/**
 * What a project's fields are, for working out what an edit changed (`projectChanges`).
 *
 * The lists of items are edited item by item, each named by its id (a project land pattern by its
 * name), so two people changing two parts, or two values of one part, both keep their edit. Every
 * other field is a value (the board and the rules down to each of their keys). Where a project is
 * kept (its id and dates) never travels.
 */
export const PROJECT_SHAPE: DocumentShape = {
  collections: {
    components: "id",
    wires: "id",
    labels: "id",
    traces: "id",
    vias: "id",
    zones: "id",
    texts: "id",
    blocks: "id",
    parts: "id",
    footprints: "name",
  },
  ignore: ["id", "createdAt", "updatedAt"],
}

/** The changes that take one state of an open project to another. */
export const projectChanges = (before: Project, after: Project): Change[] => diffDocuments(before, after, PROJECT_SHAPE)
