import { createServer as createDaemonServer, isMainModule, runDaemon } from "./core/daemon"

export { serveStdio } from "./core/daemon"

/**
 * Starts an isolated server instance. Static assets and kernel-bridge.mjs are
 * resolved next to this file, so this wrapper (not the daemon module) is what
 * fixes the asset location for both the src/ and bundled dist/ layouts.
 */
export function createServer(
  port: number = Number(process.env.IPYNB_PEEK_PORT ?? 0),
  token: string | undefined = process.env.IPYNB_PEEK_TOKEN,
) {
  return createDaemonServer(import.meta.url, port, token)
}

if (isMainModule(import.meta.url)) await runDaemon(import.meta.url)
