import { diffDocuments, type Change, type DocumentShape } from "@cherryblossom/project-changes"
import type { Project } from "../model/types"

/**
 * What a project's fields are, for working out what an edit changed (`projectChanges`).
 *
 * The lists of items are edited item by item, each named by its id (a project land pattern by its
 * name, a variant by its name, a project property by its key), so two people changing two parts,
 * or two values of one part, both keep their edit. Every other field is a value (the board, the
 * rules, the symbol drawings and the variants' choice down to each of their keys; a list that has
 * no ids, such as the layer stack, the 3D model assignments or the ignored checks, is one value
 * and the later edit of it wins). Where a project is kept (its id and dates) never travels.
 *
 * Every field of `Project` is covered: `tests/sync-kicad-model.test.ts` fails when one is added
 * to the type's default project without a way to travel, and lists how each one does.
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
    drawings: "id",
    parts: "id",
    footprints: "name",
    // The KiCad model: sheets and what is drawn on them, the board's graphics, dimensions, groups and images.
    sheets: "id",
    sheetSymbols: "id",
    busAliases: "id",
    graphics: "id",
    dimensions: "id",
    groups: "id",
    images: "id",
    properties: "key",
    // A list inside an object: the schematic variants (`variants.active` is a value beside it).
    "variants.list": "name",
  },
  // `scope` is only on a view of one use of a sheet, never on a project that is open.
  ignore: ["id", "createdAt", "updatedAt", "scope"],
}

/** The changes that take one state of an open project to another. */
export const projectChanges = (before: Project, after: Project): Change[] => diffDocuments(before, after, PROJECT_SHAPE)
