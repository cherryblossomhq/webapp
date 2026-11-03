import { describe, expect, it, vi } from "vitest"
import { EXAMPLES } from "../src/model/examples"
import { computeConnectivity } from "../src/model/connectivity"
import { resolvedComponents } from "../src/model/ruleAreas"
import { pcbPads, isNpth } from "../src/model/instances"
import { onBoard } from "../src/model/partFlags"
import { serializeProject } from "../src/model/projectFile"
import { boardPreviewSvg, previewFills } from "../src/pages/boardPreviewSvg"
import { boardPreview, drawHere, forgetPreview } from "../src/pages/previews"
import { examplePreview, previewProject } from "../src/store/projectActions"
import type { ProjectStorage, StoredProjectSummary } from "../src/store/storage"

// A projects page's previews: drawn as SVG text, off the page's thread where there is a worker, once per project change.

const tagCount = (svg: string, tag: string) => svg.split(`<${tag} `).length - 1

describe("boardPreviewSvg", () => {
  it("draws every example as one SVG file with its pads, traces and vias", () => {
    for (const e of EXAMPLES) {
      const p = e.project
      const svg = boardPreviewSvg(p, previewFills(p, computeConnectivity(p)))
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
      expect(svg.endsWith("</svg>")).toBe(true)
      expect(svg).not.toMatch(/NaN|undefined/)
      const plated = resolvedComponents(p)
        .filter((c) => c.pcb.placed && onBoard(c))
        .flatMap((c) => pcbPads(c).filter((pad) => pad.layers.includes("top") && !isNpth(pad)))
      // Each plated top pad is one element; vias are a copper ring and a hole each; circles also draw mounting holes and drills.
      expect(tagCount(svg, "rect") + tagCount(svg, "circle") + tagCount(svg, "polygon") + tagCount(svg, "path")).toBeGreaterThanOrEqual(plated.length + p.vias.length * 2)
      expect(tagCount(svg, "polyline")).toBeGreaterThanOrEqual(p.traces.filter((t) => t.layer === "top").length)
    }
  })

  it("draws the same file from the project or from its stored text, as the worker does", () => {
    const p = EXAMPLES[0].project
    expect(drawHere("x", serializeProject(p))).toBe(boardPreviewSvg(p, previewFills(p, computeConnectivity(p))))
  })

  it("never writes a colour from the file into the markup unless it is a plain hex colour", () => {
    const p = EXAMPLES[0].project
    const svg = boardPreviewSvg({ ...p, board: { ...p.board, maskColor: '"/><script>', silkColor: "red" } } as typeof p, [])
    expect(svg).not.toContain("<script>")
  })
})

describe("boardPreview", () => {
  it("reads a project's file once while it is unchanged, and again once it changes", async () => {
    const file = vi.fn(() => serializeProject(EXAMPLES[0].project))
    const a = boardPreview({ key: "k1", updatedAt: 1, file })
    expect(boardPreview({ key: "k1", updatedAt: 1, file })).toBe(a)
    expect(await a).toMatch(/^<svg/)
    expect(file).toHaveBeenCalledTimes(1)
    await boardPreview({ key: "k1", updatedAt: 2, file })
    expect(file).toHaveBeenCalledTimes(2)
    forgetPreview("k1")
    await boardPreview({ key: "k1", updatedAt: 2, file })
    expect(file).toHaveBeenCalledTimes(3)
  })

  it("gives null for a file it can't read, so the page draws a placeholder", async () => {
    expect(await boardPreview({ key: "bad", file: () => "{not json" })).toBeNull()
    expect(await boardPreview({ key: "gone", file: () => null })).toBeNull()
  })

  it("downloads at most two stored projects at once", async () => {
    let running = 0
    let most = 0
    const release: (() => void)[] = []
    const load = vi.fn(async (id: string) => {
      running++
      most = Math.max(most, running)
      await new Promise<void>((go) => release.push(go))
      running--
      return { id, content: serializeProject(EXAMPLES[0].project), revision: 1, createdAt: 0, updatedAt: 5 }
    })
    const storage = { load } as unknown as ProjectStorage
    const metas = ["a", "b", "c", "d"].map((id) => ({ id, updatedAt: 5, name: id }) as StoredProjectSummary)
    const all = Promise.all(metas.map((m) => previewProject(storage, m)))
    for (let i = 0; i < 20 && load.mock.calls.length < 4; i++) {
      await new Promise((r) => setTimeout(r, 0))
      release.shift()?.()
    }
    while (release.length) release.shift()?.()
    const svgs = await all
    expect(most).toBeLessThanOrEqual(2)
    expect(load).toHaveBeenCalledTimes(4)
    expect(svgs.every((s) => s?.startsWith("<svg"))).toBe(true)
  })

  it("draws an example once a visit", async () => {
    const e = EXAMPLES[1]
    const first = examplePreview(e)
    expect(examplePreview(e)).toBe(first)
    expect(await first).toMatch(/^<svg/)
  })
})
