import { execFile } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { altiumFiles } from "../src/export/altium"
import { kicadFiles } from "../src/export/kicad"
import { pcbPads } from "../src/model/instances"
import { importKicadBoard } from "../src/model/kicad/board/import"
import { onBoard } from "../src/model/partFlags"
import { resolvedComponents, withRuleAreaFlags } from "../src/model/ruleAreas"
import { copperCount } from "../src/model/stack"
import { built } from "./built"

// The board as Altium's own reader would get it, judged by the one reader of Altium boards there is to run here: KiCad's (`kicad-cli pcb import`).
// Every part, pad and net comes back where it was, and KiCad's DRC finds the copper joined as it finds the KiCad export's. KiCad 10 or later;
// `KICAD_CLI` names it, else where KiCad's installer puts it on a Mac. Skipped without it, as CI is.

const KICAD_CLI = process.env.KICAD_CLI ?? "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli"
const available = existsSync(KICAD_CLI)

const run = (args: string[]) =>
  new Promise<string>((resolve, reject) => execFile(KICAD_CLI, args, { maxBuffer: 64 * 1024 * 1024 }, (err, out, errOut) => (err ? reject(new Error(`${err.message}\n${errOut}`)) : resolve(out))))

/** "REF:pad" -> net, from a .kicad_pcb. */
function padNets(pcb: string): Map<string, string> {
  const nets = new Map<string, string>()
  for (const block of pcb.split(/\r?\n\t\(footprint\b/).slice(1)) {
    const ref = block.match(/\(property "Reference" "([^"]*)"/)?.[1] ?? ""
    for (const pad of block.split(/\(pad /).slice(1)) {
      const number = pad.match(/^"([^"]*)"/)?.[1]
      const net = pad.match(/\(net (?:\d+ )?"([^"]*)"\)/)?.[1] ?? ""
      if (number !== undefined) nets.set(`${ref}:${number}`, net)
    }
  }
  return nets
}

async function drc(pcb: string, work: string): Promise<{ unconnected: number; shorts: number }> {
  const out = join(work, `${Math.random().toString(36).slice(2)}.json`)
  await run(["pcb", "drc", "--format", "json", "--severity-all", "-o", out, pcb]).catch(() => undefined)
  const d = JSON.parse(readFileSync(out, "utf8")) as { violations: { type: string }[]; unconnected_items: unknown[] }
  return { unconnected: d.unconnected_items.length, shorts: d.violations.filter((v) => v.type === "shorting_items").length }
}

describe.skipIf(!available)("the Altium board, read by KiCad", () => {
  for (const id of ["blinker", "regulator", "mcu", "node", "esp32-robot"]) {
    it(`brings back every part and pad of ${id} where it was, on its net`, async () => {
      const source = built(id)
      const work = mkdtempSync(join(tmpdir(), "altium-"))
      const { files } = await altiumFiles(source)
      const name = Object.keys(files).find((n) => n.endsWith(".PcbDoc"))!
      writeFileSync(join(work, name), files[name])
      const out = join(work, "board.kicad_pcb")
      await run(["pcb", "import", "--format", "altium", "-o", out, join(work, name)])
      const text = readFileSync(out, "utf8")
      const read = importKicadBoard(text)
      expect(read.status).toBe("imported")
      if (read.status !== "imported") return
      const back = read.project
      const project = withRuleAreaFlags(source)
      const placed = resolvedComponents(project).filter((c) => c.pcb.placed && onBoard(c) && pcbPads(c).length)
      expect(back.components.length).toBeGreaterThanOrEqual(placed.length)
      // KiCad puts the board on its page: every place is moved by one offset.
      const first = back.components.find((c) => c.ref === placed[0].ref)!
      const dx = first.pcb.x - placed[0].pcb.x
      const dy = first.pcb.y - placed[0].pcb.y
      let pads = 0
      for (const c of placed) {
        const got = back.components.find((x) => x.ref === c.ref)
        expect(got, c.ref).toBeDefined()
        expect(Math.abs(got!.pcb.x - dx - c.pcb.x) < 1e-3 && Math.abs(got!.pcb.y - dy - c.pcb.y) < 1e-3, `${c.ref} at its place`).toBe(true)
        expect(got!.pcb.side).toBe(c.pcb.side)
        const theirs = pcbPads(got!, copperCount(back.board))
        for (const pad of pcbPads(c, copperCount(project.board))) {
          const hole = pad.hole ?? pad
          const match = theirs.find((q) => (q.padNumber ?? "") === (pad.padNumber ?? "") && Math.abs((q.hole ?? q).x - dx - hole.x) < 1e-3 && Math.abs((q.hole ?? q).y - dy - hole.y) < 1e-3)
          expect(match, `${c.ref}.${pad.padNumber}`).toBeDefined()
          expect(Math.abs((match!.holeDiameter ?? 0) - (pad.holeDiameter ?? 0)) < 1e-3, `${c.ref}.${pad.padNumber} hole`).toBe(true)
          if (pad.shape !== "polygon") expect(Math.abs(match!.width - pad.width) < 1e-3 && Math.abs(match!.height - pad.height) < 1e-3, `${c.ref}.${pad.padNumber} size`).toBe(true)
          pads++
        }
      }
      expect(pads).toBeGreaterThan(10)
      expect(back.traces.length).toBeGreaterThan(0)
      expect(back.vias.length).toBe(source.vias.length)
      expect(back.zones.length).toBe(source.zones.length)

      // The nets, judged as KiCad joins the copper: the KiCad export of the same board, read by KiCad, has the same pads on one net and the same
      // connections left to make.
      const kicad = await kicadFiles(source)
      const kName = Object.keys(kicad.files).find((n) => n.endsWith(".kicad_pcb"))!
      const kPath = join(work, kName)
      writeFileSync(kPath, kicad.files[kName])
      const theirs = padNets(text)
      const ours = padNets(kicad.files[kName])
      // Net names differ only where the schematic named none (Net-(R1-Pad2) against NetR1_2): pads on one net in one are on one net in the other.
      const byName = new Map<string, string>()
      for (const [pad, net] of ours) {
        if (!net || !theirs.has(pad)) continue
        const seen = byName.get(net)
        if (seen === undefined) byName.set(net, theirs.get(pad)!)
        else expect(theirs.get(pad), pad).toBe(seen)
      }
      expect(new Set(byName.values()).size).toBe(byName.size)
      const [a, b] = await Promise.all([drc(out, work), drc(kPath, work)])
      expect(a).toEqual(b)
    }, 600_000)
  }
})
