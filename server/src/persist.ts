import { readFile, rename, unlink, writeFile } from "node:fs/promises"

/**
 * Serializes writes per `path`, keyed on the in-flight promise for that
 * path. Two concurrent calls for the same path would otherwise both use the
 * same `${path}.ipynb-peek.tmp` file - whichever renamed it away first would
 * leave the other's rename failing with ENOENT.
 */
const writeQueues = new Map<string, Promise<void>>()

function enqueueWrite(path: string, action: () => Promise<void>): Promise<void> {
  const queued = (writeQueues.get(path) ?? Promise.resolve()).catch(() => {}).then(action)

  writeQueues.set(path, queued)
  const cleanup = () => {
    if (writeQueues.get(path) === queued) writeQueues.delete(path)
  }
  // Supplying both handlers avoids creating an ignored rejected Promise,
  // which `finally()` would do whenever the underlying write fails.
  void queued.then(cleanup, cleanup)
  return queued
}

/**
 * Writes `notebookJson` to `path` via a temp file + atomic rename, rather
 * than writing the target file directly - reduces (doesn't eliminate) the
 * chance of a reader, or jupytext.vim's own concurrent save, ever seeing a
 * half-written file, since rename is atomic on POSIX filesystems.
 */
export function writeNotebookFile(path: string, notebookJson: any): Promise<void> {
  return enqueueWrite(path, async () => {
    const tmpPath = `${path}.ipynb-peek.tmp`
    await writeFile(tmpPath, JSON.stringify(notebookJson, null, 1), "utf8")
    await rename(tmpPath, path)
  })
}

/**
 * Reads the newest notebook from disk, applies `update`, and replaces it only
 * if the file is still byte-for-byte the version that was read. jupytext.vim
 * writes outside this process, so our in-process queue alone cannot prevent a
 * save landing between read and rename; retrying against the newer contents
 * avoids restoring an older source snapshot just to persist fresh outputs.
 */
export function updateNotebookFile(
  path: string,
  update: (notebookJson: any) => void,
): Promise<void> {
  return enqueueWrite(path, async () => {
    const tmpPath = `${path}.ipynb-peek.tmp`
    for (let attempt = 0; attempt < 3; attempt++) {
      const original = await readFile(path, "utf8")
      const notebookJson = JSON.parse(original)
      update(notebookJson)
      await writeFile(tmpPath, JSON.stringify(notebookJson, null, 1), "utf8")

      const current = await readFile(path, "utf8")
      if (current === original) {
        await rename(tmpPath, path)
        return
      }
      await unlink(tmpPath).catch(() => {})
    }
    throw new Error(`notebook kept changing while outputs were being persisted: ${path}`)
  })
}
