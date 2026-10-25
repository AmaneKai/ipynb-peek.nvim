import type http from "node:http"

export function hasLoopbackHost(req: http.IncomingMessage): boolean {
  const host = req.headers.host
  if (!host) return false
  try {
    const hostname = new URL(`http://${host}`).hostname
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]"
  } catch {
    return false
  }
}

/**
 * Guards every state-changing route and the /ws upgrade against any other
 * page the user happens to have open in the same browser: without this, that
 * page could POST to /execute (or open its own /ws) and run arbitrary code in
 * the user's kernel purely by knowing/scanning the port - binding to
 * 127.0.0.1 alone doesn't stop same-machine, cross-origin requests. `token`
 * is undefined only when createServer() is called directly without one (as
 * some integration tests do), so that programmatic API stays convenient
 * without weakening the real CLI path.
 */
export function isAuthorized(
  req: http.IncomingMessage,
  url: URL,
  token: string | undefined,
): boolean {
  if (!token) return true
  const header = req.headers["x-ipynb-peek-token"]
  if (typeof header === "string" && header === token) return true
  return url.searchParams.get("token") === token
}

/**
 * Browsers always send Origin on a WebSocket handshake, and unlike fetch,
 * cross-origin WebSockets are not subject to CORS - so without this check any
 * page could open /ws if it ever learned the token. A missing Origin means a
 * non-browser client, which the token alone already gates.
 */
export function isSameOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}
