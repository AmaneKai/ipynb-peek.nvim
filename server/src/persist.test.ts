import { describe, test, expect, afterEach } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeNotebookFile } from "./persist"

const tmpDirs: string[] = []

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ipynb-peek-persist-test-"))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe("writeNotebookFile", () => {
  test("writes the notebook JSON to the target path", async () => {
    const dir = makeTmpDir()
    const path = join(dir, "test.ipynb")
    const notebookJson = { cells: [{ cell_type: "code", source: ["1 + 1"] }], nbformat: 4 }

    await writeNotebookFile(path, notebookJson)

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(notebookJson)
  })

  test("overwrites an existing file rather than appending", async () => {
    const dir = makeTmpDir()
    const path = join(dir, "test.ipynb")

    await writeNotebookFile(path, { version: 1 })
    await writeNotebookFile(path, { version: 2 })

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 2 })
  })

  test("doesn't leave the temp file behind after a successful write", async () => {
    const dir = makeTmpDir()
    const path = join(dir, "test.ipynb")

    await writeNotebookFile(path, { a: 1 })

    expect(readdirSync(dir)).toEqual(["test.ipynb"])
  })

  test("serializes concurrent writes to the same path instead of racing on the shared tmp file", async () => {
    // Regression test: two concurrent calls used to both target the same
    // `${path}.ipynb-peek.tmp` file. Whichever renamed it away first left
    // the other's rename failing with ENOENT. Firing many concurrent pairs
    // makes the race observable if serialization ever regresses.
    for (let i = 0; i < 50; i++) {
      const dir = makeTmpDir()
      const path = join(dir, "test.ipynb")

      const results = await Promise.allSettled([
        writeNotebookFile(path, { a: 1 }),
        writeNotebookFile(path, { a: 2 }),
      ])

      expect(results.every((r) => r.status === "fulfilled")).toBe(true)
      // Calls are serialized in call order, so the second call's write wins.
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ a: 2 })
      expect(readdirSync(dir)).toEqual(["test.ipynb"])
    }
  })
})
