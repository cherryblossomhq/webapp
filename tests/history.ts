import { expect } from "vitest"
import type { Project } from "../src/model/types"
import { projectChanges } from "../src/store/changes"

/**
 * Undo and Redo apply a step's changes rather than go back to a copy, so they give back an equal
 * project, not the same object, with a date of its own: the same is nothing left to send.
 */
export const expectSameProject = (actual: Project | null, expected: Project) => expect(projectChanges(actual!, expected)).toEqual([])
