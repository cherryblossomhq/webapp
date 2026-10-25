import type { InputEntry } from "./protocol"

// Files from the browser's two doors: a file picker (a list of files) and a drop, which may hold
// folders. A dropped folder has to be walked entry by entry; the browser gives no flat list.

/** Folders a project never keeps its design in, and that can hold thousands of files. */
const SKIP_FOLDERS = new Set([".git", "node_modules", ".svn"])
/** A folder with more files than this is not a KiCad project. */
const MAX_DROPPED_FILES = 20_000

/** A drop of project files of ours (every file a `.json`) goes to the project file import, as it always did; any other drop is KiCad's. */
export const isProjectFileDrop = (files: ArrayLike<{ name: string }>) => files.length > 0 && Array.from(files).every((f) => /\.json$/i.test(f.name))

export const entriesFromFiles = (files: Iterable<File>): InputEntry[] => [...files].map((file) => ({ file, path: file.webkitRelativePath || file.name }))

const readAll = (reader: FileSystemDirectoryReader) =>
  new Promise<FileSystemEntry[]>((resolve, reject) => {
    const all: FileSystemEntry[] = []
    // `readEntries` hands over a batch of up to 100 and an empty batch at the end.
    const next = () =>
      reader.readEntries((batch) => {
        if (!batch.length) return resolve(all)
        all.push(...batch)
        next()
      }, reject)
    next()
  })

async function walk(entry: FileSystemEntry, out: InputEntry[]): Promise<void> {
  if (out.length >= MAX_DROPPED_FILES) return
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))
    out.push({ file, path: entry.fullPath.replace(/^\//, "") })
  } else if (entry.isDirectory && !SKIP_FOLDERS.has(entry.name)) {
    for (const child of await readAll((entry as FileSystemDirectoryEntry).createReader())) await walk(child, out)
  }
}

/**
 * What was dropped, folders walked. The browser empties a drop's list once the handler returns, so
 * the entries are taken before the first `await`; call this straight from the drop handler.
 */
export function entriesFromDrop(data: DataTransfer): Promise<InputEntry[]> {
  const entries = [...data.items].flatMap((item) => (item.kind === "file" ? [item.webkitGetAsEntry?.() ?? null] : []))
  const plain = [...data.files]
  // No entry API (an old browser): the plain files, which hold no folders.
  if (!entries.length || entries.every((e) => e === null)) return Promise.resolve(entriesFromFiles(plain))
  return (async () => {
    const out: InputEntry[] = []
    for (const entry of entries) if (entry) await walk(entry, out)
    return out
  })()
}
