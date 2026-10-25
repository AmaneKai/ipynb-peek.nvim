import type http from "node:http"
import { WebSocketServer, type WebSocket } from "ws"
import { isCellDeletable } from "../notebook"
import type { NotebookSession } from "../core/session"
import { hasLoopbackHost, isAuthorized, isSameOrigin } from "../core/security"

function isIndex(value: unknown, length: number): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) < length
}

/**
 * Accepts browser websocket connections on /ws, keeps them in the session's
 * client set, and turns the browser's "+ Code"/delete actions into events for
 * Neovim. Returns the server so the caller can close it.
 */
export function attachWebSocketGateway(
  httpServer: http.Server,
  session: NotebookSession,
  token: string | undefined,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true })

  wss.on("connection", (ws: WebSocket) => {
    session.wsClients.add(ws)
    ws.send(session.renderPayload())
    if (session.theme !== null) ws.send(session.themePayload())
    // A cell blocked on input() before this client connected (or while a
    // previous one was disconnected) would otherwise look like it's just
    // stuck busy forever, with no visible prompt to unblock it.
    if (session.pendingInputRequest) ws.send(session.inputRequestPayload())

    ws.on("message", (data) => {
      try {
        const parsedMessage = JSON.parse(data.toString())
        if (
          parsedMessage.type === "insert_cell" &&
          Number.isInteger(parsedMessage.after_index) &&
          parsedMessage.after_index >= -1 &&
          (parsedMessage.cell_type === "code" || parsedMessage.cell_type === "markdown")
        ) {
          session.emitEvent({
            type: "insert_cell",
            after_index: parsedMessage.after_index,
            cell_type: parsedMessage.cell_type,
          })
        } else if (
          parsedMessage.type === "jump_cell_line" &&
          isIndex(parsedMessage.cell_index, session.cells.length) &&
          Number.isInteger(parsedMessage.line_offset) &&
          parsedMessage.line_offset >= 1
        ) {
          session.emitEvent({
            type: "jump_cell_line",
            cell_index: parsedMessage.cell_index,
            line_offset: parsedMessage.line_offset,
          })
        } else if (
          parsedMessage.type === "goto_cell" &&
          isIndex(parsedMessage.index, session.cells.length)
        ) {
          session.emitEvent({ type: "goto_cell", index: parsedMessage.index })
        } else if (
          parsedMessage.type === "open_file" &&
          typeof parsedMessage.path === "string" &&
          parsedMessage.path.length > 0 &&
          parsedMessage.path.length < 4096 &&
          Number.isInteger(parsedMessage.line) &&
          parsedMessage.line >= 1
        ) {
          session.emitEvent({
            type: "open_file",
            path: parsedMessage.path,
            line: parsedMessage.line,
          })
        } else if (
          parsedMessage.type === "delete_cell" &&
          Number.isInteger(parsedMessage.index) &&
          parsedMessage.index >= 0 &&
          isCellDeletable(session.cells[parsedMessage.index])
        ) {
          session.emitEvent({ type: "delete_cell", index: parsedMessage.index })
        }
      } catch (error) {
        console.error("[ipynb-peek] received malformed websocket message from client:", data, error)
      }
    })

    ws.on("close", () => session.wsClients.delete(ws))
  })

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    if (
      !hasLoopbackHost(req) ||
      !isSameOrigin(req) ||
      url.pathname !== "/ws" ||
      !isAuthorized(req, url, token)
    ) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req)
    })
  })

  return wss
}
