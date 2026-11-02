import { execFile } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

// KiCad's own command line, the judge of the KiCad-judged audit (`../kicad-judge-corpus.test.ts`). Every call runs on a file and reads what KiCad wrote.

/** `KICAD_CLI`, else where KiCad 10's installer puts it for one user on Windows. */
export const KICAD_CLI = process.env.KICAD_CLI ?? join(process.env.LOCALAPPDATA ?? "", "Programs/KiCad/10.0/bin/kicad-cli.exe")

export const kicadCliAvailable = () => existsSync(KICAD_CLI)

export interface CliResult {
  ok: boolean
  code: number | null
  out: string
}

/** Runs kicad-cli; never throws (a failed run is `ok: false` with the output). */
export function cli(args: string[], timeoutMs = 240_000): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(KICAD_CLI, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? ((err as { code?: number }).code ?? -1) : 0
      resolve({ ok: !err, code: typeof code === "number" ? code : -1, out: `${stdout}\n${stderr}`.trim() })
    })
  })
}

/** Everything KiCad says of one board or schematic file, as text per kind of output. `null` for an output KiCad could not make. */
export interface Judged {
  /** `pcb export pos` as CSV. */
  pos: string | null
  /** `pcb export ipcd356`: every pad's and via's net. */
  ipc: string | null
  /** `pcb drc` as JSON, on the fills the file stores. */
  drc: string | null
  /** `pcb drc --refill-zones`: the copper KiCad itself makes of the zones, so the zones' settings are what is judged. */
  drcRefill: string | null
  /** `pcb drc --schematic-parity` (with a schematic): what "Update PCB from Schematic" would change. */
  parity: string | null
  /** gerbers: file name to its text (the directory is read back). */
  gerbers: Record<string, string>
  /** drills: file name to its text. */
  drills: Record<string, string>
  /** `sch export netlist` in KiCad's own s-expression, null when the project has no schematic. */
  netlist: string | null
  /** `sch erc` as JSON. */
  erc: string | null
  /** `sch export bom` with the default fields as CSV. */
  bom: string | null
  errors: string[]
}

const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null)

function readDir(dir: string, re: RegExp): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) if (re.test(name)) out[name] = readFileSync(join(dir, name), "utf8")
  return out
}

/** Runs the checks on a board (and its schematic) with `work` as the scratch folder of this side. */
export async function judge(pcb: string, sch: string | null, work: string): Promise<Judged> {
  mkdirSync(work, { recursive: true })
  const g = join(work, "gerber")
  const d = join(work, "drill")
  mkdirSync(g, { recursive: true })
  mkdirSync(d, { recursive: true })
  const errors: string[] = []
  const run = async (name: string, args: string[], timeoutMs?: number) => {
    const r = await cli(args, timeoutMs)
    if (!r.ok) errors.push(`${name}: ${r.out.split("\n").slice(-3).join(" | ").slice(0, 300)}`)
    return r
  }
  const jobs: Promise<unknown>[] = [
    run("pos", ["pcb", "export", "pos", "--format", "csv", "--units", "mm", "-o", join(work, "pos.csv"), pcb]),
    run("ipc", ["pcb", "export", "ipcd356", "-o", join(work, "net.ipc"), pcb]),
    run("drc", ["pcb", "drc", "--format", "json", "--severity-all", "--all-track-errors", "-o", join(work, "drc.json"), pcb]),
    run("gerbers", ["pcb", "export", "gerbers", "--no-netlist", "-o", g + "/", pcb]),
    run("drill", ["pcb", "export", "drill", "--excellon-separate-th", "--format", "excellon", "-o", d + "/", pcb]),
  ]
  // KiCad's own fill of the zones is slow (minutes on a dense board), so it is asked for only with KICAD_JUDGE_REFILL=1: what the zones' settings make, in KiCad's hands.
  if (process.env.KICAD_JUDGE_REFILL) jobs.push(run("drcRefill", ["pcb", "drc", "--refill-zones", "--format", "json", "--severity-all", "--all-track-errors", "-o", join(work, "drc-refill.json"), pcb], 150_000))
  if (sch) {
    jobs.push(
      run("parity", ["pcb", "drc", "--schematic-parity", "--format", "json", "--severity-all", "-o", join(work, "parity.json"), pcb]),
      run("netlist", ["sch", "export", "netlist", "--format", "kicadsexpr", "-o", join(work, "net.net"), sch]),
      run("erc", ["sch", "erc", "--format", "json", "--severity-all", "-o", join(work, "erc.json"), sch]),
      run("bom", ["sch", "export", "bom", "--fields", "Reference,Value,Footprint,${QUANTITY},${DNP},${EXCLUDE_FROM_BOM},${EXCLUDE_FROM_BOARD}", "--group-by", "Value,Footprint", "-o", join(work, "bom.csv"), sch]),
    )
  }
  await Promise.all(jobs)
  return { ...readJudged(work, !!sch), errors }
}

/** What the commands of `judge` left in `work`, read again. */
export function readJudged(work: string, hasSchematic: boolean): Judged {
  const g = join(work, "gerber")
  const d = join(work, "drill")
  return {
    pos: read(join(work, "pos.csv")),
    ipc: read(join(work, "net.ipc")),
    drc: read(join(work, "drc.json")),
    drcRefill: read(join(work, "drc-refill.json")),
    parity: hasSchematic ? read(join(work, "parity.json")) : null,
    gerbers: readDir(g, /\.(g[a-z0-9]{2}|gbr|gbrjob)$/i),
    drills: readDir(d, /\.drl$/i),
    netlist: read(join(work, "net.net")),
    erc: read(join(work, "erc.json")),
    bom: read(join(work, "bom.csv")),
    errors: [],
  }
}
