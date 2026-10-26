import JSZip from "jszip"
import { describe, expect, it } from "vitest"
import { expand, ImportInputError, kindOf, MAX_FILE_BYTES, pick, readEntry, type EntryLike, type InputFile } from "../src/kicadImport/pick"
import { input, zipInput } from "./kicad-import-helpers"

// Which files are the project: what a user gives (a file, several, a folder, a zip) and what the
// import makes of it, before anything is read as a board.

const picked = async (files: InputFile[], choice?: string) => pick(await expand(files), choice)
const ready = async (files: InputFile[], choice?: string) => {
  const r = await picked(files, choice)
  if (r.kind !== "ready") throw new Error(`expected ready, got ${r.kind}`)
  return r
}
const paths = (fs: InputFile[]) => fs.map((f) => f.path).sort()

describe("what a file is", () => {
  it("knows KiCad 5 and legacy names, whatever the case", () => {
    expect(kindOf("a/B.KiCad_PCB")).toBe("board")
    expect(kindOf("old.brd")).toBe("legacy-board")
    expect(kindOf("x.sch")).toBe("legacy-schematic")
    expect(kindOf("x.kicad_sch")).toBe("schematic")
    expect(kindOf("x.pro")).toBe("legacy-project")
    expect(kindOf("x.kicad_pro")).toBe("project")
    expect(kindOf("x.kicad_dru")).toBe("rules")
    expect(kindOf("x-cache.lib")).toBe("library")
    expect(kindOf("libs/Device.kicad_sym")).toBe("library")
    // The table that names a project's symbol libraries (S12) has no extension.
    expect(kindOf("proj/sym-lib-table")).toBe("library")
    expect(kindOf("proj/Sym-Lib-Table")).toBe("library")
    expect(kindOf("proj/fp-lib-table")).toBe("other")
    expect(kindOf("README")).toBe("other")
    expect(kindOf("photo.png")).toBe("other")
  })
})

describe("one file", () => {
  it("a single board is the project", async () => {
    const r = await ready([input("my board.kicad_pcb")])
    expect(r.files.board?.path).toBe("my board.kicad_pcb")
    expect(r.files.projectFile).toBeNull()
    expect(r.files.schematics).toEqual([])
  })

  it("a lone schematic is a project of its own, with no board", async () => {
    const r = await ready([input("a.kicad_sch")])
    expect(r.files.board).toBeNull()
    expect(paths(r.files.schematics)).toEqual(["a.kicad_sch"])
  })

  it("KiCad 5's schematic alone says it is not read, and what to do", async () => {
    const r = await picked([input("a.sch"), input("a.pro")])
    expect(r.kind).toBe("none")
    if (r.kind === "none") expect(r.why).toMatch(/KiCad 5.+\.sch.+KiCad 6/)
  })

  it("a file that is not KiCad's says there is no board", async () => {
    const r = await picked([input("photo.png")])
    expect(r.kind).toBe("none")
    if (r.kind === "none") expect(r.why).toMatch(/no KiCad board/)
  })
})

describe("several files at once", () => {
  it("takes the board and the files beside it, and names the rest as set aside", async () => {
    const r = await ready([input("p.kicad_pcb"), input("p.kicad_pro"), input("p.kicad_sch"), input("p.kicad_dru"), input("notes.txt")])
    expect(r.files.board?.path).toBe("p.kicad_pcb")
    expect(r.files.projectFile?.path).toBe("p.kicad_pro")
    expect(paths(r.files.schematics)).toEqual(["p.kicad_sch"])
    expect(r.files.rules?.path).toBe("p.kicad_dru")
    expect(r.ignored).toEqual([{ path: "notes.txt", why: "not a KiCad design file" }])
  })

  it("two boards ask the user to choose, and a choice picks one", async () => {
    const files = [input("a.kicad_pcb"), input("b.kicad_pcb")]
    const first = await picked(files)
    expect(first.kind).toBe("choose")
    if (first.kind === "choose") expect(first.boards.map((b) => b.id)).toEqual(["a.kicad_pcb", "b.kicad_pcb"])
    const second = await ready(files, "b.kicad_pcb")
    expect(second.files.board?.path).toBe("b.kicad_pcb")
    expect(second.ignored.map((i) => i.why)).toEqual(["another board, not the one chosen"])
  })

  it("a choice that names no board asks again", async () => {
    expect((await picked([input("a.kicad_pcb"), input("b.kicad_pcb")], "c.kicad_pcb")).kind).toBe("choose")
  })
})

describe("a zip with one project", () => {
  it("opens it and finds the board, project, schematics and rules", async () => {
    const zip = await zipInput("proj.zip", { "proj/proj.kicad_pcb": "b", "proj/proj.kicad_pro": "p", "proj/proj.kicad_sch": "s", "proj/sub/sheet2.kicad_sch": "s2", "proj/proj.kicad_dru": "d", "proj/fabrication/out.gbr": "g" })
    const r = await ready([zip])
    // A zip's files are named with the zip's own path in front.
    expect(r.files.board?.path).toBe("proj/proj/proj.kicad_pcb")
    expect(r.files.projectFile?.path).toBe("proj/proj/proj.kicad_pro")
    expect(paths(r.files.schematics)).toEqual(["proj/proj/proj.kicad_sch", "proj/proj/sub/sheet2.kicad_sch"])
    expect(r.files.rules?.path).toBe("proj/proj/proj.kicad_dru")
    expect(new TextDecoder().decode(await r.files.board!.read())).toBe("b")
    expect(r.ignored.map((i) => i.path)).toEqual(["proj/proj/fabrication/out.gbr"])
  })

  it("leaves out the computer's own files and KiCad's backups and autosaves", async () => {
    const zip = await zipInput("p.zip", { "p.kicad_pcb": "b", "__MACOSX/._p.kicad_pcb": "x", ".DS_Store": "x", "p-backups/p-2024.kicad_pcb": "old", "_autosave-p.kicad_pcb": "auto", "p.kicad_pcb-bak": "bak" })
    const r = await ready([zip])
    expect(r.files.board?.path).toBe("p/p.kicad_pcb")
    expect(r.ignored.length).toBe(5)
  })
})

describe("schematics with no board", () => {
  it("take the sheets below the first one, its project file and rules, and set the rest aside", async () => {
    const r = await ready([input("p/p.kicad_sch"), input("p/sheets/power.kicad_sch"), input("p/p.kicad_pro"), input("p/p.kicad_dru"), input("p/notes.txt"), input("other/other.kicad_pro")])
    expect(r.files.board).toBeNull()
    expect(paths(r.files.schematics)).toEqual(["p/p.kicad_sch", "p/sheets/power.kicad_sch"])
    expect(r.files.projectFile?.path).toBe("p/p.kicad_pro")
    expect(r.files.rules?.path).toBe("p/p.kicad_dru")
    expect(r.ignored.map((i) => i.path).sort()).toEqual(["other/other.kicad_pro", "p/notes.txt"])
  })

  it("two folders each with a schematic ask which, and a choice picks one", async () => {
    const files = [input("a/a.kicad_sch"), input("a/a.kicad_pro"), input("b/b.kicad_sch")]
    const first = await picked(files)
    expect(first.kind).toBe("choose")
    if (first.kind === "choose") expect(first.boards).toEqual([expect.objectContaining({ id: "a/a.kicad_sch", schematic: true }), expect.objectContaining({ id: "b/b.kicad_sch", schematic: true })])
    const second = await ready(files, "b/b.kicad_sch")
    expect(paths(second.files.schematics)).toEqual(["b/b.kicad_sch"])
    expect(second.ignored.map((i) => i.why)).toContain("outside the chosen schematic's folder")
  })

  it("a board beside the schematics wins: it is the project's board", async () => {
    const r = await ready([input("p.kicad_sch"), input("p.kicad_pcb")])
    expect(r.files.board?.path).toBe("p.kicad_pcb")
  })
})

describe("a zip with two boards", () => {
  const files = { "one/one.kicad_pcb": "1", "one/one.kicad_pro": "1p", "one/one.kicad_sch": "1s", "two/two.kicad_pcb": "2", "two/two.kicad_pro": "2p", "two/two.kicad_sch": "2s" }

  it("asks which, with each board's size", async () => {
    const r = await picked([await zipInput("both.zip", files)])
    expect(r.kind).toBe("choose")
    if (r.kind === "choose") expect(r.boards.map((b) => [b.path, b.size, b.legacy])).toEqual([["both/one/one.kicad_pcb", 1, false], ["both/two/two.kicad_pcb", 1, false]])
  })

  it("after the choice takes only that board's folder, not the other project's files", async () => {
    const r = await ready([await zipInput("both.zip", files)], "both/two/two.kicad_pcb")
    expect(r.files.projectFile?.path).toBe("both/two/two.kicad_pro")
    expect(paths(r.files.schematics)).toEqual(["both/two/two.kicad_sch"])
    expect(r.ignored.map((i) => i.path).sort()).toEqual(["both/one/one.kicad_pcb", "both/one/one.kicad_pro", "both/one/one.kicad_sch"])
  })

  it("two zips with a board of the same name stay two boards", async () => {
    const r = await picked([await zipInput("a.zip", { "board.kicad_pcb": "1" }), await zipInput("b.zip", { "board.kicad_pcb": "2" })])
    expect(r.kind).toBe("choose")
    if (r.kind === "choose") expect(r.boards.map((b) => b.id)).toEqual(["a/board.kicad_pcb", "b/board.kicad_pcb"])
  })
})

describe("nested folders", () => {
  it("a board in a subfolder is found, with its project beside it and its sheets below it", async () => {
    const r = await ready([input("Top/hw/rev2/m.kicad_pcb"), input("Top/hw/rev2/m.kicad_pro"), input("Top/hw/rev2/sheets/pwr.kicad_sch"), input("Top/hw/rev1/old.kicad_pro"), input("Top/docs/readme.md")])
    expect(r.files.projectFile?.path).toBe("Top/hw/rev2/m.kicad_pro")
    expect(paths(r.files.schematics)).toEqual(["Top/hw/rev2/sheets/pwr.kicad_sch"])
    expect(r.ignored.map((i) => i.path).sort()).toEqual(["Top/docs/readme.md", "Top/hw/rev1/old.kicad_pro"])
  })

  it("a project file of another name is used when it is the only one beside the board", async () => {
    const r = await ready([input("d/board.kicad_pcb"), input("d/other.kicad_pro")])
    expect(r.files.projectFile?.path).toBe("d/other.kicad_pro")
  })

  it("with several project files the one that shares the board's name wins", async () => {
    const r = await ready([input("d/m.kicad_pcb"), input("d/a.kicad_pro"), input("d/M.kicad_pro")])
    expect(r.files.projectFile?.path).toBe("d/M.kicad_pro")
  })

  it("folder separators from Windows are read as folders", async () => {
    const r = await ready([input("Top\\m.kicad_pcb"), input("Top\\m.kicad_pro")])
    expect(r.files.board?.path).toBe("Top/m.kicad_pcb")
    expect(r.files.projectFile?.path).toBe("Top/m.kicad_pro")
  })
})

describe("a zip with no board", () => {
  it("with only a schematic and its project file is a schematic-only project, in the zip's folder", async () => {
    const r = await ready([await zipInput("p.zip", { "p.kicad_sch": "s", "p.kicad_pro": "p" })])
    expect(r.files.board).toBeNull()
    expect(paths(r.files.schematics)).toEqual(["p/p.kicad_sch"])
    expect(r.files.projectFile?.path).toBe("p/p.kicad_pro")
  })

  it("with only a project file says there is nothing to import, and what to add", async () => {
    const r = await picked([await zipInput("p.zip", { "p.kicad_pro": "p" })])
    expect(r.kind).toBe("none")
    if (r.kind === "none") expect(r.why).toMatch(/\.kicad_pcb or \.kicad_sch/)
  })

  it("with nothing of KiCad's says so and lists what it set aside", async () => {
    const r = await picked([await zipInput("p.zip", { "a.png": "x", "b.pdf": "y" })])
    expect(r.kind).toBe("none")
    if (r.kind === "none") {
      expect(r.why).toMatch(/no KiCad board/)
      expect(r.ignored.map((i) => i.path).sort()).toEqual(["p/a.png", "p/b.pdf"])
    }
  })

  it("an empty zip says there is no board", async () => {
    expect((await picked([await zipInput("empty.zip", {})])).kind).toBe("none")
  })
})

describe("legacy files", () => {
  it("a .brd is offered as the board, to be refused with its version message by the reader", async () => {
    const r = await ready([input("old.brd")])
    expect(r.files.board?.path).toBe("old.brd")
    expect(kindOf(r.files.board!.path)).toBe("legacy-board")
  })

  it("a legacy .brd beside a .kicad_pcb in the same folder is the older copy and is set aside", async () => {
    const r = await ready([input("p.kicad_pcb"), input("p.brd")])
    expect(r.files.board?.path).toBe("p.kicad_pcb")
    expect(r.ignored.map((i) => i.path)).toEqual(["p.brd"])
  })

  it("KiCad 5's .sch, .pro and .lib files are taken as the project's schematic, project and libraries", async () => {
    const r = await ready([input("k5.kicad_pcb"), input("k5.sch"), input("k5.pro"), input("k5-cache.lib"), input("parts.lib")])
    expect(r.files.projectFile?.path).toBe("k5.pro")
    expect(paths(r.files.schematics)).toEqual(["k5.sch"])
    expect(paths(r.files.libraries)).toEqual(["k5-cache.lib", "parts.lib"])
  })
})

describe("a project's symbol libraries (S12)", () => {
  it("takes the sym-lib-table and the .kicad_sym files with the project, from a folder or a zip's entries", async () => {
    const r = await ready([input("p/p.kicad_pcb"), input("p/p.kicad_sch"), input("p/sym-lib-table"), input("p/libs/Device.kicad_sym"), input("p/fp-lib-table")])
    expect(paths(r.files.libraries)).toEqual(["p/libs/Device.kicad_sym", "p/sym-lib-table"])
    expect(paths(r.ignored.map((i) => ({ path: i.path })) as InputFile[])).toContain("p/fp-lib-table")
  })
})

describe("a corrupt zip", () => {
  it("alone says it could not be opened, and names it", async () => {
    const bad: InputFile = { path: "broken.zip", size: 5, read: async () => new TextEncoder().encode("nope!") }
    const e = await expand([bad])
    expect(e.badZips.map((z) => z.path)).toEqual(["broken.zip"])
    const r = pick(e)
    expect(r.kind).toBe("none")
    if (r.kind === "none") expect(r.why).toMatch(/^broken\.zip could not be opened\. It is not a zip file, or it is damaged\.$/)
  })

  it("a truncated real zip is a corrupt zip, not a crash", async () => {
    const zip = new JSZip()
    zip.file("p.kicad_pcb", "x".repeat(5000))
    const whole = await zip.generateAsync({ type: "uint8array" })
    const cut = whole.slice(0, Math.floor(whole.length / 2))
    const r = await picked([{ path: "cut.zip", size: cut.length, read: async () => cut }])
    expect(r.kind).toBe("none")
  })

  it("beside a good board it is set aside with its reason and the board still imports", async () => {
    const bad: InputFile = { path: "broken.zip", size: 5, read: async () => new TextEncoder().encode("nope!") }
    const r = await ready([input("p.kicad_pcb"), bad])
    expect(r.ignored.some((i) => i.path === "broken.zip" && /could not be opened/.test(i.why))).toBe(true)
  })

  it("a zip too large to read is refused by name, without reading it", async () => {
    let read = false
    const huge: InputFile = { path: "huge.zip", size: MAX_FILE_BYTES + 1, read: async () => ((read = true), new Uint8Array()) }
    const e = await expand([huge])
    expect(read).toBe(false)
    expect(e.badZips[0].why).toMatch(/larger than/)
  })

  it("a zip inside a zip is not opened", async () => {
    const inner = new JSZip()
    inner.file("deep.kicad_pcb", "x")
    const outer = await zipInput("outer.zip", { "p.kicad_pcb": "b" })
    const zip = await JSZip.loadAsync(await outer.read())
    zip.file("inner.zip", await inner.generateAsync({ type: "uint8array" }))
    const bytes = await zip.generateAsync({ type: "uint8array" })
    const r = await ready([{ path: "outer.zip", size: bytes.length, read: async () => bytes }])
    expect(r.files.board?.path).toBe("outer/p.kicad_pcb")
    expect(r.ignored.some((i) => /zip inside a zip/.test(i.why))).toBe(true)
  })
})

describe("KiCad's own backups", () => {
  // KiCad 6 and later keep up to 25 zips of the board in `<name>-backups/`, one per save.
  const layout = async () => [
    input("proj/proj.kicad_pcb", "board"),
    input("proj/proj.kicad_pro", "{}"),
    await zipInput("proj/proj-backups/proj-2026-10-01_101500.zip", { "proj.kicad_pcb": "old", "proj.kicad_pro": "{}" }),
    await zipInput("proj/proj-backups/proj-2026-10-02_093000.zip", { "proj.kicad_pcb": "older" }),
  ]

  it("a dropped project folder with its backups is one board, and the backup zips are never opened", async () => {
    const files = await layout()
    let opened = 0
    for (const f of files.slice(2)) {
      const read = f.read
      f.read = async () => (opened++, read())
    }
    const e = await expand(files)
    expect(opened).toBe(0)
    const r = pick(e)
    expect(r.kind).toBe("ready")
    if (r.kind !== "ready") return
    expect(r.files.board?.path).toBe("proj/proj.kicad_pcb")
    expect(r.files.projectFile?.path).toBe("proj/proj.kicad_pro")
    expect(r.ignored.map((i) => [i.path, i.why])).toEqual([
      ["proj/proj-backups/proj-2026-10-01_101500.zip", "a KiCad backup copy"],
      ["proj/proj-backups/proj-2026-10-02_093000.zip", "a KiCad backup copy"],
    ])
  })

  it("two zips of one name in different folders stay two boards", async () => {
    const r = await picked([await zipInput("a/board.zip", { "b.kicad_pcb": "1" }), await zipInput("b/board.zip", { "b.kicad_pcb": "2" })])
    expect(r.kind).toBe("choose")
    if (r.kind === "choose") expect(r.boards.map((b) => b.id)).toEqual(["a/board/b.kicad_pcb", "b/board/b.kicad_pcb"])
  })
})

describe("size limits", () => {
  it("a board is read up to 64 MB, a quarter of what a memory-hungry import can hold", () => {
    expect(MAX_FILE_BYTES).toBe(64 * 1024 * 1024)
  })

  it("a zip entry that claims more than the limit is refused without being unpacked", async () => {
    const zip = await zipInput("p.zip", { "p.kicad_pcb": "x".repeat(5000) })
    const e = await expand([zip], 1000)
    await expect(e.files[0].read()).rejects.toThrow(/larger than/)
  })

  it("counts the bytes as they come out and stops at the limit, not after", async () => {
    let pulled = 0
    const entry = (chunks: number): EntryLike => ({
      internalStream: () => {
        const handlers: Record<string, (x?: never) => void> = {}
        let paused = false
        const stream = {
          on(event: string, cb: (x?: never) => void) {
            handlers[event] = cb
            return stream
          },
          pause() {
            paused = true
          },
          resume() {
            void (async () => {
              for (let i = 0; i < chunks && !paused; i++) {
                pulled++
                handlers.data?.(new Uint8Array(400) as never)
                await Promise.resolve()
              }
              if (!paused) handlers.end?.()
            })()
          },
        }
        return stream as never
      },
    })
    await expect(readEntry(entry(100), "big.kicad_pcb", 1000)).rejects.toBeInstanceOf(ImportInputError)
    await expect(readEntry(entry(100), "big.kicad_pcb", 1000)).rejects.toThrow(/^big\.kicad_pcb is larger than 0 MB once unpacked/)
    expect(pulled).toBe(6)
    expect((await readEntry(entry(2), "ok", 1000)).length).toBe(800)
  })

  it("a zip entry with no size field has no size, not a size of 0", async () => {
    const zip = await zipInput("p.zip", { "a.kicad_pcb": "1", "b.kicad_pcb": "2" })
    const e = await expand([zip])
    for (const f of e.files) (f as { size: number | null }).size = null
    const r = pick(e)
    expect(r.kind).toBe("choose")
    if (r.kind === "choose") expect(r.boards.every((b) => b.size === null)).toBe(true)
  })
})
