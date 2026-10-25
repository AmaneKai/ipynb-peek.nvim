import type http from "node:http"
import { readFileSync } from "node:fs"
import { extname } from "node:path"
import { resolveNotebookAssetPath, AssetOutsideNotebookDirectoryError } from "../asset-path"
import { sendJson } from "./respond"

const contentTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
}

/** Streams a file from inside the notebook's directory (/notebook-asset). */
export function serveNotebookAsset(
  res: http.ServerResponse,
  notebookDir: string | undefined,
  requested: string | null,
) {
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
  try {
    const contentType = contentTypes[extname(assetPath).toLowerCase()] ?? "application/octet-stream"
    res.writeHead(200, { "content-type": contentType, "x-content-type-options": "nosniff" })
    return res.end(readFileSync(assetPath))
  } catch {
    return sendJson(res, 404, { ok: false, error: "notebook asset not found" })
  }
}
