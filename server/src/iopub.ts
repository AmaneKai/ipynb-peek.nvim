import { joinSource, stripAnsi, type RenderedCell } from "./notebook"

export function applyStatusMessage(
  cell: RenderedCell,
  content: any,
  parentId: string,
  pendingExecs: Map<string, number>,
) {
  if (content.execution_state === "busy") {
    cell.status = "busy"
  } else if (content.execution_state === "idle") {
    cell.status = "idle"
    cell.duration_ms = cell.started_at ? Date.now() - cell.started_at : undefined
    pendingExecs.delete(parentId)
  }
}

export function applyExecuteInputMessage(cell: RenderedCell, content: any) {
  if (typeof content.execution_count === "number") cell.execution_count = content.execution_count
}

export function applyStreamMessage(cell: RenderedCell, content: any) {
  cell.outputs.push({ kind: "text", content: joinSource(content.text) })
}

export function applyResultMessage(cell: RenderedCell, content: any, msgType: string) {
  const data = content.data ?? {}

  if (data["image/png"]) cell.outputs.push({ kind: "image", data: joinSource(data["image/png"]) })
  else if (data["text/html"])
    cell.outputs.push({ kind: "html", content: joinSource(data["text/html"]) })
  else if (data["text/plain"])
    cell.outputs.push({ kind: "text", content: joinSource(data["text/plain"]) })

  if (msgType === "execute_result" && typeof content.execution_count === "number")
    cell.execution_count = content.execution_count
}

export function applyErrorMessage(cell: RenderedCell, content: any) {
  const traceback = Array.isArray(content.traceback)
    ? content.traceback.join("\n")
    : `${content.ename}: ${content.evalue}`
  cell.outputs.push({ kind: "error", content: stripAnsi(traceback) })
}

export function applyClearOutputMessage(cell: RenderedCell) {
  cell.outputs = []
}

/**
 * Applies one iopub message from the kernel bridge to `currentCells` in
 * place. `pendingExecs` and `onCellUpdated` are injected rather than read
 * off module state, so this stays testable without a running server.
 */
export function handleIopub(
  parentId: string,
  msgType: string,
  content: any,
  currentCells: RenderedCell[],
  pendingExecs: Map<string, number>,
  onCellUpdated: (index: number) => void,
) {
  const index = pendingExecs.get(parentId)

  if (index === undefined) return

  const cell = currentCells[index]

  if (!cell) return

  switch (msgType) {
    case "status":
      applyStatusMessage(cell, content, parentId, pendingExecs)
      break
    case "execute_input":
      applyExecuteInputMessage(cell, content)
      break
    case "stream":
      applyStreamMessage(cell, content)
      break
    case "execute_result":
    case "display_data":
      applyResultMessage(cell, content, msgType)
      break
    case "error":
      applyErrorMessage(cell, content)
      break
    case "clear_output":
      applyClearOutputMessage(cell)
      break
    default:
      return
  }

  onCellUpdated(index)
}
