import { writeFile, rename } from "node:fs/promises"

/**
 * Writes `notebookJson` to `path` via a temp file + atomic rename, rather
 * than writing the target file directly - reduces (doesn't eliminate) the
 * chance of a reader, or jupytext.vim's own concurrent save, ever seeing a
 * half-written file, since rename is atomic on POSIX filesystems.
 */
export async function writeNotebookFile(path: string, notebookJson: any): Promise<void> {
  const tmpPath = `${path}.ipynb-peek.tmp`
  await writeFile(tmpPath, JSON.stringify(notebookJson, null, 1), "utf8")
  await rename(tmpPath, path)
}
