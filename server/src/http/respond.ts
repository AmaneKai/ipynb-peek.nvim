import type http from "node:http"

export function sendJson(res: http.ServerResponse, status: number, body: any) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

export function readBody(req: http.IncomingMessage): Promise<string> {
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
export async function handleJsonRoute(
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
