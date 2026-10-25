import { describe, expect, it } from "vitest"
import { boardTextStrokes } from "../src/model/board"
import { defaultTextStyle, hitText, marqueeTexts, movableTexts, textIds, textShownOnScreen, visibleTexts } from "../src/editor/pcb/textEditing"
import { registerProjectParts } from "../src/model/customParts"
import { EXAMPLES } from "../src/model/examples"
import { isPhysical } from "../src/model/instances"
import { findPart } from "../src/model/library"
import { updateComponent } from "../src/model/ops"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { placeDesignators } from "../src/model/silk"
import { addBoardText, addPartText, landAngle, landPoint, moveBoardTexts, movePartTexts, patchTexts, removeBoardTexts, removePartText, resetPartTexts, updateBoardTexts, updatePartText, withDesignatorText } from "../src/model/textOps"
import { boardTextId, componentTexts, drawRotation, expandTextVars, hasExpression, parseTextId, partTextId, partTextWorld, shownOf, textInk, textShown, textVariables, worldTexts } from "../src/model/texts"
import type { ComponentInstance, PartText, Project, Rotation } from "../src/model/types"
import { textFacts, textLayerGroups, textRowText } from "../src/panels/textInspector"

const blinker = () => {
  const p = structuredClone(EXAMPLES.find((e) => e.id === "blinker")!.project) as Project
  registerProjectParts(p)
  return p
}
const part = (p: Project) => p.components.find((c) => isPhysical(findPart(c.partId)) && c.pcb.placed)!
const round = (n: number) => Math.round(n * 1e6) / 1e6
const vis = { hidden: {}, layers: { top: true, bottom: true, silk: true } }

describe("where a part's text is on the board", () => {
  const land: PartText = { kind: "user", text: "X", layer: "F.SilkS", x: 3, y: 0, size: 1, rot: 0 }
  const at = (rot: Rotation, side: "top" | "bottom", over: Partial<PartText> = {}) => {
    const c = { id: "c", partId: "p", ref: "U1", props: {}, footprint: "f", sch: { x: 0, y: 0, rot: 0 }, pcb: { x: 10, y: 5, rot, side, placed: true }, texts: [{ ...land, ...over }] } as ComponentInstance
    const w = partTextWorld(c, c.texts![0], 0)
    return { x: round(w.x), y: round(w.y), rot: w.rot, layer: w.layer, mirror: w.mirror }
  }
  it("moves and turns with the part on the top", () => {
    expect(at(0, "top")).toEqual({ x: 13, y: 5, rot: 0, layer: "F.SilkS", mirror: false })
    expect(at(90, "top")).toEqual({ x: 10, y: 8, rot: 90, layer: "F.SilkS", mirror: false })
    expect(at(180, "top")).toEqual({ x: 7, y: 5, rot: 180, layer: "F.SilkS", mirror: false })
    expect(at(270, "top")).toEqual({ x: 10, y: 2, rot: 270, layer: "F.SilkS", mirror: false })
  })
  it("is mirrored first on the bottom: its place, its layer's side, its mirror flag, and its angle as the part's less its own", () => {
    expect(at(0, "bottom")).toEqual({ x: 7, y: 5, rot: 0, layer: "B.SilkS", mirror: true })
    expect(at(180, "bottom")).toEqual({ x: 13, y: 5, rot: 180, layer: "B.SilkS", mirror: true })
    expect(at(0, "bottom", { rot: 30 })).toMatchObject({ rot: 330, mirror: true })
    expect(at(90, "bottom", { rot: 30 })).toMatchObject({ rot: 60 })
    // a user layer stays where it is, and a text already mirrored in its land is not on the bottom
    expect(at(0, "bottom", { layer: "Dwgs.User", mirror: true })).toMatchObject({ layer: "Dwgs.User", mirror: false })
  })
  it("landPoint and landAngle undo it", () => {
    for (const rot of [0, 90, 180, 270] as Rotation[]) {
      for (const side of ["top", "bottom"] as const) {
        const c = { id: "c", partId: "p", ref: "U1", props: {}, footprint: "f", sch: { x: 0, y: 0, rot: 0 }, pcb: { x: 10, y: 5, rot, side, placed: true }, texts: [{ ...land, x: 3.25, y: -1.5, rot: 20 }] } as ComponentInstance
        const w = partTextWorld(c, c.texts![0], 0)
        expect(landPoint(c, { x: w.x, y: w.y })).toEqual({ x: 3.25, y: -1.5 })
        expect(landAngle(c, w.rot)).toBeCloseTo(20, 9)
      }
    }
  })
  it("a keep-upright text is drawn upright, a text with 'unlocked' is not, and a text box never is", () => {
    const c = (t: Partial<PartText>) => ({ id: "c", partId: "p", ref: "U1", props: {}, footprint: "f", sch: { x: 0, y: 0, rot: 0 }, pcb: { x: 0, y: 0, rot: 180 as Rotation, side: "top" as const, placed: true }, texts: [{ ...land, ...t }] }) as ComponentInstance
    expect(partTextWorld(c({}), c({}).texts![0], 0).drawRot).toBe(0)
    expect(partTextWorld(c({ upright: false }), c({ upright: false }).texts![0], 0).drawRot).toBe(180)
    const box = { w: 3, h: 1, margins: [0, 0, 0, 0] as [number, number, number, number] }
    expect(partTextWorld(c({ box }), c({ box }).texts![0], 0).drawRot).toBe(180)
  })
  it("ids say what a text is", () => {
    expect(parseTextId(boardTextId("kt3"))).toEqual({ kind: "board", text: "kt3" })
    expect(parseTextId(partTextId("c:1", 4))).toEqual({ kind: "part", component: "c:1", index: 4 })
    expect(parseTextId("c:5")).toBeNull()
    expect(parseTextId("g:2")).toBeNull()
  })
  it("the draw rotation keeps a text that keeps upright in ]-90, 90]", () => {
    expect(drawRotation(270, true)).toBe(90)
    expect(drawRotation(271, true)).toBe(91 - 180)
  })
})

describe("variables", () => {
  const resolve = (map: Record<string, string>) => (token: string) => map[token] ?? null
  it("expands nested names inside out, leaves what it cannot as written, drops an empty one, and unescapes", () => {
    expect(expandTextVars("a ${X} b", resolve({ X: "1" }))).toBe("a 1 b")
    expect(expandTextVars("${${A}}", resolve({ A: "B", B: "ok" }))).toBe("ok")
    expect(expandTextVars("${NOPE} x", resolve({}))).toBe("${NOPE} x")
    expect(expandTextVars("x${}y", resolve({}))).toBe("xy")
    expect(expandTextVars("\\${X}", resolve({ X: "1" }))).toBe("${X}")
    expect(expandTextVars("no variable", resolve({}))).toBe("no variable")
  })
  it("a text whose variable refers to itself ends", () => {
    expect(textShown({ properties: [{ key: "A", value: "${A}" }], name: "n", components: [] } as unknown as Project, null, "${A}").length).toBeLessThan(1000)
  })
  it("lists the names in a text, and finds an expression", () => {
    expect(textVariables("${A} and ${B(${C})} and \\${D}")).toEqual(["A", "B(${C})", "C"])
    expect(hasExpression("@{1+${X}}")).toBe(true)
    expect(hasExpression("\\@{x}")).toBe(false)
    expect(hasExpression("plain")).toBe(false)
  })
  it("a part's text shows the part's reference and value", () => {
    let p = blinker()
    const c = part(p)
    p = addPartText(p, c.id, { text: "${REFERENCE} ${VALUE}", at: { x: 0, y: 0 } }).project
    const w = componentTexts(p.components.find((x) => x.id === c.id)!).find((t) => t.kind === "user")!
    expect(shownOf(p, w)).toMatch(new RegExp(`^${c.ref} `))
  })
})

describe("editing board text", () => {
  it("adds a text with its own id on its layer's side, changes it, moves it, and removes it", () => {
    const p0 = blinker()
    const { project: p1, text } = addBoardText(p0, { layer: "B.SilkS", text: "hi", x: 1, y: 2, rot: 0, size: 1, mirror: true })
    expect(text).toMatchObject({ id: "kt1", side: "bottom", layer: "B.SilkS" })
    const p2 = updateBoardTexts(p1, [text.id], { text: "ho", size: 2, w: 1.5, thickness: 0.2, bold: true, hj: "left", vj: "top", spacing: 1.2, rot: 450, x: 3, y: 4, layer: "F.SilkS", knockout: true })
    expect(p2.texts.at(-1)).toMatchObject({ text: "ho", size: 2, w: 1.5, thickness: 0.2, bold: true, hj: "left", vj: "top", spacing: 1.2, rot: 90, x: 3, y: 4, layer: "F.SilkS", side: "top", knockout: true })
    // an attribute that is back to its default is gone, not stored as the default
    const p3 = updateBoardTexts(p2, [text.id], { w: null, bold: false, hj: null, vj: null, spacing: 1, knockout: false, thickness: null })
    expect(p3.texts.at(-1)).not.toHaveProperty("w")
    expect(p3.texts.at(-1)).not.toHaveProperty("bold")
    expect(p3.texts.at(-1)).not.toHaveProperty("hj")
    expect(p3.texts.at(-1)).not.toHaveProperty("spacing")
    expect(p3.texts.at(-1)).not.toHaveProperty("thickness")
    const p4 = moveBoardTexts(p3, [text.id], 1.5, -1)
    expect(p4.texts.at(-1)).toMatchObject({ x: 4.5, y: 3 })
    expect(removeBoardTexts(p4, [text.id]).texts).toEqual(p0.texts)
    // the editor's own text is not touched by any of it
    expect(updateBoardTexts(p4, p0.texts.map((t) => t.id), { text: "no" }).texts.slice(0, p0.texts.length)).toEqual(p0.texts)
  })
  it("a locked text stays where it is; an invalid change is refused", () => {
    const { project, text } = addBoardText(blinker(), { layer: "F.SilkS", text: "x", x: 0, y: 0, rot: 0, size: 1, locked: true })
    expect(moveBoardTexts(project, [text.id], 3, 3)).toBe(project)
    expect(updateBoardTexts(project, [text.id], { layer: "Nowhere", size: -2, w: 0 }).texts.at(-1)).toMatchObject({ layer: "F.SilkS", size: 1 })
  })
  it("ids stay unique when one was removed", () => {
    let p = blinker()
    const a = addBoardText(p, { layer: "F.SilkS", text: "a", x: 0, y: 0, rot: 0, size: 1 })
    const b = addBoardText(a.project, { layer: "F.SilkS", text: "b", x: 0, y: 0, rot: 0, size: 1 })
    p = removeBoardTexts(b.project, [a.text.id])
    const c = addBoardText(p, { layer: "F.SilkS", text: "c", x: 0, y: 0, rot: 0, size: 1 })
    const ids = c.project.texts.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe("editing a part's text", () => {
  /** A part turned 90 degrees on the bottom, with a text of its own. */
  function flipped() {
    let p = blinker()
    const c0 = part(p)
    p = updateComponent(p, c0.id, { pcb: { side: "bottom", rot: 90, x: 12, y: -3 } })
    const res = addPartText(p, c0.id, { text: "NOTE", at: { x: 15, y: -1 } })
    return { p: res.project, id: c0.id, index: res.index }
  }
  const world = (p: Project, id: string, index: number) => {
    const c = p.components.find((x) => x.id === id)!
    return partTextWorld(c, c.texts![index], index)
  }
  it("a text added at a place on the board is there, whatever the part's turn and side", () => {
    const { p, id, index } = flipped()
    const w = world(p, id, index)
    expect([round(w.x), round(w.y)]).toEqual([15, -1])
    // new text on the bottom is mirrored to read from below, on the part's own side
    expect(w.layer).toBe("B.SilkS")
    expect(w.mirror).toBe(true)
    expect(w.rot).toBe(0)
  })
  it("a place, an angle, a layer or a mirror given on the board are held in the land and come back as given", () => {
    const { p, id, index } = flipped()
    const q = updatePartText(p, id, index, { x: 17, y: 2, rot: 135, layer: "B.Fab", mirror: false })
    const w = world(q, id, index)
    expect([round(w.x), round(w.y), w.rot, w.layer, w.mirror]).toEqual([17, 2, 135, "B.Fab", false])
    // in the land, the layer is the part's own side's
    expect(q.components.find((c) => c.id === id)!.texts![index].layer).toBe("F.Fab")
  })
  it("a displacement on the board moves the text by the same in the land turned back; a locked text stays", () => {
    const { p, id, index } = flipped()
    const moved = movePartTexts(p, [{ component: id, index }], 2, 1)
    const a = world(p, id, index)
    const b = world(moved, id, index)
    expect([round(b.x - a.x), round(b.y - a.y)]).toEqual([2, 1])
    const locked = updatePartText(p, id, index, { locked: true })
    expect(movePartTexts(locked, [{ component: id, index }], 2, 1)).toBe(locked)
  })
  it("removes a part's own text and keeps its reference and value", () => {
    const { p, id, index } = flipped()
    expect(removePartText(p, id, index).components.find((c) => c.id === id)!.texts).toHaveLength(index)
    expect(removePartText(p, id, 0)).toBe(p)
  })
  it("placing the designator by hand makes its reference a text where the editor had put it, and resetting hands it back", () => {
    const p0 = blinker()
    const c = part(p0)
    const d = placeDesignators(p0).get(c.id)!
    const p1 = withDesignatorText(p0, c.id)
    const c1 = p1.components.find((x) => x.id === c.id)!
    expect(c1.texts).toHaveLength(1)
    const w = componentTexts(c1)[0]
    expect([round(w.x), round(w.y)]).toEqual([round(d.x), round(d.y)])
    expect(w.size).toBe(d.size)
    expect(w.rot % 180).toBe(d.rot)
    // no other designator is placed for it now
    expect(placeDesignators(p1).has(c.id)).toBe(false)
    expect(shownOf(p1, w)).toBe(c.ref)
    // asking again changes nothing
    expect(withDesignatorText(p1, c.id)).toBe(p1)
    const p2 = resetPartTexts(p1, c.id)
    expect(p2.components.find((x) => x.id === c.id)).not.toHaveProperty("texts")
    expect(placeDesignators(p2).get(c.id)).toEqual(d)
  })
  it("a reference text that shows something else follows the part when it is renamed", () => {
    let p = blinker()
    const c = part(p)
    p = withDesignatorText(p, c.id)
    p = { ...p, components: p.components.map((x) => (x.id === c.id ? { ...x, texts: [{ ...x.texts![0], text: "REF**" }] } : x)) }
    expect(shownOf(p, componentTexts(p.components.find((x) => x.id === c.id)!)[0])).toBe("REF**")
    p = updateComponent(p, c.id, { ref: "Z9" })
    expect(shownOf(p, componentTexts(p.components.find((x) => x.id === c.id)!)[0])).toBe("Z9")
    // another change leaves it
    const q = updateComponent(p, c.id, { pcb: { x: 1 } })
    expect(q.components.find((x) => x.id === c.id)!.texts).toEqual(p.components.find((x) => x.id === c.id)!.texts)
  })
  it("patchTexts edits board texts and part texts in one go", () => {
    const { p, id, index } = flipped()
    const b = addBoardText(p, { layer: "F.SilkS", text: "B", x: 0, y: 0, rot: 0, size: 1 })
    const all = worldTexts(b.project).filter((t) => t.kind === "board" || t.kind === "user")
    const q = patchTexts(b.project, all, { size: 3 })
    expect(worldTexts(q).filter((t) => t.kind === "board" || t.kind === "user").map((t) => t.size)).toEqual(all.map(() => 3))
    void id
    void index
  })
})

describe("the editor's own text and designators are what they were", () => {
  it("editor text is drawn by the editor's font, by its quarter turns, and a KiCad text next to it changes nothing about it", () => {
    const p = blinker()
    const own = p.texts[0]
    const strokes = boardTextStrokes(own)
    const q = addBoardText(p, { layer: "F.SilkS", text: "k", x: 0, y: 0, rot: 33, size: 1 }).project
    expect(boardTextStrokes(q.texts[0])).toEqual(strokes)
    expect(worldTexts(q)).toHaveLength(1)
  })
  it("no designator moves for a board with no part text", () => {
    for (const example of EXAMPLES) {
      const p = example.project
      registerProjectParts(p)
      const withEmpty = { ...p, components: p.components.map((c) => ({ ...c })) }
      expect([...placeDesignators(withEmpty).entries()], example.id).toEqual([...placeDesignators(p).entries()])
    }
  })
})

describe("the PCB view's rules for text", () => {
  const sample = () => {
    let p = blinker()
    p = addBoardText(p, { layer: "F.SilkS", text: "SILK", x: 0, y: 0, rot: 0, size: 2 }).project
    p = addBoardText(p, { layer: "B.Cu", text: "BCU", x: 10, y: 0, rot: 0, size: 2 }).project
    p = addBoardText(p, { layer: "F.Fab", text: "FAB", x: 20, y: 0, rot: 0, size: 2 }).project
    return p
  }
  it("shows a text when its layer is on, and the silkscreen and copper switches of its side are on", () => {
    const p = sample()
    const [silk, cu, fab] = worldTexts(p)
    expect([silk, cu, fab].map((t) => textShownOnScreen(t, vis))).toEqual([true, true, true])
    expect(textShownOnScreen(silk, { ...vis, layers: { ...vis.layers, silk: false } })).toBe(false)
    expect(textShownOnScreen(cu, { ...vis, layers: { ...vis.layers, bottom: false } })).toBe(false)
    expect(textShownOnScreen(cu, { ...vis, layers: { ...vis.layers, top: false } })).toBe(true)
    expect(textShownOnScreen(fab, { ...vis, hidden: { "F.Fab": true } })).toBe(false)
    expect(textShownOnScreen({ ...silk, hidden: true }, vis)).toBe(false)
    expect(textShownOnScreen({ ...silk, placed: false }, vis)).toBe(false)
    expect(visibleTexts(p, vis)).toHaveLength(3)
  })
  it("picks the topmost text under a point, within a tolerance, and none elsewhere", () => {
    const p = sample()
    const [silk] = worldTexts(p)
    const ink = textInk(p, silk)
    const mid = { x: (ink.box!.minX + ink.box!.maxX) / 2, y: (ink.box!.minY + ink.box!.maxY) / 2 }
    expect(hitText(p, mid, 0.1, vis)?.id).toBe(silk.id)
    expect(hitText(p, { x: mid.x, y: mid.y + 10 }, 0.1, vis)).toBeNull()
    expect(hitText(p, mid, 0.1, { ...vis, layers: { ...vis.layers, silk: false } })).toBeNull()
  })
  it("a part's body wins over its fab-layer text, as in KiCad: a click on the part's middle does not pick the text, and the silkscreen text and a text outside the body still are", () => {
    let p = blinker()
    const c = part(p)
    p = addPartText(p, c.id, { text: "${REFERENCE}", at: { x: c.pcb.x, y: c.pcb.y }, layer: "F.Fab" }).project
    const onlyFab = p
    p = addPartText(p, c.id, { text: "SILK", at: { x: c.pcb.x, y: c.pcb.y }, layer: "F.SilkS" }).project
    p = addPartText(p, c.id, { text: "FAR", at: { x: c.pcb.x + 60, y: c.pcb.y + 60 }, layer: "F.Fab" }).project
    const world = componentTexts(p.components.find((x) => x.id === c.id)!)
    const centre = (t: (typeof world)[number]) => {
      const b = textInk(p, t).box!
      return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }
    }
    const fabText = world.find((t) => t.layer === "F.Fab" && t.kind === "user" && t.content === "${REFERENCE}")!
    const silkText = world.find((t) => t.content === "SILK")!
    const farText = world.find((t) => t.content === "FAR")!
    // the fab text's middle is inside the part's courtyard: the body wins, so that text is not what is picked
    expect(hitText(p, centre(fabText), 0.1, vis)?.id).not.toBe(fabText.id)
    // a silkscreen text of the part is picked as before, and a fab text that is clear of every body too
    expect(hitText(p, centre(silkText), 0.1, vis)?.id).toBe(silkText.id)
    expect(hitText(p, centre(farText), 0.1, vis)?.id).toBe(farText.id)
    // a board text on the fab layer is the user's own and is always picked
    const withBoard = addBoardText(onlyFab, { layer: "F.Fab", text: "NOTE", x: c.pcb.x, y: c.pcb.y, rot: 0, size: 2 }).project
    const note = worldTexts(withBoard).find((t) => t.kind === "board" && t.content === "NOTE")!
    expect(hitText(withBoard, centre(note), 0.1, vis)?.id).toBe(note.id)
  })
  it("a marquee takes the texts it touches", () => {
    const p = sample()
    const ids = marqueeTexts(p, { minX: -50, minY: -50, maxX: 12, maxY: 50 }, vis)
    expect(ids.sort()).toEqual(worldTexts(p).slice(0, 2).map((t) => t.id).sort())
  })
  it("moves what is not locked, and says how many are locked", () => {
    let p = sample()
    const [a, b] = worldTexts(p)
    p = updateBoardTexts(p, [(b.source as { id: string }).id], { locked: true })
    const m = movableTexts(p, [a.id, b.id, "c:x"])
    expect(m.board).toEqual([(a.source as { id: string }).id])
    expect(m.locked).toBe(1)
    expect(textIds([a.id, "c:x", "g:1", partTextId("c", 0)])).toEqual([a.id, partTextId("c", 0)])
  })
  it("a new text starts at 1 mm and 0.15 mm, and on copper at 1.5 mm and 0.3 mm", () => {
    expect(defaultTextStyle("F.SilkS")).toEqual({ size: 1, thickness: 0.15 })
    expect(defaultTextStyle("B.Cu")).toEqual({ size: 1.5, thickness: 0.3 })
  })
})

describe("the Inspector's facts about texts", () => {
  it("shows what texts share and 'mixed' for what they do not", () => {
    let p = blinker()
    p = addBoardText(p, { layer: "F.SilkS", text: "a", x: 0, y: 0, rot: 0, size: 1, bold: true }).project
    p = addBoardText(p, { layer: "F.SilkS", text: "b", x: 1, y: 0, rot: 90, size: 1.5, bold: true }).project
    const f = textFacts(worldTexts(p))
    expect(f).toMatchObject({ count: 2, kind: "Board text", layer: "F.SilkS", bold: true, italic: false, allPart: false })
    expect(f.size).toBe("__mixed")
    expect(f.rot).toBe("__mixed")
  })
  it("lists the layers a text can be on, the board's edge among them, and rows read what a text shows", () => {
    const groups = textLayerGroups()
    expect(groups.flatMap((g) => g.layers.map((l) => l.name))).toContain("Edge.Cuts")
    expect(groups.flatMap((g) => g.layers.map((l) => l.name))).toContain("F.SilkS")
    let p = blinker()
    const c = part(p)
    p = addPartText(p, c.id, { text: "line one\nline two that is long and long", at: { x: 0, y: 0 } }).project
    const w = componentTexts(p.components.find((x) => x.id === c.id)!).find((t) => t.kind === "user")!
    expect(textRowText(w, shownOf(p, w))).toBe("Text: line one line two that ...")
    expect(textRowText({ ...w, kind: "reference", hidden: true }, "U1")).toBe("Reference: U1 (hidden)")
  })
})

describe("the project file", () => {
  it("a version 3 document, with no text, loads with none and writes none", () => {
    const p = blinker()
    const stored = JSON.parse(serializeProject(p))
    stored.version = 3
    const read = parseProjectFile(stored, { id: "x" })
    expect(read.components.every((c) => c.texts === undefined)).toBe(true)
    const written = JSON.parse(serializeProject(read)).project
    expect(written).not.toHaveProperty("kt")
    expect(written).not.toHaveProperty("textStyles")
    expect(written.components.every((c: { tx?: unknown }) => c.tx === undefined)).toBe(true)
  })
  it("reads text written as objects by hand, and drops what is damaged: a layer that is not KiCad's, a size of nothing, a number that is not one", () => {
    const p = blinker()
    const c = part(p)
    const doc = JSON.parse(serializeProject(p))
    doc.project.components = doc.project.components.map((x: { id: string }) => (x.id === c.id ? { ...x, texts: [{ kind: "reference", layer: "F.SilkS", x: 1, y: 2, size: 1, rot: 0 }, { kind: "user", text: "ok", layer: "Nowhere", x: 1, y: 2, size: 1, rot: 0 }, { kind: "user", text: "bad", layer: "F.SilkS", x: "a", y: 2, size: 1, rot: 0 }, { kind: "user", text: "tiny", layer: "F.SilkS", x: 1, y: 2, size: 0, rot: 0 }, { kind: "value", layer: "F.Fab", x: 0, y: 0, size: 1, rot: 90, hide: true }] } : x))
    doc.project.texts = [...doc.project.texts, { id: "h1", text: "by hand", layer: "B.SilkS", x: 1, y: 1, size: 1, rot: 0, side: "bottom", mirror: true }, { id: "h1", text: "again", layer: "F.SilkS", x: 1, y: 1, size: 1, rot: 0 }, { id: "h2", text: "no layer here", layer: "Nowhere", x: 1, y: 1, size: 1, rot: 0 }]
    const read = parseProjectFile(doc, { id: "x" })
    expect(read.components.find((x) => x.id === c.id)!.texts!.map((t) => t.kind)).toEqual(["reference", "value"])
    expect(read.texts.filter((t) => t.layer !== undefined).map((t) => t.id)).toEqual(["h1"])
    expect(read.texts.find((t) => t.id === "h1")).toMatchObject({ side: "bottom", mirror: true })
  })
  it("damaged stored entries are dropped one by one, and a style that does not read takes its texts with it", () => {
    let p = blinker()
    p = addBoardText(p, { layer: "F.SilkS", text: "keep", x: 1, y: 1, rot: 0, size: 1 }).project
    p = addBoardText(p, { layer: "F.Fab", text: "gone", x: 1, y: 1, rot: 0, size: 2 }).project
    const doc = JSON.parse(serializeProject(p))
    expect(doc.project.kt).toHaveLength(2)
    doc.project.textStyles[doc.project.kt[1][0]] = { l: "Nowhere", s: 2 }
    doc.project.kt.push([99, "T", 0, 0, 0, "orphan", 0], [0, "T", "x", 0, 0, "bad", 0], [0, "Q", 0, 0, 0, "kind", 0])
    const read = parseProjectFile(doc, { id: "x" })
    expect(read.texts.filter((t) => t.layer !== undefined).map((t) => t.text)).toEqual(["keep"])
  })
  it("a box and a bold, italic, mirrored, knockout text with its justification survive a save and a load exactly", () => {
    let p = blinker()
    p = addBoardText(p, { layer: "B.Cu", text: "all\nof it", x: 1.123456, y: -2.000001, rot: 33.333333, size: 1.4, w: 1.1, thickness: 0.22, bold: true, italic: true, mirror: true, knockout: true, hj: "right", vj: "top", spacing: 1.25, locked: true, href: "http://x", box: { w: 5, h: 3, border: 0.2, margins: [0.1, 0.2, 0.3, 0.4] } }).project
    const c = part(p)
    p = addPartText(p, c.id, { text: "${REFERENCE}", at: { x: 5, y: 5 } }).project
    p = updatePartText(p, c.id, 1, { hide: true, upright: false, mirror: true })
    const back = parseProjectFile(serializeProject(p), { id: "x" })
    expect(back.texts).toEqual(p.texts)
    expect(back.components.find((x) => x.id === c.id)!.texts).toEqual(p.components.find((x) => x.id === c.id)!.texts)
  })
})
