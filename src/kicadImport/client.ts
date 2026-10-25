import type { BoardChoice } from "./pick"
import type { ImportOutcome, InputEntry, Phase, StartRequest, WorkerEvent } from "./protocol"
import { stoppedSummary } from "./summary"

// The page's side of an import job: start it in a worker, pass its progress on, and end it on
// request. A job is one worker; ending the job ends the worker, which is how cancel works (the
// importer is one long synchronous call, so a message could not interrupt it).

export type JobResult =
  | { kind: "done"; outcome: ImportOutcome; durationMs: number }
  | { kind: "choose"; boards: BoardChoice[] }
  | { kind: "cancelled" }

export interface ImportJob {
  result: Promise<JobResult>
  cancel(): void
}

/** What a worker is to the page, so a test can stand in for one. */
export interface WorkerLike {
  onmessage: ((e: MessageEvent<WorkerEvent>) => void) | null
  onerror: ((e: ErrorEvent) => void) | null
  onmessageerror: ((e: MessageEvent) => void) | null
  postMessage(message: StartRequest): void
  terminate(): void
}

export interface StartOptions {
  choice?: string
  onProgress?: (phase: Phase) => void
  /** Made for each job; `null` runs the job on the page, for a browser with no workers. */
  createWorker?: (() => WorkerLike) | null
  /**
   * End a job whose worker has said nothing for this long. The importer is one long call that sends
   * nothing while it works (about 25 s for the largest board read), so this is generous: it is there
   * for a worker that has died or hung, not for a slow board.
   */
  watchdogMs?: number
}

/** How long a worker may stay silent before the job is ended. */
export const WATCHDOG_MS = 120_000

// The literal `new Worker(new URL(..., import.meta.url))` is what the bundler looks for.
const browserWorker = (): WorkerLike => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike

let jobs = 0

const failed = (why: string, detail?: string): JobResult => ({ kind: "done", outcome: { project: null, summary: stoppedSummary("failed", why, undefined, detail ?? null) }, durationMs: 0 })

export function startImport(files: InputEntry[], options: StartOptions = {}): ImportJob {
  const id = ++jobs
  const request: StartRequest = { type: "start", id, files, choice: options.choice }
  const started = performance.now()
  let finish: (r: JobResult) => void = () => {}
  const result = new Promise<JobResult>((resolve) => (finish = resolve))
  let end = () => {}
  let over = false
  let dog: ReturnType<typeof setTimeout> | undefined
  const settle = (r: JobResult) => {
    if (over) return
    over = true
    clearTimeout(dog)
    end()
    finish(r.kind === "done" ? { ...r, durationMs: Math.round(performance.now() - started) } : r)
  }
  const watch = () => {
    clearTimeout(dog)
    const ms = options.watchdogMs ?? WATCHDOG_MS
    dog = setTimeout(() => settle(failed("The import stopped answering and was ended. Nothing was saved. Try again, or try a smaller board.", `no answer from the worker for ${Math.round(ms / 1000)} s`)), ms)
  }
  const onEvent = (e: WorkerEvent) => {
    if (e.id !== id || over) return
    watch()
    if (e.type === "progress") options.onProgress?.(e.phase)
    else if (e.type === "choose") settle({ kind: "choose", boards: e.boards })
    else settle({ kind: "done", outcome: e.outcome, durationMs: 0 })
  }

  watch()
  const make = options.createWorker === undefined ? (typeof Worker === "undefined" ? null : browserWorker) : options.createWorker
  if (make) {
    let worker: WorkerLike
    try {
      worker = make()
    } catch (e) {
      settle(failed("The import could not start in this browser. Try a current Chrome, Firefox or Safari.", e instanceof Error ? e.message : String(e)))
      return { result, cancel: () => {} }
    }
    end = () => worker.terminate()
    worker.onmessage = (e) => onEvent(e.data)
    worker.onerror = (e) => {
      e.preventDefault?.()
      settle(failed("The import could not load. Reload the page and try again."))
    }
    worker.onmessageerror = () => settle(failed("The import's answer could not be read. Try again."))
    try {
      worker.postMessage(request)
    } catch {
      settle(failed("The files could not be handed to the import. Try again."))
    }
  } else {
    // No worker: the same job on the page, which freezes it for a large board, but imports it.
    import("./engine").then(
      ({ runImport }) => runImport(request, onEvent),
      (e: unknown) => settle(failed("The import could not load. Reload the page and try again.", e instanceof Error ? e.message : String(e))),
    )
  }
  return { result, cancel: () => settle({ kind: "cancelled" }) }
}
