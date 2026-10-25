import { afterEach, describe, expect, it } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WebSocket } from "ws"
import { createServer } from "./index"
import { defaultExportPath } from "./core/commands"

describe("defaultExportPath", () => {
  it("sits next to the notebook, with a -report suffix when code is omitted", () => {
    expect(defaultExportPath("/a/b/analysis.ipynb", "html")).toBe("/a/b/analysis.html")
    expect(defaultExportPath("/a/b/analysis.ipynb", "report")).toBe("/a/b/analysis-report.html")
    expect(defaultExportPath(undefined, "html")).toBeUndefined()
  })
})

describe("commands", () => {
  let server: Awaited<ReturnType<typeof createServer>> | undefined
  let tempDir: string | undefined
  afterEach(async () => {
    server?.stop(true)
    server = undefined
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  })

  it("returns no variables, without starting a kernel, before the first run", async () => {
    server = await createServer(0)
    expect(await server.commands.variables()).toEqual({
      status: 200,
      body: { ok: true, variables: [], kernel_running: false },
    })
    expect(server.session.kernelRunning).toBe(false)
  })

  it("validates and broadcasts theme changes", async () => {
    server = await createServer(0)
    const sent: string[] = []
    server.session.wsClients.add({
      readyState: WebSocket.OPEN,
      send: (m: string) => sent.push(m),
      terminate() {},
    } as any)

    expect(await server.commands.theme({ name: "nope" })).toMatchObject({ status: 400 })
    await server.commands.theme({ name: "gruvbox" })
    expect(server.session.theme).toBe("gruvbox")
    expect(JSON.parse(sent[0])).toMatchObject({ type: "theme", name: "gruvbox" })

    await server.commands.theme({ name: "default" })
    expect(server.session.theme).toBeNull()
  })

  it("refuses to export when no preview window is connected", async () => {
    server = await createServer(0)
    await expect(server.commands.export({ mode: "html", path: "/tmp/x.html" })).rejects.toThrow(
      /no preview window/,
    )
    expect(await server.commands.print()).toMatchObject({ status: 409 })
  })

  it("round-trips an export through the browser and writes the file", async () => {
    server = await createServer(0)
    tempDir = await mkdtemp(join(tmpdir(), "ipynb-peek-export-"))
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`)
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve())
      ws.once("error", reject)
    })
    ws.on("message", async (data) => {
      const message = JSON.parse(data.toString())
      if (message.type !== "export_request") return
      await fetch(`http://127.0.0.1:${server!.port}/export-result`, {
        method: "POST",
        body: JSON.stringify({ id: message.id, html: `<p>mode=${message.mode}</p>` }),
      })
    })

    const target = join(tempDir, "out.html")
    const result = await server.commands.export({ mode: "report", path: target })

    expect(result).toEqual({ status: 200, body: { ok: true, path: target } })
    expect(await readFile(target, "utf8")).toBe("<p>mode=report</p>")
    ws.close()
  })

  it("rejects an export result for an unknown id", async () => {
    server = await createServer(0)
    const response = await fetch(`http://127.0.0.1:${server.port}/export-result`, {
      method: "POST",
      body: JSON.stringify({ id: "nope", html: "x" }),
    })
    expect(response.status).toBe(404)
  })

  it("rejects selecting an unknown kernel name", async () => {
    server = await createServer(0)
    // Listing kernels needs `jupyter`; where it is missing the command must still fail cleanly.
    const outcome = await server.commands
      .selectKernel({ name: "definitely-not-a-kernel" })
      .catch((e) => e)
    expect(outcome instanceof Error || outcome?.status === 400).toBe(true)
  })
})
