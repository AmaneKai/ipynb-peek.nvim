import http from "node:http"
import { fileURLToPath } from "node:url"
import readline from "node:readline"
import { randomBytes } from "node:crypto"
import { NotebookSession } from "./session"
import { createCommands, type CommandResult, type Commands } from "./commands"
import { KernelCoordinator } from "../kernel/coordinator"
import { createRouter } from "../http/router"
import { createStaticHandler } from "../http/static-handler"
import { sendJson } from "../http/respond"
import { attachWebSocketGateway } from "../ws/gateway"
import { buildThemeCss } from "../themes"

export type RunningServer = {
  port: number
  session: NotebookSession
  commands: Commands
  stop: (force?: boolean) => void
}

/**
 * Builds and starts the HTTP/WS server with its own isolated session and
 * kernel. Exported (rather than only run as a top-level side effect) so
 * integration tests can start isolated instances on random ports and tear
 * them down afterward. Returns a Promise because the actual bound port
 * (especially with port 0 for auto-assign) isn't known until the underlying
 * socket is actually listening.
 *
 * `entryUrl` is the import.meta.url of the entry module: static assets and
 * kernel-bridge.mjs sit next to it, both in src/ and in the dist/ bundle.
 */
export function createServer(
  entryUrl: string,
  port: number,
  token: string | undefined,
): Promise<RunningServer> {
  const session = new NotebookSession()
  const kernel = new KernelCoordinator(session, new URL("./kernel-bridge.mjs", entryUrl))
  const commands = createCommands(session, kernel)
  const handleRequest = createRouter({
    session,
    commands,
    statics: createStaticHandler(new URL("./", entryUrl), token),
    // IPYNB_PEEK_THEME is fixed for the lifetime of this process (set once by
    // lua/ipynb-peek/server.lua when it spawns this server, from
    // M.config.theme) - computed once here rather than per-request.
    themeCss: buildThemeCss(process.env.IPYNB_PEEK_THEME),
    token,
  })

  const httpServer = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      console.error("[ipynb-peek] unhandled request error:", error)
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error?.stack ?? error) })
    })
  })

  /**
   * Disables Node's socket-inactivity handling entirely rather than picking
   * a generous-but-still-finite value - the long-lived /events stream can
   * legitimately sit with zero bytes flowing for a long time, since it's only
   * used for occasional browser-originated actions like "+ Code".
   */
  httpServer.timeout = 0
  httpServer.keepAliveTimeout = 0

  const wss = attachWebSocketGateway(httpServer, session, token)

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject)
    httpServer.listen(port, "127.0.0.1", () => {
      httpServer.removeListener("error", reject)
      const address = httpServer.address()
      const actualPort = typeof address === "object" && address ? address.port : port

      resolve({
        port: actualPort,
        session,
        commands,
        stop(force = false) {
          kernel.dispose()
          if (force) {
            for (const ws of session.wsClients) ws.terminate()
            httpServer.closeAllConnections()
          }
          wss.close()
          httpServer.close()
          session.reset()
        },
      })
    })
  })
}

/**
 * Neovim's end of the protocol: newline-delimited JSON commands on `input`
 * ({ id?, type, ... }), each answered with { type: "response", id, ok,
 * error? } on `write`; server-initiated events (insert_cell, cell_status,
 * ...) go out on the same stream. Ordered commands (render/sync/execute/
 * cursor) run one at a time in arrival order, so a debounced sync can never
 * overtake the execute that follows it; restart/interrupt/input skip that
 * queue, since they must work while an execute is still waiting on a slow
 * kernel start.
 */
export function serveStdio(
  input: NodeJS.ReadableStream,
  write: (line: string) => void,
  session: NotebookSession,
  commands: Commands,
) {
  const respond = (id: unknown, result: CommandResult | undefined, error?: unknown) => {
    if (id === undefined) return
    if (error !== undefined)
      write(
        JSON.stringify({
          type: "response",
          id,
          ok: false,
          error: String((error as any)?.stack ?? error),
        }),
      )
    else if (result) write(JSON.stringify({ type: "response", id, ...result.body }))
    else write(JSON.stringify({ type: "response", id, ok: true }))
  }

  const dispatch = async (msg: any): Promise<CommandResult> => {
    switch (msg.type) {
      case "render":
        return commands.render(String(msg.notebook ?? ""), msg.dir, msg.path)
      case "sync":
        return commands.sync(msg)
      case "execute":
        return commands.execute(msg)
      case "cursor":
        return commands.cursor(msg)
      case "restart":
        return commands.restart()
      case "input":
        return commands.input(msg)
      case "interrupt":
        return commands.interrupt()
      case "theme":
        return commands.theme(msg)
      case "variables":
        return commands.variables()
      case "kernels":
        return commands.kernels()
      case "select_kernel":
        return commands.selectKernel(msg)
      case "export":
        return commands.export(msg)
      case "print":
        return commands.print()
      default:
        return { status: 400, body: { ok: false, error: `unknown command: ${msg.type}` } }
    }
  }
  // variables/export wait on the kernel or the browser; they must not block
  // the ordered queue behind them (or an interrupt behind them).
  const unordered = new Set([
    "restart",
    "interrupt",
    "input",
    "variables",
    "kernels",
    "select_kernel",
    "export",
    "print",
  ])

  let queue: Promise<void> = Promise.resolve()
  const rl = readline.createInterface({ input })
  rl.on("line", (line) => {
    if (!line.trim()) return
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch (error) {
      console.error("[ipynb-peek] received malformed command on stdin:", line, error)
      return
    }
    const run = () =>
      dispatch(msg).then(
        (result) => respond(msg.id, result),
        (error) => respond(msg.id, undefined, error),
      )
    if (unordered.has(msg.type)) void run()
    else queue = queue.then(run)
  })

  const unsubscribe = session.subscribe(write)
  return {
    closed: new Promise<void>((resolve) => rl.once("close", resolve)),
    stop() {
      unsubscribe()
      rl.close()
    },
  }
}

/** The process entry point: HTTP/WS server plus the stdio channel to Neovim. */
export async function runDaemon(entryUrl: string) {
  // Generate the token in the server process that is already starting. The
  // old Lua-side flow synchronously launched and waited for a throwaway Node
  // process solely for randomBytes(), then launched Node again for the real
  // server; on a cold filesystem that nearly doubled startup work.
  const token = process.env.IPYNB_PEEK_TOKEN || randomBytes(32).toString("hex")
  const server = await createServer(entryUrl, Number(process.env.IPYNB_PEEK_PORT ?? 0), token)
  const stdio = serveStdio(
    process.stdin,
    (line) => process.stdout.write(line + "\n"),
    server.session,
    server.commands,
  )

  const shutdown = () => {
    server.stop(true)
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)

  /**
   * Neovim learns the port/token/URL from this single event rather than by
   * scraping stdout lines, and opens the popup the moment it arrives.
   */
  process.stdout.write(
    JSON.stringify({
      type: "ready",
      port: server.port,
      token,
      url: `http://127.0.0.1:${server.port}/`,
    }) + "\n",
  )

  // Neovim owning our stdin means its closing is the signal that it's gone
  // (including a crash) - shut down rather than leave an orphaned server and
  // kernel behind.
  void stdio.closed.then(shutdown)
}

export function isMainModule(entryUrl: string): boolean {
  return Boolean(
    (import.meta as any).main || (process.argv[1] && fileURLToPath(entryUrl) === process.argv[1]),
  )
}
