import { describe, expect, it, vi } from "vitest"
import { EXAMPLES } from "../src/model/examples"
import { serializeProject } from "../src/model/projectFile"
import { projectPicture } from "../src/store/projectActions"
import type { ProjectStorage, StoredProjectSummary } from "../src/store/storage"

// The picture kept with a project for the projects list: shown at once when there is one, and drawn and kept in the background,
// by someone who may edit the project, when it is missing or older than the project. Node has no canvas, so the picture is a stand-in.
vi.mock("../src/pages/previews", async (actual) => ({
  ...(await actual<typeof import("../src/pages/previews")>()),
  rasterize: async () => new Blob(["webp"], { type: "image/webp" }),
}))

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
}

function storage(withSave = true) {
  const load = vi.fn(async (id: string) => ({ id, content: serializeProject(EXAMPLES[0].project), revision: 1, createdAt: 0, updatedAt: 9 }))
  const saveThumbnail = vi.fn(async () => true)
  return { load, saveThumbnail, storage: { load, ...(withSave ? { saveThumbnail } : {}) } as unknown as ProjectStorage }
}

let n = 0
const meta = (extra: Partial<StoredProjectSummary> = {}): StoredProjectSummary =>
  ({ id: `p${++n}`, name: "Board", description: "", updatedAt: 9, createdAt: 0, ...extra }) as StoredProjectSummary

describe("projectPicture", () => {
  it("shows a current kept picture without downloading the project", async () => {
    const s = storage()
    const picture = await projectPicture(s.storage, meta({ thumbnail: { url: "https://files/p.webp", madeAt: 9 } }))
    await settle()
    expect(picture).toEqual({ url: "https://files/p.webp" })
    expect(s.load).not.toHaveBeenCalled()
    expect(s.saveThumbnail).not.toHaveBeenCalled()
  })

  it("shows a stale picture at once, and keeps a new one drawn from the project", async () => {
    const s = storage()
    const m = meta({ thumbnail: { url: "https://files/old.webp", madeAt: 3 } })
    expect(await projectPicture(s.storage, m)).toEqual({ url: "https://files/old.webp" })
    await settle()
    expect(s.load).toHaveBeenCalledTimes(1)
    expect(s.saveThumbnail).toHaveBeenCalledWith(m.id, expect.any(Blob), 9)
  })

  it("draws a project with no picture, and keeps it once however often it is asked", async () => {
    const s = storage()
    const m = meta()
    const picture = await projectPicture(s.storage, m)
    expect(picture && "svg" in picture && picture.svg.startsWith("<svg")).toBe(true)
    await projectPicture(s.storage, m)
    await settle()
    expect(s.saveThumbnail).toHaveBeenCalledTimes(1)
  })

  it("keeps showing the picture it just drew once storage has it, rather than fetching the same board back", async () => {
    const s = storage()
    const m = meta()
    const drawn = await projectPicture(s.storage, m)
    const kept = await projectPicture(s.storage, { ...m, thumbnail: { url: "https://files/p.webp", madeAt: m.updatedAt } })
    expect(kept).toEqual(drawn)
    expect(s.load).toHaveBeenCalledTimes(1)
  })

  it("keeps nothing for a viewer, nor where storage keeps no pictures", async () => {
    const s = storage()
    await projectPicture(s.storage, meta({ role: "viewer" }))
    await settle()
    expect(s.saveThumbnail).not.toHaveBeenCalled()
    const bare = storage(false)
    const picture = await projectPicture(bare.storage, meta())
    expect(picture && "svg" in picture).toBe(true)
  })
})
