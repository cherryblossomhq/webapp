import { describe, expect, it, vi } from "vitest"
import { computeConnectivity } from "../src/model/connectivity"
import { EXAMPLES } from "../src/model/examples"
import { serializeProject } from "../src/model/projectFile"
import { boardPreviewSvg, previewFills } from "../src/pages/boardPreviewSvg"
import { boardPreview } from "../src/pages/previews"
import { projectPicture } from "../src/store/projectActions"
import type { ProjectStorage, StoredProjectSummary } from "../src/store/storage"

// A projects page's previews: drawn as SVG text in a worker (on this thread here), and a picture kept with each project.
// Node has no canvas, so the kept picture is a stand-in.
vi.mock("../src/pages/previews", async (actual) => ({
  ...(await actual<typeof import("../src/pages/previews")>()),
  rasterize: async () => new Blob(["webp"], { type: "image/webp" }),
}))

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
}

describe("boardPreviewSvg", () => {
  it("draws every example as an SVG file", () => {
    for (const { project: p } of EXAMPLES) {
      const svg = boardPreviewSvg(p, previewFills(p, computeConnectivity(p)))
      expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="[\d.]+" height="[\d.]+" viewBox=/)
      expect(svg.endsWith("</svg>")).toBe(true)
      expect(svg).not.toMatch(/NaN|undefined/)
    }
  })

  it("writes a colour from the file into the markup only when it is a hex colour", () => {
    const p = EXAMPLES[0].project
    expect(boardPreviewSvg({ ...p, board: { ...p.board, maskColor: '"/><script>' } }, [])).not.toContain("<script>")
  })
})

describe("boardPreview", () => {
  it("reads a project's file once per change, and gives null for one it can't read", async () => {
    const file = vi.fn(() => serializeProject(EXAMPLES[0].project))
    const first = boardPreview({ key: "k", updatedAt: 1, file })
    expect(boardPreview({ key: "k", updatedAt: 1, file })).toBe(first)
    expect(await first).toMatch(/^<svg/)
    await boardPreview({ key: "k", updatedAt: 2, file })
    expect(file).toHaveBeenCalledTimes(2)
    expect(await boardPreview({ key: "bad", file: () => "{not json" })).toBeNull()
  })

  it("downloads two projects at a time", async () => {
    let running = 0
    let most = 0
    const file = async () => {
      most = Math.max(most, ++running)
      await settle()
      running--
      return serializeProject(EXAMPLES[1].project)
    }
    await Promise.all(["a", "b", "c", "d"].map((key) => boardPreview({ key, file })))
    expect(most).toBe(2)
  })
})

describe("projectPicture", () => {
  let n = 0
  const meta = (extra: Partial<StoredProjectSummary> = {}) => ({ id: `p${++n}`, name: "Board", description: "", createdAt: 0, updatedAt: 9, ...extra }) as StoredProjectSummary
  function storage(keeps = true) {
    const load = vi.fn(async (id: string) => ({ id, content: serializeProject(EXAMPLES[0].project), revision: 1, createdAt: 0, updatedAt: 9 }))
    const saveThumbnail = vi.fn(async () => true)
    return { load, saveThumbnail, storage: { load, ...(keeps ? { saveThumbnail } : {}) } as unknown as ProjectStorage }
  }

  it("shows a kept picture at once, and keeps a new one when the project changed since", async () => {
    const s = storage()
    expect(await projectPicture(s.storage, meta({ thumbnail: { url: "u1", madeAt: 9 } }))).toEqual({ url: "u1" })
    await settle()
    expect(s.load).not.toHaveBeenCalled()
    const stale = meta({ thumbnail: { url: "u2", madeAt: 3 } })
    expect(await projectPicture(s.storage, stale)).toEqual({ url: "u2" })
    await settle()
    expect(s.saveThumbnail).toHaveBeenCalledWith(stale.id, expect.any(Blob), 9)
  })

  it("draws a project with no picture and keeps it once, then keeps showing what it drew", async () => {
    const s = storage()
    const m = meta()
    const drawn = await projectPicture(s.storage, m)
    expect(drawn && "svg" in drawn).toBe(true)
    await projectPicture(s.storage, m)
    await settle()
    expect(s.saveThumbnail).toHaveBeenCalledTimes(1)
    // Storage now has it: the card keeps the board it drew rather than swapping to the same one fetched back.
    expect(await projectPicture(s.storage, { ...m, thumbnail: { url: "u", madeAt: 9 } })).toEqual(drawn)
    expect(s.load).toHaveBeenCalledTimes(1)
  })

  it("keeps nothing for a viewer, nor where storage keeps no pictures", async () => {
    const s = storage()
    await projectPicture(s.storage, meta({ role: "viewer" }))
    expect(await projectPicture(storage(false).storage, meta())).toEqual({ svg: expect.stringMatching(/^<svg/) })
    await settle()
    expect(s.saveThumbnail).not.toHaveBeenCalled()
  })
})
