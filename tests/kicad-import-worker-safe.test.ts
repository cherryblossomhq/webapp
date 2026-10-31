import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, relative, resolve, sep } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * The KiCad import runs in a Web Worker (`src/kicadImport/worker.ts`), which has no `window`. The stores are the page's: importing one
 * there failed every import with "window is not defined" once the kept-files zip was packed through `export/keep/original.ts`, which
 * reaches the project store. Node has no `window` either and the engine's tests passed, so this walks the worker's import graph
 * (static and dynamic) as the bundler does and holds it to no store, no React and no `.tsx`.
 */

const root = resolve(__dirname, "..")
const rel = (file: string) => relative(root, file).split(sep).join("/")
const EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]
const PAGE_ONLY = /^(react|react-dom|react\/.*|react-dom\/.*|three|three\/.*|lucide-react)$/

function importGraph(entry: string) {
  const files = new Set<string>()
  const pageOnly: string[] = []
  const walk = (file: string) => {
    if (files.has(file)) return
    files.add(file)
    const src = readFileSync(file, "utf8")
    const specs = [
      ...[...src.matchAll(/^\s*(?:import|export)\s+(type\s+)?(?:[^"';]*?from\s+)?["']([^"']+)["']/gm)].filter((m) => !m[1]).map((m) => m[2]),
      ...[...src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]),
    ]
    for (const spec of specs) {
      if (spec.startsWith(".")) {
        const base = resolve(dirname(file), spec)
        const hit = EXTENSIONS.map((e) => base + e).find((p) => existsSync(p) && statSync(p).isFile())
        if (hit && /\.tsx?$/.test(hit)) walk(hit)
      } else if (PAGE_ONLY.test(spec)) {
        pageOnly.push(`${rel(file)} imports ${spec}`)
      }
    }
  }
  walk(resolve(root, entry))
  return { files: [...files].map(rel), pageOnly }
}

describe("the KiCad import's worker", () => {
  it("imports nothing that needs a page", () => {
    const { files, pageOnly } = importGraph("src/kicadImport/worker.ts")
    expect(files).toContain("src/export/keep/pack.ts")
    expect(files.filter((f) => f.startsWith("src/store/"))).toEqual([])
    expect(pageOnly).toEqual([])
    expect(files.filter((f) => f.endsWith(".tsx"))).toEqual([])
  })
})
