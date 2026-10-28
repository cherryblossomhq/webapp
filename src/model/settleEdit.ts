import { pruneGroups } from "./boardObjects"
import { followNetRenames } from "./copperNets"
import { settleLabelNetClasses } from "./directives"
import { pruneImportMarks } from "./importMarks"
import { settleKicadSheet } from "./kicadJoin"
import type { Project } from "./types"

/**
 * What every edit is finished with before it is kept, wherever it is made: a commit or a drag in
 * the editor (`store/projectStore.ts`) and a tool an assistant calls through MCP (`mcp/session.ts`).
 *
 * Copper that names its net follows a rename, what an import marked that no longer holds is retired, and a group loses what an edit deleted (and goes when nothing is left in it).
 * The first two stop at once for an edit that left the schematic alone, the group one for a board with no groups, and the classes directive labels give (S8) for a project with none.
 * S11: whatever made the edit, a sheet joined by KiCad's rules is left with its new T's cut, as KiCad cuts them (an edit that has done it already is unchanged by it, and a project with no such sheet is returned as it is).
 */
export const settleEdit = (before: Project, made: Project) => settleLabelNetClasses(before, pruneGroups(pruneImportMarks(before, followNetRenames(before, settleKicadSheet(before, made)))))
