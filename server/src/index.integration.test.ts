import { describe, test, expect, beforeAll, afterAll } from "vitest"
import { WebSocket } from "ws"
import { createServer } from "./index"

/**
 * Exercises the HTTP routing/response-shape layer against a real Node
 * server instance on a random port. Deliberately stays clear of /execute's
 * happy path and /restart, since both touch the real kernel-bridge child
 * process - that path is covered by manual testing against a live Jupyter
 * kernel, not CI.
 */

let server: Awaited<ReturnType<typeof createServer>>
let baseUrl: string
let wsUrl: string

async function readOk(response: Response): Promise<boolean> {
  const body = (await response.json()) as { ok: boolean }
  return body.ok
}

beforeAll(async () => {
  server = await createServer(0)
  baseUrl = `http://127.0.0.1:${server.port}`
  wsUrl = `ws://127.0.0.1:${server.port}/ws`
})

afterAll(() => {
  server.stop(true)
})

describe("GET /health", () => {
  test("responds ok", async () => {
    const response = await fetch(`${baseUrl}/health`)
    expect(await response.text()).toBe("ok")
  })
})

describe("GET /", () => {
  test("serves the notebook shell HTML", async () => {
    const response = await fetch(`${baseUrl}/`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<div id="notebook">')
  })
})

describe("GET /client.js and /style.css", () => {
  test("serve the extracted client assets", async () => {
    const script = await fetch(`${baseUrl}/client.js`)
    const style = await fetch(`${baseUrl}/style.css`)
    expect(script.status).toBe(200)
    expect(style.status).toBe(200)
  })
})

describe("POST /render", () => {
  test("renders a notebook and reports ok", async () => {
    const notebook = {
      metadata: { kernelspec: { language: "python" } },
      cells: [{ cell_type: "code", source: ["1 + 1"], outputs: [] }],
    }
    const response = await fetch(`${baseUrl}/render`, {
      method: "POST",
      body: JSON.stringify(notebook),
      headers: { "x-notebook-dir": "/tmp" },
    })
    expect(await readOk(response)).toBe(true)
  })

  test("reports a 500 with an error message for malformed JSON", async () => {
    const response = await fetch(`${baseUrl}/render`, {
      method: "POST",
      body: "not json",
    })
    expect(response.status).toBe(500)
    expect(await readOk(response)).toBe(false)
  })
})

describe("POST /sync", () => {
  test("syncs live cell state and reports ok", async () => {
    const response = await fetch(`${baseUrl}/sync`, {
      method: "POST",
      body: JSON.stringify({ cells: [{ cell_type: "code", source: "2 + 2" }] }),
    })
    expect(await readOk(response)).toBe(true)
  })
})

describe("POST /execute", () => {
  test("rejects an out-of-range cell index with a 400 before touching the bridge", async () => {
    const response = await fetch(`${baseUrl}/execute`, {
      method: "POST",
      body: JSON.stringify({ index: 999, code: "1" }),
    })
    expect(response.status).toBe(400)
    expect(await readOk(response)).toBe(false)
  })
})

describe("POST /restart", () => {
  test("reports ok without a kernel ever having been started", async () => {
    const response = await fetch(`${baseUrl}/restart`, { method: "POST" })
    expect(await readOk(response)).toBe(true)
  })

  test("flips any busy cell back to idle", async () => {
    const notebook = {
      metadata: { kernelspec: { language: "python" } },
      cells: [{ cell_type: "code", source: ["1 + 1"], outputs: [] }],
    }
    await fetch(`${baseUrl}/render`, {
      method: "POST",
      body: JSON.stringify(notebook),
      headers: { "x-notebook-dir": "/tmp" },
    })

    const { ws, ready, nextMessage } = (function connect(url: string) {
      const socket = new WebSocket(url)
      const queue: any[] = []
      const waiters: Array<(msg: any) => void> = []
      socket.on("message", (data) => {
        const parsed = JSON.parse(data.toString())
        const waiter = waiters.shift()
        if (waiter) waiter(parsed)
        else queue.push(parsed)
      })
      return {
        ws: socket,
        ready: new Promise<void>((resolve) => socket.once("open", () => resolve())),
        nextMessage(): Promise<any> {
          const queued = queue.shift()
          if (queued !== undefined) return Promise.resolve(queued)
          return new Promise((resolve) => waiters.push(resolve))
        },
      }
    })(wsUrl)
    await ready
    await nextMessage() // initial render payload

    const restartBroadcast = nextMessage()
    await fetch(`${baseUrl}/restart`, { method: "POST" })
    const rendered = await restartBroadcast
    expect(rendered.type).toBe("render")
    expect(rendered.cells.every((cell: any) => cell.status !== "busy")).toBe(true)

    ws.close()
  })
})

describe("POST /interrupt", () => {
  test("reports ok even with no kernel running (a no-op write)", async () => {
    const response = await fetch(`${baseUrl}/interrupt`, { method: "POST" })
    expect(await readOk(response)).toBe(true)
  })
})

describe("POST /cursor", () => {
  test("accepts a cursor update and reports ok", async () => {
    const response = await fetch(`${baseUrl}/cursor`, {
      method: "POST",
      body: JSON.stringify({ index: 0 }),
    })
    expect(await readOk(response)).toBe(true)
  })
})

describe("GET /ws", () => {
  /**
   * Queues every message from the moment the socket is constructed, rather
   * than attaching a one-off listener after awaiting "open" - the server
   * sends its initial payload synchronously on connect, so a listener
   * attached only after "open" resolves can lose it to exactly this race
   * (confirmed directly: an earlier version of this test attached the
   * listener late and hung forever waiting for a message that had already
   * fired with nobody listening).
   */
  function connect(url: string) {
    const ws = new WebSocket(url)
    const queue: any[] = []
    const waiters: Array<(msg: any) => void> = []

    ws.on("message", (data) => {
      const parsed = JSON.parse(data.toString())
      const waiter = waiters.shift()
      if (waiter) waiter(parsed)
      else queue.push(parsed)
    })

    return {
      ws,
      ready: new Promise<void>((resolve) => ws.once("open", () => resolve())),
      nextMessage(): Promise<any> {
        const queued = queue.shift()
        if (queued !== undefined) return Promise.resolve(queued)
        return new Promise((resolve) => waiters.push(resolve))
      },
    }
  }

  test("sends the initial render payload on connect, then broadcasts /cursor updates", async () => {
    const { ws, ready, nextMessage } = connect(wsUrl)
    await ready

    const initial = await nextMessage()
    expect(initial.type).toBe("render")

    const broadcastReceived = nextMessage()
    await fetch(`${baseUrl}/cursor`, {
      method: "POST",
      body: JSON.stringify({ index: 3 }),
    })
    const cursorEvent = await broadcastReceived
    expect(cursorEvent).toEqual({ type: "cursor", index: 3 })

    ws.close()
  })
})

describe("unknown routes", () => {
  test("returns 404", async () => {
    const response = await fetch(`${baseUrl}/does-not-exist`)
    expect(response.status).toBe(404)
  })
})

describe("auth token", () => {
  let tokenServer: Awaited<ReturnType<typeof createServer>>
  let tokenBaseUrl: string
  let tokenWsUrl: string
  const token = "test-secret-token"

  beforeAll(async () => {
    tokenServer = await createServer(0, token)
    tokenBaseUrl = `http://127.0.0.1:${tokenServer.port}`
    tokenWsUrl = `ws://127.0.0.1:${tokenServer.port}/ws`
  })

  afterAll(() => {
    tokenServer.stop(true)
  })

  test("GET / and /health need no token", async () => {
    expect((await fetch(`${tokenBaseUrl}/`)).status).toBe(200)
    expect((await fetch(`${tokenBaseUrl}/health`)).status).toBe(200)
  })

  test("GET / embeds the token for the page's own client.js to use", async () => {
    const html = await (await fetch(`${tokenBaseUrl}/`)).text()
    expect(html).toContain(`window.__IPYNB_PEEK_TOKEN__=${JSON.stringify(token)}`)
  })

  test("rejects /cursor with no token", async () => {
    const response = await fetch(`${tokenBaseUrl}/cursor`, {
      method: "POST",
      body: JSON.stringify({ index: 0 }),
    })
    expect(response.status).toBe(401)
  })

  test("rejects /cursor with the wrong token", async () => {
    const response = await fetch(`${tokenBaseUrl}/cursor`, {
      method: "POST",
      body: JSON.stringify({ index: 0 }),
      headers: { "x-ipynb-peek-token": "wrong" },
    })
    expect(response.status).toBe(401)
  })

  test("accepts /cursor with the right token header", async () => {
    const response = await fetch(`${tokenBaseUrl}/cursor`, {
      method: "POST",
      body: JSON.stringify({ index: 0 }),
      headers: { "x-ipynb-peek-token": token },
    })
    expect(response.status).toBe(200)
  })

  test("rejects a /ws upgrade with no token", async () => {
    const ws = new WebSocket(tokenWsUrl)
    await new Promise<void>((resolve) => {
      ws.once("error", () => resolve())
      ws.once("close", () => resolve())
    })
    expect(ws.readyState).not.toBe(WebSocket.OPEN)
  })

  test("accepts a /ws upgrade with the token as a query param", async () => {
    const ws = new WebSocket(`${tokenWsUrl}?token=${token}`)
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve())
      ws.once("error", reject)
    })
    ws.close()
  })
})
