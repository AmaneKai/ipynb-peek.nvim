import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { WebSocket } from "ws"
import { createServer } from "./index"

const describeKernel = process.env.IPYNB_PEEK_E2E === "1" ? describe : describe.skip

describeKernel("real ipykernel workflow", () => {
  let server: Awaited<ReturnType<typeof createServer>>
  let baseUrl: string
  let notebookPath: string
  let tempDir: string
  let ws: WebSocket
  let kernelName: string
  const messages: any[] = []
  const waiters: Array<() => void> = []

  function notebook(source: string) {
    return {
      cells: [
        {
          id: "cell-one",
          cell_type: "code",
          metadata: {},
          source: [source],
          execution_count: null,
          outputs: [],
        },
      ],
      metadata: {
        kernelspec: { name: kernelName, language: "python", display_name: "Python 3" },
      },
      nbformat: 4,
      nbformat_minor: 5,
    }
  }

  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
    const decoded = await response.json()
    if (!response.ok) throw new Error(`${path} failed: ${JSON.stringify(decoded)}`)
    return decoded
  }

  async function waitForMessage(predicate: (message: any) => boolean, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const index = messages.findIndex(predicate)
      if (index !== -1) return messages.splice(index, 1)[0]
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => {
            const waiterIndex = waiters.indexOf(wake)
            if (waiterIndex !== -1) waiters.splice(waiterIndex, 1)
            reject(new Error("timed out waiting for kernel message"))
          },
          Math.min(250, deadline - Date.now()),
        )
        const wake = () => {
          clearTimeout(timer)
          resolve()
        }
        waiters.push(wake)
      }).catch(() => {})
    }
    throw new Error("timed out waiting for matching kernel message")
  }

  beforeAll(async () => {
    // pipx exposes `jupyter` through a shim but may not expose the relative
    // `python` used by its own python3 kernelspec. Put that jupyter venv's bin
    // directory on PATH for this isolated test, exactly as an activated venv
    // would, without teaching production code to substitute interpreters.
    const locator = process.platform === "win32" ? "where" : "which"
    const jupyterPath = execFileSync(locator, ["jupyter"], { encoding: "utf8" })
      .trim()
      .split(/\r?\n/, 1)[0]
    process.env.PATH = `${dirname(realpathSync(jupyterPath))}${delimiter}${process.env.PATH}`
    const specs = JSON.parse(
      execFileSync("jupyter", ["kernelspec", "list", "--json"], {
        encoding: "utf8",
      }),
    ).kernelspecs
    kernelName =
      process.env.IPYNB_PEEK_E2E_KERNEL ??
      Object.entries<any>(specs).find(([, entry]) => {
        try {
          execFileSync(entry.spec.argv[0], ["-c", "import ipykernel_launcher"], { stdio: "ignore" })
          return true
        } catch {
          return false
        }
      })?.[0] ??
      "python3"
    tempDir = mkdtempSync(join(tmpdir(), "ipynb-peek-e2e-"))
    notebookPath = join(tempDir, "workflow.ipynb")
    writeFileSync(notebookPath, JSON.stringify(notebook("old source")))
    server = await createServer(0)
    baseUrl = `http://127.0.0.1:${server.port}`
    ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`)
    ws.on("message", (data) => {
      messages.push(JSON.parse(data.toString()))
      for (const wake of waiters.splice(0)) wake()
    })
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve)
      ws.once("error", reject)
    })
    await post("/render", notebook("old source"), {
      "x-notebook-dir": tempDir,
      "x-notebook-path": notebookPath,
    })
  }, 15000)

  afterAll(() => {
    ws?.close()
    server?.stop(true)
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  })

  test("keeps output attached when execute wins the race with debounced sync, then persists after save", async () => {
    const code = 'import time\ntime.sleep(0.25)\nprint("fresh output")'
    await post("/execute", { index: 0, code })
    await post("/sync", { cells: [{ cell_type: "code", source: code }] })

    const settled = await waitForMessage(
      (message) =>
        message.type === "cell_update" &&
        message.index === 0 &&
        message.cell.status === "idle" &&
        message.cell.outputs.some((output: any) => output.content?.includes("fresh output")),
    )
    expect(settled.cell.source).toBe(code)
    expect(settled.cell).not.toHaveProperty("nbformat_outputs")

    // Simulate jupytext saving the edited source. /render must merge the
    // live result and patch that freshly saved file, not an older snapshot.
    writeFileSync(notebookPath, JSON.stringify(notebook(code)))
    const response = await fetch(`${baseUrl}/render`, {
      method: "POST",
      headers: {
        "x-notebook-dir": tempDir,
        "x-notebook-path": notebookPath,
      },
      body: JSON.stringify(notebook(code)),
    })
    expect(response.ok).toBe(true)

    const saved = JSON.parse(readFileSync(notebookPath, "utf8"))
    expect(saved.cells[0].source).toEqual([code])
    expect(saved.cells[0].outputs[0]).toMatchObject({
      output_type: "stream",
      name: "stdout",
    })
    expect(saved.cells[0].outputs[0].text.join("")).toContain("fresh output")
  }, 45000)

  test("routes a kernel input_request to /input and resumes execution with the reply", async () => {
    const code = 'name = input("What is your name? ")\nprint(f"Hello, {name}!")'
    await post("/execute", { index: 0, code })

    const request = await waitForMessage((message) => message.type === "input_request")
    expect(request.index).toBe(0)
    expect(request.prompt).toContain("What is your name?")
    expect(request.password).toBe(false)

    await post("/input", { value: "Carlo" })

    const settled = await waitForMessage(
      (message) =>
        message.type === "cell_update" &&
        message.index === 0 &&
        message.cell.status === "idle" &&
        message.cell.outputs.some((output: any) => output.content?.includes("Hello, Carlo!")),
    )
    expect(settled.cell.source).toBe(code)
  }, 20000)
})
