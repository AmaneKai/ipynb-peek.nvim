import { realpathSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"

export class AssetOutsideNotebookDirectoryError extends Error {
  constructor() {
    super("asset path escapes the notebook directory")
    this.name = "AssetOutsideNotebookDirectoryError"
  }
}

export function resolveNotebookAssetPath(notebookDir: string, requestedPath: string): string {
  const root = realpathSync(resolve(notebookDir))
  const unresolvedAssetPath = resolve(root, requestedPath)
  const assetPath = realpathSync(unresolvedAssetPath)
  const pathFromRoot = relative(root, assetPath)
  const escapesRoot =
    pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)

  if (escapesRoot) {
    throw new AssetOutsideNotebookDirectoryError()
  }

  return assetPath
}
