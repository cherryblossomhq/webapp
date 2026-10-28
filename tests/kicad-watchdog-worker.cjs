// The watchdog of kicad-corpus-shared.ts, in a worker thread so that it still runs while the main thread is stuck in a loop.
// It looks once a second at the beat the main thread adds to cell 0 at the start of every board; when the beat has not moved for `limitMs`
// it names the board (the main thread writes it to `currentFile`) and ends the whole process.
const { workerData } = require("node:worker_threads")
const fs = require("node:fs")
const { label, limitMs, cells, currentFile, pid } = workerData
const view = new Int32Array(cells)
let last = Atomics.load(view, 0)
let since = Date.now()
setInterval(() => {
  if (Atomics.load(view, 1) === 1) return
  const now = Atomics.load(view, 0)
  if (now !== last) {
    last = now
    since = Date.now()
    return
  }
  if (Date.now() - since > limitMs) {
    let board = "?"
    try {
      board = fs.readFileSync(currentFile, "utf8")
    } catch {}
    fs.writeSync(2, `\n${label}: no progress for ${Math.round((Date.now() - since) / 1000)} s on board ${board}\n`)
    process.kill(pid, "SIGKILL")
  }
}, 1000)
