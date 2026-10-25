import { afterEach, describe, expect, it } from "vitest"
import { PassThrough } from "node:stream"
import { createServer, serveStdio } from "./index"

const minimalNotebook = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {},
  cells: [{ cell_type: "code", source: "1 + 1", metadata: {}, outputs: [], execution_count: null }],
})

async function startStdio() {
  const server = await createServer(0)
  const input = new PassThrough()
  const lines: any[] = []
  const stdio = serveStdio(
    input,
    (line) => lines.push(JSON.parse(line)),
    server.session,
    server.commands,
  )
  const send = (msg: object) => input.write(JSON.stringify(msg) + "\n")
  const waitFor = async (predicate: (line: any) => boolean) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const found = lines.find(predicate)
      if (found) return found
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error("timed out waiting for output: " + JSON.stringify(lines))
  }
  return { input, lines, stdio, server, send, waitFor }
}

describe("serveStdio", () => {
  let active: Awaited<ReturnType<typeof startStdio>> | undefined
  afterEach(() => {
    active?.stdio.stop()
    active?.server.stop(true)
  })

  it("answers a command with a response carrying its id", async () => {
    active = await startStdio()
    active.send({ id: 7, type: "render", notebook: minimalNotebook })

    expect(await active.waitFor((l) => l.type === "response" && l.id === 7)).toMatchObject({
      ok: true,
    })
  })

  it("pushes cells_status events on the same stream after a render", async () => {
    active = await startStdio()
    active.send({ type: "render", notebook: minimalNotebook })

    const event = await active.waitFor((l) => l.type === "cells_status")
    expect(event.cells).toHaveLength(1)
  })

  it("reports a failing command as ok:false instead of dropping it", async () => {
    active = await startStdio()
    active.send({ id: 1, type: "render", notebook: "not json" })

    expect(await active.waitFor((l) => l.id === 1)).toMatchObject({ ok: false })
  })

  it("rejects an invalid cell index with the same error as the HTTP route", async () => {
    active = await startStdio()
    active.send({ id: 2, type: "render", notebook: minimalNotebook })
    active.send({ id: 3, type: "execute", index: 99, code: "1" })

    expect(await active.waitFor((l) => l.id === 3)).toEqual({
      type: "response",
      id: 3,
      ok: false,
      error: "invalid cell index",
    })
  })

  it("rejects unknown command types", async () => {
    active = await startStdio()
    active.send({ id: 4, type: "bogus" })

    expect(await active.waitFor((l) => l.id === 4)).toMatchObject({ ok: false })
  })

  it("applies ordered commands in arrival order", async () => {
    active = await startStdio()
    active.send({ type: "render", notebook: minimalNotebook })
    active.send({ id: 5, type: "sync", cells: [{ cell_type: "code", source: "2 + 2" }] })
    active.send({ id: 6, type: "execute", index: 1, code: "1" })

    // The sync was still queued behind render when execute arrived, but
    // must have been applied first - index 1 doesn't exist after it.
    expect(await active.waitFor((l) => l.id === 6)).toMatchObject({ ok: false })
  })
})
