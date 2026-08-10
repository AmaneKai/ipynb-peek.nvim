import http from "node:http"
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { extname } from "node:path"
import readline from "node:readline"
import { WebSocketServer, WebSocket } from "ws"
import {
  renderNotebook,
  mergeCells,
  syncCells,
  patchNotebookOutputs,
  cellStatusInfo,
  isCellDeletable,
  type RenderedCell,
} from "./notebook"
import { handleIopub, reconcileBusyStatus, type PendingExec } from "./iopub"
import { updateNotebookFile } from "./persist"
import { buildThemeCss } from "./themes"
import { resolveNotebookAssetPath, AssetOutsideNotebookDirectoryError } from "./asset-path"

let currentCells: RenderedCell[] = []
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

function hasLoopbackHost(req: http.IncomingMessage): boolean {
  const host = req.headers.host
  if (!host) return false
  try {
    const hostname = new URL(`http://${host}`).hostname
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]"
  } catch {
    return false
  }
}

function isAuthorized(req: http.IncomingMessage, url: URL): boolean {
  if (!authToken) return true
  const header = req.headers["x-ipynb-peek-token"]
  if (typeof header === "string" && header === authToken) return true
  return url.searchParams.get("token") === authToken
}

/** Keep the exact nbformat copy used for persistence on the server. */
function publicCell(cell: RenderedCell): Omit<RenderedCell, "nbformat_outputs"> {
  const { nbformat_outputs: _nbformatOutputs, ...visibleCell } = cell
  return visibleCell
}

function renderPayload(): string {
  return JSON.stringify({ type: "render", cells: currentCells.map(publicCell) })
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
  broadcast(JSON.stringify({ type: "cell_update", index, cell: publicCell(currentCells[index]) }))
  emitEvent({ type: "cell_status", ...cellStatusInfo(currentCells[index], index) })
}

function broadcastSync(previousCells: RenderedCell[]) {
  if (previousCells.length !== currentCells.length) {
    broadcastFull()
    return
  }
  for (let index = 0; index < currentCells.length; index++) {
    const previous = previousCells[index]
    const current = currentCells[index]
    if (previous.source !== current.source || previous.cell_type !== current.cell_type)
      broadcastCell(index)
  }
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
  if (!notebookPath) return

  try {
    const path = notebookPath
    const cellsSnapshot = structuredClone(currentCells)
    await updateNotebookFile(path, (notebookJson) => {
      patchNotebookOutputs(notebookJson, cellsSnapshot)
    })
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
let kernelReadyReject: ((error: Error) => void) | null = null
const pendingExecs = new Map<string, PendingExec>()

/**
 * The kernel's outstanding input_request, if any - kept server-side (not
 * just fired once over the websocket) so a browser that reconnects (popup
 * closed and reopened, network blip) while a cell is blocked on input()
 * still sees the prompt instead of a cell that looks permanently busy with
 * no way to unblock it short of an interrupt. Cleared once answered or once
 * the kernel that owned it goes away (see cleanupBridge).
 */
let pendingInputRequest: { index: number | null; prompt: string; password: boolean } | null = null

function inputRequestPayload(): string {
  return JSON.stringify({ type: "input_request", ...pendingInputRequest })
}

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
  if (!bridgeProc?.stdin?.writable) throw new Error("kernel bridge is not available")
  bridgeProc.stdin.write(JSON.stringify(obj) + "\n")
}

function appendExecutionFailure(cell: RenderedCell, message: string) {
  cell.outputs.push({ kind: "error", content: message })
  cell.nbformat_outputs ??= []
  cell.nbformat_outputs.push({
    output_type: "error",
    ename: "KernelError",
    evalue: message,
    traceback: [message],
  })
}

function pendingCellIndex(pending: PendingExec): number | null {
  if (pending.id) {
    const idIndex = currentCells.findIndex((cell) => cell.id === pending.id)
    if (idIndex !== -1) return idIndex
  }
  if (currentCells[pending.index]?.source === pending.source) return pending.index
  const sourceIndex = currentCells.findIndex((cell) => cell.source === pending.source)
  return sourceIndex === -1 ? null : sourceIndex
}

function failPendingExecutions(message: string) {
  const updated = new Set<number>()

  for (const pending of pendingExecs.values()) {
    const index = pendingCellIndex(pending)
    if (index === null || updated.has(index)) continue
    const cell = currentCells[index]
    appendExecutionFailure(cell, message)
    cell.status = "idle"
    cell.duration_ms = cell.started_at ? Date.now() - cell.started_at : undefined
    updated.add(index)
  }
  pendingExecs.clear()
  for (const index of updated) broadcastCell(index)
}

function failBridge(proc: ReturnType<typeof spawn>, message: string) {
  if (bridgeProc !== proc) return
  kernelReadyReject?.(new Error(message))
  kernelReadyResolve = null
  kernelReadyReject = null
  bridgeProc = null
  kernelReadyPromise = null
  try {
    proc.kill()
  } catch {}
  failPendingExecutions(message)
}

function startBridge(kernelName: string) {
  if (bridgeProc) return
  kernelReadyPromise = new Promise((resolve, reject) => {
    kernelReadyResolve = resolve
    kernelReadyReject = reject
  })

  const bridgePath = fileURLToPath(new URL("./kernel-bridge.mjs", import.meta.url))
  const proc = spawn("node", [bridgePath])
  bridgeProc = proc

  readLines(proc.stdout!, (line) => {
    let bridgeMessage: any

    try {
      bridgeMessage = JSON.parse(line)
    } catch (error) {
      console.error("[kernel-bridge] received malformed line on stdout:", line, error)
      return
    }

    if (bridgeMessage.type === "ready") {
      kernelReadyResolve?.()
      kernelReadyResolve = null
      kernelReadyReject = null
    } else if (bridgeMessage.type === "iopub")
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
    else if (bridgeMessage.type === "input_request") {
      const pending = pendingExecs.get(bridgeMessage.parent_id)
      const index = pending ? pendingCellIndex(pending) : null
      pendingInputRequest = {
        index,
        prompt: String(bridgeMessage.prompt ?? ""),
        password: bridgeMessage.password === true,
      }
      broadcast(inputRequestPayload())
    } else if (bridgeMessage.type === "error") {
      const message = String(bridgeMessage.message ?? "kernel bridge error")
      if (bridgeMessage.operation === "start") failBridge(proc, message)
      else if (bridgeMessage.operation === "execute" && bridgeMessage.id) {
        const pending = pendingExecs.get(bridgeMessage.id)
        if (pending) {
          const index = pendingCellIndex(pending)
          pendingExecs.delete(bridgeMessage.id)
          if (index !== null) {
            const cell = currentCells[index]
            appendExecutionFailure(cell, message)
            cell.status = "idle"
            cell.duration_ms = cell.started_at ? Date.now() - cell.started_at : undefined
            broadcastCell(index)
          }
        }
      } else console.error("[kernel-bridge]", message)
    } else if (bridgeMessage.type === "kernel_exit") {
      const detail = bridgeMessage.stderr ? `: ${bridgeMessage.stderr}` : ""
      failBridge(proc, `kernel process exited with code ${bridgeMessage.code}${detail}`)
    }
  })
  proc.stdout!.on("error", (error) => failBridge(proc, `kernel bridge stdout failed: ${error}`))

  readLines(proc.stderr!, (line) => {
    console.error("[kernel-bridge stderr]", line)
  })
  proc.stderr!.on("error", () => {})
  proc.on("error", (error) => failBridge(proc, `failed to start kernel bridge: ${error.message}`))
  proc.on("exit", (code, signal) => {
    failBridge(proc, `kernel bridge exited (${signal ?? code ?? "unknown"})`)
  })

  writeToBridge({ cmd: "start", kernel_name: kernelName, cwd: notebookDir })
}

async function ensureKernelStarted(kernelName: string) {
  if (!bridgeProc) startBridge(kernelName)
  const ready = kernelReadyPromise
  if (!ready) throw new Error("kernel bridge failed to initialize")
  await ready
}

function cleanupBridge() {
  const proc = bridgeProc
  kernelReadyReject?.(new Error("kernel stopped"))
  kernelReadyResolve = null
  kernelReadyReject = null
  bridgeProc = null
  kernelReadyPromise = null
  try {
    proc?.kill()
  } catch {}
  pendingExecs.clear()
  pendingInputRequest = null
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
 * Injects the auth token the page's own client.js needs to open its /ws
 * connection into a meta element in index.html before serving it. Safe to
 * embed unauthenticated: a
 * cross-origin page can navigate/iframe this URL but can't read the
 * response body or reach into the iframe's DOM (Same-Origin Policy), so
 * the token never leaves this page's own JS context.
 */
function serveIndexHtml(res: http.ServerResponse) {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8")
  const injected = html.replace("__IPYNB_PEEK_TOKEN__", authToken ?? "")
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self' ws://127.0.0.1:*",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  })
  res.end(injected)
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost")

  // A localhost bind alone is vulnerable to DNS rebinding: an attacker-owned
  // hostname can resolve to 127.0.0.1 and read the token-bearing root page as
  // its own origin. Reject non-loopback Host headers before serving anything.
  if (!hasLoopbackHost(req)) return sendJson(res, 403, { ok: false, error: "invalid host header" })

  if (url.pathname === "/") return serveIndexHtml(res)

  if (url.pathname === "/style.css") return serveAsset(res, "style.css", "text/css; charset=utf-8")

  if (url.pathname === "/theme.css") {
    res.writeHead(200, { "content-type": "text/css; charset=utf-8" })
    return res.end(themeCss)
  }

  if (url.pathname === "/katex.min.css")
    return serveAsset(res, "katex.min.css", "text/css; charset=utf-8")

  if (url.pathname.startsWith("/fonts/") && /^[a-zA-Z0-9_.-]+\.woff2$/.test(url.pathname.slice(7)))
    return serveAsset(res, url.pathname.slice(1), "font/woff2")

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

  if (url.pathname === "/notebook-asset" && req.method === "GET") {
    const requested = url.searchParams.get("path")
    if (!notebookDir || !requested)
      return sendJson(res, 404, { ok: false, error: "notebook asset not found" })
    let assetPath: string
    try {
      assetPath = resolveNotebookAssetPath(notebookDir, requested)
    } catch (err) {
      if (err instanceof AssetOutsideNotebookDirectoryError)
        return sendJson(res, 403, { ok: false, error: "asset path leaves notebook directory" })
      return sendJson(res, 404, { ok: false, error: "notebook asset not found" })
    }
    const contentTypes: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
    }
    try {
      const contentType =
        contentTypes[extname(assetPath).toLowerCase()] ?? "application/octet-stream"
      res.writeHead(200, { "content-type": contentType, "x-content-type-options": "nosniff" })
      return res.end(readFileSync(assetPath))
    } catch {
      return sendJson(res, 404, { ok: false, error: "notebook asset not found" })
    }
  }

  if (url.pathname === "/render" && req.method === "POST") {
    return handleJsonRoute(res, async () => {
      const dirHeader = req.headers["x-notebook-dir"]
      if (typeof dirHeader === "string") notebookDir = dirHeader
      const pathHeader = req.headers["x-notebook-path"]
      if (typeof pathHeader === "string") notebookPath = pathHeader
      const raw = await readBody(req)
      const nb = JSON.parse(raw)
      notebookKernelName = nb.metadata?.kernelspec?.name ?? notebookKernelName
      currentCells = mergeCells(currentCells, renderNotebook(nb))
      reconcileBusyStatus(currentCells, pendingExecs)
      broadcastFull()
      await persistOutputsToDisk()
    })
  }

  if (url.pathname === "/sync" && req.method === "POST") {
    return handleJsonRoute(res, async () => {
      const body: any = JSON.parse(await readBody(req))
      const previousCells = currentCells
      currentCells = syncCells(currentCells, body.cells ?? [])
      reconcileBusyStatus(currentCells, pendingExecs)
      broadcastSync(previousCells)
    })
  }

  if (url.pathname === "/execute" && req.method === "POST") {
    return handleJsonRoute(res, async () => {
      const body: any = JSON.parse(await readBody(req))
      const index = body.index
      const code = body.code ?? ""

      if (
        typeof index !== "number" ||
        typeof code !== "string" ||
        currentCells[index]?.cell_type !== "code"
      )
        return { status: 400, body: { ok: false, error: "invalid cell index" } }

      await ensureKernelStarted(notebookKernelName || "python3")

      const msgId = crypto.randomUUID()
      // The execution request is the newest authoritative version of this
      // cell. A separately debounced /sync may still be in flight, so using
      // the server's older source here can make output impossible to resolve
      // as soon as that /sync lands while the cell is running.
      currentCells[index].source = code
      pendingExecs.set(msgId, { index, id: currentCells[index].id, source: code })
      currentCells[index].outputs = []
      currentCells[index].nbformat_outputs = []
      currentCells[index].status = "busy"
      // Not started_at: this only marks the request as submitted/queued.
      // applyStatusMessage stamps started_at once the kernel's own iopub
      // "busy" for this msg_id actually arrives, which is what keeps the
      // reported duration from including time spent queued behind another
      // still-running cell.
      currentCells[index].started_at = undefined
      currentCells[index].duration_ms = undefined
      broadcastCell(index)

      try {
        // Only offer stdin when a browser is actually connected to answer
        // it - otherwise a blocked input()/getpass() would hang the kernel
        // waiting on an input_reply nothing could ever send.
        writeToBridge({ cmd: "execute", id: msgId, code, allow_stdin: wsClients.size > 0 })
      } catch (error) {
        pendingExecs.delete(msgId)
        const message = String(error instanceof Error ? error.message : error)
        appendExecutionFailure(currentCells[index], message)
        currentCells[index].status = "idle"
        broadcastCell(index)
        throw error
      }
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

  if (url.pathname === "/input" && req.method === "POST") {
    if (!bridgeProc) return sendJson(res, 409, { ok: false, error: "no running kernel" })
    return handleJsonRoute(res, async () => {
      const body: any = JSON.parse(await readBody(req))
      writeToBridge({ cmd: "input_reply", value: String(body.value ?? "") })
      pendingInputRequest = null
    })
  }

  if (url.pathname === "/interrupt" && req.method === "POST") {
    if (!bridgeProc)
      return sendJson(res, 409, { ok: false, error: "no running kernel to interrupt" })
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
    // A cell blocked on input() before this client connected (or while a
    // previous one was disconnected) would otherwise look like it's just
    // stuck busy forever, with no visible prompt to unblock it.
    if (pendingInputRequest) ws.send(inputRequestPayload())

    ws.on("message", (data) => {
      try {
        const parsedMessage = JSON.parse(data.toString())
        if (
          parsedMessage.type === "insert_cell" &&
          Number.isInteger(parsedMessage.after_index) &&
          parsedMessage.after_index >= -1 &&
          (parsedMessage.cell_type === "code" || parsedMessage.cell_type === "markdown")
        ) {
          emitEvent({
            type: "insert_cell",
            after_index: parsedMessage.after_index,
            cell_type: parsedMessage.cell_type,
          })
        } else if (
          parsedMessage.type === "delete_cell" &&
          Number.isInteger(parsedMessage.index) &&
          parsedMessage.index >= 0 &&
          isCellDeletable(currentCells[parsedMessage.index])
        ) {
          emitEvent({ type: "delete_cell", index: parsedMessage.index })
        }
      } catch (error) {
        console.error("[ipynb-peek] received malformed websocket message from client:", data, error)
      }
    })

    ws.on("close", () => wsClients.delete(ws))
  })

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    if (!hasLoopbackHost(req) || url.pathname !== "/ws" || !isAuthorized(req, url)) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req)
    })
  })

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject)
    httpServer.listen(port, "127.0.0.1", () => {
      httpServer.removeListener("error", reject)
      const address = httpServer.address()
      const actualPort = typeof address === "object" && address ? address.port : port

      resolve({
        port: actualPort,
        stop(force = false) {
          cleanupBridge()
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
