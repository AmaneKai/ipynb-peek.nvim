import { joinSource, stripAnsi, appendOutput, imageSize, type RenderedCell } from "./notebook"

/**
 * What was actually submitted for execution - captured at /execute time so
 * a later iopub message can re-locate its cell even if `index` has since
 * gone stale (see resolveCellIndex).
 */
export type PendingExec = {
  index: number
  id?: string
  source: string
}

export function applyStatusMessage(
  cell: RenderedCell,
  content: any,
  parentId: string,
  pendingExecs: Map<string, PendingExec>,
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
  appendOutput(cell.outputs, {
    kind: "text",
    content: joinSource(content.text),
    stream: content.name === "stderr" ? "stderr" : "stdout",
  })
  cell.nbformat_outputs ??= []
  const stream = content.name === "stderr" ? "stderr" : "stdout"
  const text = joinSource(content.text)
  const last = cell.nbformat_outputs[cell.nbformat_outputs.length - 1]
  if (last?.output_type === "stream" && last.name === stream) {
    last.text = [joinSource(last.text) + text]
  } else {
    cell.nbformat_outputs.push({ output_type: "stream", name: stream, text: [text] })
  }
}

export function applyResultMessage(cell: RenderedCell, content: any, msgType: string) {
  const data = content.data ?? {}

  if (data["image/png"])
    cell.outputs.push({
      kind: "image",
      mime: "image/png",
      data: joinSource(data["image/png"]),
      ...imageSize(content, "image/png"),
    })
  else if (data["image/jpeg"])
    cell.outputs.push({
      kind: "image",
      mime: "image/jpeg",
      data: joinSource(data["image/jpeg"]),
      ...imageSize(content, "image/jpeg"),
    })
  else if (data["image/svg+xml"])
    cell.outputs.push({
      kind: "image",
      mime: "image/svg+xml",
      data: joinSource(data["image/svg+xml"]),
    })
  else if (data["text/html"])
    cell.outputs.push({ kind: "html", content: joinSource(data["text/html"]) })
  else if (data["text/latex"])
    cell.outputs.push({ kind: "latex", content: joinSource(data["text/latex"]) })
  else if (data["text/markdown"])
    cell.outputs.push({ kind: "markdown", content: joinSource(data["text/markdown"]) })
  else if (data["application/json"] !== undefined)
    cell.outputs.push({ kind: "text", content: JSON.stringify(data["application/json"], null, 2) })
  else if (data["text/plain"])
    cell.outputs.push({ kind: "text", content: joinSource(data["text/plain"]) })

  if (msgType === "execute_result" && typeof content.execution_count === "number")
    cell.execution_count = content.execution_count

  cell.nbformat_outputs ??= []
  cell.nbformat_outputs.push({
    output_type: msgType,
    data: structuredClone(data),
    metadata: structuredClone(content.metadata ?? {}),
    ...(msgType === "execute_result" ? { execution_count: content.execution_count ?? null } : {}),
  })
}

export function applyErrorMessage(cell: RenderedCell, content: any) {
  const traceback = Array.isArray(content.traceback)
    ? content.traceback.join("\n")
    : `${content.ename}: ${content.evalue}`
  cell.outputs.push({ kind: "error", content: stripAnsi(traceback) })
  cell.nbformat_outputs ??= []
  cell.nbformat_outputs.push({
    output_type: "error",
    ename: content.ename ?? "Error",
    evalue: content.evalue ?? "",
    traceback: Array.isArray(content.traceback) ? structuredClone(content.traceback) : [traceback],
  })
}

export function applyClearOutputMessage(cell: RenderedCell) {
  cell.outputs = []
  cell.nbformat_outputs = []
}

/**
 * `pending.index` is a snapshot of where the cell sat when /execute was
 * called - it goes stale the moment /sync or /render replaces currentCells
 * with a new array (live-typing sync, a save, a buffer reorder), all of
 * which can happen while a kernel execution is still in flight. Re-checking
 * the source at that index, and falling back to a source-text search when
 * it doesn't match, stops a live execution's output from landing on
 * whatever cell now happens to occupy the old index - including a cell the
 * user never ran at all.
 */
function resolveCellIndex(currentCells: RenderedCell[], pending: PendingExec): number | null {
  if (pending.id) {
    const idIndex = currentCells.findIndex((cell) => cell.id === pending.id)
    if (idIndex !== -1) return idIndex
  }
  if (currentCells[pending.index]?.source === pending.source) return pending.index

  const foundIndex = currentCells.findIndex((cell) => cell.source === pending.source)
  return foundIndex === -1 ? null : foundIndex
}

/**
 * /sync and /render carry a cell's `status: "busy"` forward positionally
 * (see syncCells/mergeCells), same as everything else about it - so an
 * insert/delete/reorder that vacates a genuinely-running cell's old slot
 * leaves whatever cell lands there permanently stuck showing a running
 * spinner, since nothing else ever tells that slot its execution actually
 * finished elsewhere. Call this right after reassigning currentCells to
 * clear "busy" from any cell no pending execution actually resolves to.
 */
export function reconcileBusyStatus(
  currentCells: RenderedCell[],
  pendingExecs: Map<string, PendingExec>,
) {
  const runningIndices = new Set<number>()

  for (const pending of pendingExecs.values()) {
    const index = resolveCellIndex(currentCells, pending)
    if (index !== null) runningIndices.add(index)
  }

  currentCells.forEach((cell, index) => {
    if (cell.status === "busy" && !runningIndices.has(index)) {
      cell.status = "idle"
      cell.duration_ms = undefined
    }
  })
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
  pendingExecs: Map<string, PendingExec>,
  onCellUpdated: (index: number) => void,
) {
  const pending = pendingExecs.get(parentId)

  if (pending === undefined) return

  const index = resolveCellIndex(currentCells, pending)

  if (index === null) return

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
