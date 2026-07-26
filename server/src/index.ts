import { renderNotebook, mergeCells, syncCells, type RenderedCell } from "./notebook"
import { handleIopub, reconcileBusyStatus, type PendingExec } from "./iopub"

let currentCells: RenderedCell[] = []
let notebookKernelName: string | undefined
let notebookDir: string | undefined

let wsServer: import("bun").Server<undefined>

function renderPayload(): string {
  return JSON.stringify({ type: "render", cells: currentCells })
}

function broadcastFull() {
  wsServer.publish("notebook", renderPayload())
}

function broadcastCell(index: number) {
  wsServer.publish(
    "notebook",
    JSON.stringify({ type: "cell_update", index, cell: currentCells[index] }),
  )
}

/**
 * Push channel back to Neovim (the reverse of everything else here - Neovim
 * is normally only ever a client POSTing in). Neovim keeps a long-lived
 * `curl -N /events` connection open and applies these as buffer edits, so
 * e.g. "+ Code" clicked in the browser can insert a real `# %%` cell into
 * the actual jupytext buffer.
 */
const eventSubscribers = new Set<(chunk: string) => void>()

function emitEvent(event: any) {
  const line = JSON.stringify(event) + "\n"

  for (const send of eventSubscribers) send(line)
}

let bridgeProc: ReturnType<typeof Bun.spawn> | null = null
let kernelReadyPromise: Promise<void> | null = null
let kernelReadyResolve: (() => void) | null = null
const pendingExecs = new Map<string, PendingExec>()

async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  while (true) {
    const { value, done } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    let newlineIndex: number

    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex)
      buffer = buffer.slice(newlineIndex + 1)

      if (line.trim()) onLine(line)
    }
  }
}

function writeToBridge(obj: any) {
  ;(bridgeProc?.stdin as any)?.write(JSON.stringify(obj) + "\n")
  ;(bridgeProc?.stdin as any)?.flush?.()
}

function startBridge(kernelName: string) {
  if (bridgeProc) return
  kernelReadyPromise = new Promise((resolve) => {
    kernelReadyResolve = resolve
  })

  const bridgePath = new URL("./kernel-bridge.mjs", import.meta.url).pathname
  bridgeProc = Bun.spawn(["node", bridgePath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })

  readLines(bridgeProc.stdout as ReadableStream<Uint8Array>, (line) => {
    let bridgeMessage: any

    try {
      bridgeMessage = JSON.parse(line)
    } catch (error) {
      console.error("[kernel-bridge] received malformed line on stdout:", line, error)
      return
    }

    if (bridgeMessage.type === "ready") kernelReadyResolve?.()
    else if (bridgeMessage.type === "iopub")
      handleIopub(
        bridgeMessage.parent_id,
        bridgeMessage.msg_type,
        bridgeMessage.content,
        currentCells,
        pendingExecs,
        broadcastCell,
      )
    else if (bridgeMessage.type === "error") console.error("[kernel-bridge]", bridgeMessage.message)
    else if (bridgeMessage.type === "kernel_exit")
      console.error("[kernel-bridge] kernel process exited with code", bridgeMessage.code)
  }).catch((error) => console.error("[kernel-bridge] stdout reader failed:", error))

  readLines(bridgeProc.stderr as ReadableStream<Uint8Array>, (line) => {
    console.error("[kernel-bridge stderr]", line)
  }).catch(() => {})

  writeToBridge({ cmd: "start", kernel_name: kernelName, cwd: notebookDir })
}

async function ensureKernelStarted(kernelName: string) {
  if (!bridgeProc) startBridge(kernelName)

  await kernelReadyPromise
}

function cleanupBridge() {
  try {
    bridgeProc?.kill()
  } catch {}

  bridgeProc = null
  kernelReadyPromise = null
  kernelReadyResolve = null
  pendingExecs.clear()
}
process.on("exit", cleanupBridge)
process.on("SIGINT", () => {
  cleanupBridge()
  process.exit(0)
})
process.on("SIGTERM", () => {
  cleanupBridge()
  process.exit(0)
})

/**
 * Runs `fn`, responding `{ ok: true }` on success and `{ ok: false, error }`
 * (500) if it throws. `fn` may return a Response itself to override that
 * default success response (used by /execute's 400 on an invalid index).
 */
async function handleJsonRoute(fn: () => Promise<Response | void>): Promise<Response> {
  try {
    const result = await fn()
    return result instanceof Response ? result : Response.json({ ok: true })
  } catch (error: any) {
    return Response.json({ ok: false, error: String(error?.stack ?? error) }, { status: 500 })
  }
}

/**
 * Builds and starts the Bun HTTP/WS server. Exported (rather than only run
 * as a top-level side effect) so integration tests can start an isolated
 * instance on a random port and tear it down afterward.
 */
export function createServer(port: number = Number(process.env.IPYNB_PEEK_PORT ?? 0)) {
  const server = Bun.serve({
    port,
    /**
     * Without this, Bun defaults to binding 0.0.0.0 - reachable from anyone
     * else on the same network, not just this machine. /execute runs
     * arbitrary code against a live kernel with no authentication, so this
     * has to stay localhost-only. Every caller (Neovim's curl requests, the
     * popup browser) already only ever targets 127.0.0.1.
     */
    hostname: "127.0.0.1",
    /**
     * Bun's default idle-connection timeout (~10s) would otherwise kill the
     * long-lived /events stream (Neovim's push channel) the moment nothing
     * happens for a while - which is most of the time, since it's only used
     * for occasional browser-originated actions like "+ Code".
     */
    idleTimeout: 255,
    async fetch(req, server) {
      const url = new URL(req.url)

      if (url.pathname === "/")
        return new Response(Bun.file(new URL("./index.html", import.meta.url)))

      if (url.pathname === "/style.css")
        return new Response(Bun.file(new URL("./style.css", import.meta.url)))

      if (url.pathname === "/client.js")
        return new Response(Bun.file(new URL("./client.js", import.meta.url)))

      if (url.pathname === "/health") return new Response("ok")

      if (url.pathname === "/ws") {
        if (server.upgrade(req)) return undefined

        return new Response("upgrade failed", { status: 400 })
      }

      if (url.pathname === "/render" && req.method === "POST") {
        return handleJsonRoute(async () => {
          const dirHeader = req.headers.get("x-notebook-dir")
          if (dirHeader) notebookDir = dirHeader
          const raw = await req.text()
          const nb = JSON.parse(raw)
          notebookKernelName = nb.metadata?.kernelspec?.name ?? notebookKernelName
          currentCells = mergeCells(currentCells, renderNotebook(nb))
          reconcileBusyStatus(currentCells, pendingExecs)
          broadcastFull()
        })
      }

      if (url.pathname === "/sync" && req.method === "POST") {
        return handleJsonRoute(async () => {
          const body: any = await req.json()
          currentCells = syncCells(currentCells, body.cells ?? [])
          reconcileBusyStatus(currentCells, pendingExecs)
          broadcastFull()
        })
      }

      if (url.pathname === "/execute" && req.method === "POST") {
        return handleJsonRoute(async () => {
          const body: any = await req.json()
          const index = body.index
          const code = body.code ?? ""

          if (typeof index !== "number" || !currentCells[index])
            return Response.json({ ok: false, error: "invalid cell index" }, { status: 400 })

          await ensureKernelStarted(notebookKernelName || "python3")

          const msgId = crypto.randomUUID()
          pendingExecs.set(msgId, { index, source: currentCells[index].source })
          currentCells[index].outputs = []
          currentCells[index].status = "busy"
          currentCells[index].started_at = Date.now()
          currentCells[index].duration_ms = undefined
          broadcastCell(index)

          writeToBridge({ cmd: "execute", id: msgId, code })
        })
      }

      if (url.pathname === "/restart" && req.method === "POST") {
        cleanupBridge()

        for (const cell of currentCells) {
          if (cell.status === "busy") cell.status = "idle"
        }

        broadcastFull()
        return Response.json({ ok: true })
      }

      if (url.pathname === "/events") {
        let send: (chunk: string) => void = () => {}
        const stream = new ReadableStream({
          start(controller) {
            send = (chunk: string) => {
              try {
                controller.enqueue(new TextEncoder().encode(chunk))
              } catch {}
            }
            eventSubscribers.add(send)
          },
          cancel() {
            eventSubscribers.delete(send)
          },
        })
        return new Response(stream, {
          headers: { "content-type": "application/x-ndjson" },
        })
      }

      if (url.pathname === "/cursor" && req.method === "POST") {
        return handleJsonRoute(async () => {
          const body: any = await req.json()
          server.publish("notebook", JSON.stringify({ type: "cursor", index: body.index }))
        })
      }

      return new Response("not found", { status: 404 })
    },
    websocket: {
      open(ws) {
        ws.subscribe("notebook")
        ws.send(renderPayload())
      },
      message(_ws, message) {
        try {
          const parsedMessage = JSON.parse(String(message))
          if (parsedMessage.type === "insert_cell") {
            emitEvent({
              type: "insert_cell",
              after_index: parsedMessage.after_index,
              cell_type: parsedMessage.cell_type,
            })
          } else if (parsedMessage.type === "delete_cell") {
            emitEvent({ type: "delete_cell", index: parsedMessage.index })
          }
        } catch (error) {
          console.error(
            "[ipynb-peek] received malformed websocket message from client:",
            message,
            error,
          )
        }
      },
      close(ws) {
        ws.unsubscribe("notebook")
      },
    },
  })

  wsServer = server
  return server
}

if (import.meta.main) {
  const server = createServer()

  /**
   * Neovim reads these lines from stdout to confirm the server is up, learn
   * the port (in case IPYNB_PEEK_PORT=0 was used for auto-assign), and know
   * which URL to open the popup browser window at.
   */
  console.log(`IPYNB_PEEK_PORT=${server.port}`)
  console.log(`IPYNB_PEEK_URL=http://127.0.0.1:${server.port}/`)
}
