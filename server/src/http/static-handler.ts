import type http from "node:http"
import { PRESET_NAMES } from "../themes"
import { existsSync, readFileSync } from "node:fs"

export type StaticHandler = {
  serveIndexHtml(res: http.ServerResponse): void
  serveAsset(res: http.ServerResponse, filename: string, contentType: string): void
}

/**
 * In the dist/ bundle the browser modules sit next to the entry point; when
 * running from source (tests) they live under client/.
 */
const SOURCE_LAYOUT_ALIASES: Record<string, string> = {
  "client.js": "client/index.js",
  "math-renderer.js": "client/math-renderer.js",
  "chart-plotly.js": "client/chart-plotly.js",
  "chart-vega.js": "client/chart-vega.js",
}

function resolveAsset(assetBase: URL, filename: string): URL {
  const direct = new URL(`./${filename}`, assetBase)
  const alias = SOURCE_LAYOUT_ALIASES[filename]
  return alias && !existsSync(direct) ? new URL(`./${alias}`, assetBase) : direct
}

/**
 * Serves the page and its client assets from `assetBase` (the directory the
 * server entry point lives in - src/ when run from source, dist/ when run
 * from the committed bundle).
 */
export function createStaticHandler(assetBase: URL, token: string | undefined): StaticHandler {
  return {
    serveAsset(res, filename, contentType) {
      res.writeHead(200, { "content-type": contentType })
      res.end(readFileSync(resolveAsset(assetBase, filename)))
    },

    /**
     * Injects the auth token the page's own client.js needs to open its /ws
     * connection into a meta element in index.html before serving it. Safe to
     * embed unauthenticated: a cross-origin page can navigate/iframe this URL
     * but can't read the response body or reach into the iframe's DOM
     * (Same-Origin Policy), so the token never leaves this page's own JS
     * context.
     */
    serveIndexHtml(res) {
      const html = readFileSync(new URL("./index.html", assetBase), "utf8")
      const injected = html
        .replace("__IPYNB_PEEK_TOKEN__", token ?? "")
        .replace("__IPYNB_PEEK_THEMES__", PRESET_NAMES.join(","))
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
    },
  }
}
