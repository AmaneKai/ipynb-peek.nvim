import { writeFile, rename } from "node:fs/promises"

/**
 * Serializes writes per `path`, keyed on the in-flight promise for that
 * path. Two concurrent calls for the same path would otherwise both use the
 * same `${path}.ipynb-peek.tmp` file - whichever renamed it away first would
 * leave the other's rename failing with ENOENT.
 */
const writeQueues = new Map<string, Promise<void>>()

/**
 * Writes `notebookJson` to `path` via a temp file + atomic rename, rather
 * than writing the target file directly - reduces (doesn't eliminate) the
 * chance of a reader, or jupytext.vim's own concurrent save, ever seeing a
 * half-written file, since rename is atomic on POSIX filesystems.
 */
export function writeNotebookFile(path: string, notebookJson: any): Promise<void> {
  const queued = (writeQueues.get(path) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const tmpPath = `${path}.ipynb-peek.tmp`
    await writeFile(tmpPath, JSON.stringify(notebookJson, null, 1), "utf8")
    await rename(tmpPath, path)
  })

  writeQueues.set(path, queued)
  queued.finally(() => {
    if (writeQueues.get(path) === queued) writeQueues.delete(path)
  })

  return queued
}
