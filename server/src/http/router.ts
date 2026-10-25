import type http from "node:http"
import type { NotebookSession } from "../core/session"
import type { Commands } from "../core/commands"
import { hasLoopbackHost, isAuthorized } from "../core/security"
import { serveNotebookAsset } from "./asset-handler"
import { handleJsonRoute, readBody, sendJson } from "./respond"
import type { StaticHandler } from "./static-handler"

export type RouterDeps = {
  session: NotebookSession
  commands: Commands
  statics: StaticHandler
  themeCss: string
  token: string | undefined
}

export function createRouter({ session, commands, statics, themeCss, token }: RouterDeps) {
  return async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost")

    // A localhost bind alone is vulnerable to DNS rebinding: an attacker-owned
    // hostname can resolve to 127.0.0.1 and read the token-bearing root page
    // as its own origin. Reject non-loopback Host headers before serving
    // anything.
    if (!hasLoopbackHost(req))
      return sendJson(res, 403, { ok: false, error: "invalid host header" })

    if (url.pathname === "/") return statics.serveIndexHtml(res)

    if (url.pathname === "/style.css")
      return statics.serveAsset(res, "style.css", "text/css; charset=utf-8")

    if (url.pathname === "/theme.css") {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8" })
      return res.end(themeCss)
    }

    if (url.pathname === "/katex.min.css")
      return statics.serveAsset(res, "katex.min.css", "text/css; charset=utf-8")

    if (
      url.pathname.startsWith("/fonts/") &&
      /^[a-zA-Z0-9_.-]+\.woff2$/.test(url.pathname.slice(7))
    )
      return statics.serveAsset(res, url.pathname.slice(1), "font/woff2")

    if (url.pathname === "/client.js")
      return statics.serveAsset(res, "client.js", "text/javascript; charset=utf-8")

    if (["/math-renderer.js", "/chart-plotly.js", "/chart-vega.js"].includes(url.pathname))
      return statics.serveAsset(res, url.pathname.slice(1), "text/javascript; charset=utf-8")

    // Browsers ask for this unprompted; answering keeps the console clean.
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204)
      return res.end()
    }

    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "text/plain" })
      return res.end("ok")
    }

    if (!isAuthorized(req, url, token))
      return sendJson(res, 401, { ok: false, error: "unauthorized" })

    if (url.pathname === "/notebook-asset" && req.method === "GET")
      return serveNotebookAsset(res, session.notebookDir, url.searchParams.get("path"))

    if (url.pathname === "/render" && req.method === "POST") {
      return handleJsonRoute(res, async () => {
        const dirHeader = req.headers["x-notebook-dir"]
        const pathHeader = req.headers["x-notebook-path"]
        return commands.render(
          await readBody(req),
          typeof dirHeader === "string" ? dirHeader : undefined,
          typeof pathHeader === "string" ? pathHeader : undefined,
        )
      })
    }

    if (url.pathname === "/sync" && req.method === "POST") {
      return handleJsonRoute(res, async () => commands.sync(JSON.parse(await readBody(req))))
    }

    if (url.pathname === "/execute" && req.method === "POST") {
      return handleJsonRoute(res, async () => commands.execute(JSON.parse(await readBody(req))))
    }

    if (url.pathname === "/restart" && req.method === "POST") {
      commands.restart()
      return sendJson(res, 200, { ok: true })
    }

    if (url.pathname === "/input" && req.method === "POST") {
      return handleJsonRoute(res, async () => commands.input(JSON.parse(await readBody(req))))
    }

    if (url.pathname === "/interrupt" && req.method === "POST") {
      return handleJsonRoute(res, async () => commands.interrupt())
    }

    if (url.pathname === "/variables" && req.method === "POST") {
      return handleJsonRoute(res, async () => commands.variables())
    }

    if (url.pathname === "/export-result" && req.method === "POST") {
      return handleJsonRoute(res, async () => {
        const body: any = JSON.parse(await readBody(req))
        const known = session.resolveExport(String(body.id), body.html, body.error)
        if (!known) return { status: 404, body: { ok: false, error: "unknown export id" } }
      })
    }

    if (url.pathname === "/events") {
      res.writeHead(200, { "content-type": "application/x-ndjson" })
      const unsubscribe = session.subscribe((line) => {
        try {
          res.write(line + "\n")
        } catch {}
      })
      req.on("close", unsubscribe)
      return
    }

    if (url.pathname === "/cursor" && req.method === "POST") {
      return handleJsonRoute(res, async () => commands.cursor(JSON.parse(await readBody(req))))
    }

    res.writeHead(404)
    res.end("not found")
  }
}
