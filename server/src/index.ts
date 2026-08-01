import http from "node:http"
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import readline from "node:readline"
import { WebSocketServer, WebSocket } from "ws"
import {
  renderNotebook,
  mergeCells,
  syncCells,
  patchNotebookOutputs,
  cellStatusInfo,
  type RenderedCell,
} from "./notebook"
import { handleIopub, reconcileBusyStatus, type PendingExec } from "./iopub"
import { writeNotebookFile } from "./persist"
import { buildThemeCss } from "./themes"

let currentCells: RenderedCell[] = []
let currentNotebookJson: any = null
let notebookKernelName: string | undefined
let notebookDir: string | undefined
let notebookPath: string | undefined

/**
 * Reassigned to a fresh Set at the top of each createServer() call (mainly
 * so repeated calls in tests don't leak clients across instances) - the
 * broadcast helpers below are defined outside createServer and close over
 * this binding, mirroring how they used to close over Bun's `wsServer`.
 */
let wsClients = new Set<WebSocket>()

/**
 * Reassigned at the top of each createServer() call, from
 * IPYNB_PEEK_TOKEN (set once by lua/ipynb-peek/server.lua when it spawns
 * this server, a fresh random value per session). Guards every
 * state-changing route and the /ws upgrade against any other page the
 * user happens to have open in the same browser: without this, that page
 * could POST to /execute (or open its own /ws) and run arbitrary code in
 * the user's kernel purely by knowing/scanning the port - binding to
 * 127.0.0.1 alone doesn't stop same-machine, cross-origin requests. Left
 * unset (undefined) when the server is started directly - e.g. by the
 * integration tests below, or a maintainer running `npm start` by hand -
 * so auth is opt-in for those cases rather than a hard requirement.
 */
let authToken: string | undefined

function isAuthorized(req: http.IncomingMessage, url: URL): boolean {
  if (!authToken) return true
  const header = req.headers["x-ipynb-peek-token"]
  if (typeof header === "string" && header === authToken) return true
  return url.searchParams.get("token") === authToken
}

function renderPayload(): string {
  return JSON.stringify({ type: "render", cells: currentCells })
}

function broadcast(payload: string) {
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload)
  }
}

/**
 * Also pushes a bulk in-buffer status snapshot to Neovim over /events, so
 * the sign-column icon/virtual-text on each cell's marker line stays
 * correct after a full re-render/sync/restart, not just after individual
 * cell updates (see broadcastCell) - covers a shrunk/reordered cell list,
 * which a single-cell event can't safely reconcile on its own.
 */
function broadcastFull() {
  broadcast(renderPayload())
  emitEvent({ type: "cells_status", cells: currentCells.map(cellStatusInfo) })
}

/**
 * Also pushes a single-cell status update to Neovim over /events (see
 * broadcastFull for the bulk counterpart) - this is what lands the
 * sign-column icon/virtual-text change onto the right buffer line the
 * moment a cell goes busy, streams output, errors, or finishes.
 */
function broadcastCell(index: number) {
  broadcast(JSON.stringify({ type: "cell_update", index, cell: currentCells[index] }))
  emitEvent({ type: "cell_status", ...cellStatusInfo(currentCells[index], index) })
}

/**
 * Writes execution results into the real .ipynb file right after a cell
 * settles, rather than waiting for an explicit save. jupytext's percent
 * format has no channel for outputs at all - without this, results computed
 * here only ever exist in this server's memory and the browser popup,
 * never in the file itself, so tools like `jupyter nbconvert` would always
 * see empty outputs. jupytext.vim's own --update save mode preserves
 * whatever's already on disk for a cell whose source hasn't changed, so
 * writing here is enough for those results to survive every later save.
 * Best-effort and non-fatal: a disk write failing here shouldn't break the
 * live preview.
 */
async function persistOutputsToDisk() {
  if (!notebookPath || !currentNotebookJson) return

  try {
    patchNotebookOutputs(currentNotebookJson, currentCells)
    await writeNotebookFile(notebookPath, currentNotebookJson)
  } catch (error) {
    console.error("[ipynb-peek] failed to persist outputs to disk:", error)
  }
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

let bridgeProc: ReturnType<typeof spawn> | null = null
let kernelReadyPromise: Promise<void> | null = null
let kernelReadyResolve: (() => void) | null = null
const pendingExecs = new Map<string, PendingExec>()

/**
 * Node child-process stdout/stderr are the same kind of stream
 * kernel-bridge.mjs's own stdin already is - readline is the exact pattern
 * that file already uses for itself, reused here rather than hand-rolling a
 * decoder/buffer loop against a Web ReadableStream.
 */
function readLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void) {
  const rl = readline.createInterface({ input: stream })
  rl.on("line", (line) => {
    if (line.trim()) onLine(line)
  })
}

function writeToBridge(obj: any) {
  bridgeProc?.stdin?.write(JSON.stringify(obj) + "\n")
}

function startBridge(kernelName: string) {
  if (bridgeProc) return
  kernelReadyPromise = new Promise((resolve) => {
    kernelReadyResolve = resolve
  })

  const bridgePath = fileURLToPath(new URL("./kernel-bridge.mjs", import.meta.url))
  bridgeProc = spawn("node", [bridgePath])

  readLines(bridgeProc.stdout!, (line) => {
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
        (index) => {
          broadcastCell(index)
          if (currentCells[index]?.status === "idle") void persistOutputsToDisk()
        },
      )
    else if (bridgeMessage.type === "error") console.error("[kernel-bridge]", bridgeMessage.message)
    else if (bridgeMessage.type === "kernel_exit")
      console.error("[kernel-bridge] kernel process exited with code", bridgeMessage.code)
  })
  bridgeProc.stdout!.on("error", (error) =>
    console.error("[kernel-bridge] stdout reader failed:", error),
  )

  readLines(bridgeProc.stderr!, (line) => {
    console.error("[kernel-bridge stderr]", line)
  })
  bridgeProc.stderr!.on("error", () => {})

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

function sendJson(res: http.ServerResponse, status: number, body: any) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => resolve(body))
    req.on("error", reject)
  })
}

/**
 * Runs `fn`, responding `{ ok: true }` on success and `{ ok: false, error }`
 * (500) if it throws. `fn` may return `{ status, body }` itself to override
 * that default success response (used by /execute's 400 on an invalid
 * index).
 */
async function handleJsonRoute(
  res: http.ServerResponse,
  fn: () => Promise<{ status: number; body: any } | void>,
): Promise<void> {
  try {
    const override = await fn()
    if (override) sendJson(res, override.status, override.body)
    else sendJson(res, 200, { ok: true })
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: String(error?.stack ?? error) })
  }
}

function serveAsset(res: http.ServerResponse, filename: string, contentType: string) {
  res.writeHead(200, { "content-type": contentType })
  res.end(readFileSync(new URL(`./${filename}`, import.meta.url)))
}

/**
 * IPYNB_PEEK_THEME is fixed for the lifetime of this process (set once by
 * lua/ipynb-peek/server.lua when it spawns this server, from M.config.theme)
 * - computed once here rather than per-request.
 */
const themeCss = buildThemeCss(process.env.IPYNB_PEEK_THEME)

/**
 * Injects the theme's `:root { --ipynb-x: ... }` block, and the auth token
 * the page's own client.js needs to open its /ws connection, into
 * index.html before serving it. Safe to embed unauthenticated: a
 * cross-origin page can navigate/iframe this URL but can't read the
 * response body or reach into the iframe's DOM (Same-Origin Policy), so
 * the token never leaves this page's own JS context.
 */
function serveIndexHtml(res: http.ServerResponse) {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8")
  const injected = html.replace(
    "</head>",
    `<style>${themeCss}</style>\n` +
      `<script>window.__IPYNB_PEEK_TOKEN__=${JSON.stringify(authToken ?? "")}</script>\n</head>`,
  )
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
  res.end(injected)
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost")

  if (url.pathname === "/") return serveIndexHtml(res)

  if (url.pathname === "/style.css") return serveAsset(res, "style.css", "text/css; charset=utf-8")

  if (url.pathname === "/client.js")
    return serveAsset(res, "client.js", "text/javascript; charset=utf-8")

  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "text/plain" })
    return res.end("ok")
  }

  /**
   * Everything below here changes state or exposes kernel access - gated
   * on the shared token (see isAuthorized above) so no other page the user
   * has open can drive it.
   */
  if (!isAuthorized(req, url)) return sendJson(res, 401, { ok: false, error: "unauthorized" })

  if (url.pathname === "/render" && req.method === "POST") {
    return handleJsonRoute(res, async () => {
      const dirHeader = req.headers["x-notebook-dir"]
      if (typeof dirHeader === "string") notebookDir = dirHeader
      const pathHeader = req.headers["x-notebook-path"]
      if (typeof pathHeader === "string") notebookPath = pathHeader
      const raw = await readBody(req)
      const nb = JSON.parse(raw)
      notebookKernelName = nb.metadata?.kernelspec?.name ?? notebookKernelName
      currentNotebookJson = nb
      currentCells = mergeCells(currentCells, renderNotebook(nb))
      reconcileBusyStatus(currentCells, pendingExecs)
      broadcastFull()
    })
  }

  if (url.pathname === "/sync" && req.method === "POST") {
    return handleJsonRoute(res, async () => {
      const body: any = JSON.parse(await readBody(req))
      currentCells = syncCells(currentCells, body.cells ?? [])
      reconcileBusyStatus(currentCells, pendingExecs)
      broadcastFull()
    })
  }

  if (url.pathname === "/execute" && req.method === "POST") {
    return handleJsonRoute(res, async () => {
      const body: any = JSON.parse(await readBody(req))
      const index = body.index
      const code = body.code ?? ""

      if (typeof index !== "number" || !currentCells[index])
        return { status: 400, body: { ok: false, error: "invalid cell index" } }

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
    return sendJson(res, 200, { ok: true })
  }

  if (url.pathname === "/interrupt" && req.method === "POST") {
    return handleJsonRoute(res, async () => {
      writeToBridge({ cmd: "interrupt" })
    })
  }

  if (url.pathname === "/events") {
    res.writeHead(200, { "content-type": "application/x-ndjson" })
    const send = (chunk: string) => {
      try {
        res.write(chunk)
      } catch {}
    }
    eventSubscribers.add(send)
    req.on("close", () => eventSubscribers.delete(send))
    return
  }

  if (url.pathname === "/cursor" && req.method === "POST") {
    return handleJsonRoute(res, async () => {
      const body: any = JSON.parse(await readBody(req))
      broadcast(JSON.stringify({ type: "cursor", index: body.index }))
    })
  }

  res.writeHead(404)
  res.end("not found")
}

/**
 * Builds and starts the HTTP/WS server. Exported (rather than only run as a
 * top-level side effect) so integration tests can start an isolated
 * instance on a random port and tear it down afterward. Returns a Promise
 * because the actual bound port (especially with IPYNB_PEEK_PORT=0 for
 * auto-assign) isn't known until the underlying socket is actually
 * listening, unlike Bun.serve's synchronous .port.
 */
export function createServer(
  port: number = Number(process.env.IPYNB_PEEK_PORT ?? 0),
  token: string | undefined = process.env.IPYNB_PEEK_TOKEN,
): Promise<{ port: number; stop: (force?: boolean) => void }> {
  wsClients = new Set()
  authToken = token

  const httpServer = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      console.error("[ipynb-peek] unhandled request error:", error)
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error?.stack ?? error) })
    })
  })

  /**
   * Disables Node's socket-inactivity handling entirely rather than picking
   * a generous-but-still-finite value - the long-lived /events stream
   * (Neovim's push channel) can legitimately sit with zero bytes flowing
   * for a long time, since it's only used for occasional browser-originated
   * actions like "+ Code".
   */
  httpServer.timeout = 0
  httpServer.keepAliveTimeout = 0

  const wss = new WebSocketServer({ noServer: true })

  wss.on("connection", (ws: WebSocket) => {
    wsClients.add(ws)
    ws.send(renderPayload())

    ws.on("message", (data) => {
      try {
        const parsedMessage = JSON.parse(data.toString())
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
          data,
          error,
        )
      }
    })

    ws.on("close", () => wsClients.delete(ws))
  })

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    if (url.pathname !== "/ws" || !isAuthorized(req, url)) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req)
    })
  })

  return new Promise((resolve) => {
    httpServer.listen(port, "127.0.0.1", () => {
      const address = httpServer.address()
      const actualPort = typeof address === "object" && address ? address.port : port

      resolve({
        port: actualPort,
        stop(force = false) {
          if (force) {
            for (const ws of wsClients) ws.terminate()
            httpServer.closeAllConnections()
          }
          wss.close()
          httpServer.close()
        },
      })
    })
  })
}

if (import.meta.main) {
  const server = await createServer()

  /**
   * Neovim reads these lines from stdout to confirm the server is up, learn
   * the port (in case IPYNB_PEEK_PORT=0 was used for auto-assign), and know
   * which URL to open the popup browser window at.
   */
  console.log(`IPYNB_PEEK_PORT=${server.port}`)
  console.log(`IPYNB_PEEK_URL=http://127.0.0.1:${server.port}/`)
}
