export type CellOutput =
  | { kind: "text"; content: string; stream?: "stdout" | "stderr" }
  | { kind: "error"; content: string }
  | { kind: "image"; data: string; mime?: "image/png" | "image/jpeg" | "image/svg+xml" }
  | { kind: "html"; content: string }
  | { kind: "latex"; content: string }

export type RenderedCell = {
  index: number
  id?: string
  cell_type: "markdown" | "code" | "raw"
  source: string
  language?: string
  execution_count?: number | null
  status?: "idle" | "busy"
  started_at?: number
  duration_ms?: number
  outputs: CellOutput[]
  /** Exact nbformat/iopub objects retained for lossless persistence. */
  nbformat_outputs?: any[]
}

export function joinSource(src: string | string[] | undefined): string {
  if (!src) return ""

  return Array.isArray(src) ? src.join("") : src
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "")
}

export function renderOutput(output: any): CellOutput | null {
  const data = output.data ?? {}

  if (data["image/png"])
    return { kind: "image", mime: "image/png", data: joinSource(data["image/png"]) }

  if (data["image/jpeg"])
    return { kind: "image", mime: "image/jpeg", data: joinSource(data["image/jpeg"]) }

  if (data["image/svg+xml"])
    return { kind: "image", mime: "image/svg+xml", data: joinSource(data["image/svg+xml"]) }

  if (data["text/html"]) return { kind: "html", content: joinSource(data["text/html"]) }

  if (data["text/latex"]) return { kind: "latex", content: joinSource(data["text/latex"]) }

  if (output.output_type === "stream")
    return {
      kind: "text",
      content: joinSource(output.text),
      stream: output.name === "stderr" ? "stderr" : "stdout",
    }

  if (output.output_type === "error") {
    const traceback = Array.isArray(output.traceback)
      ? output.traceback.join("\n")
      : (output.traceback ?? "")
    return { kind: "error", content: stripAnsi(traceback) }
  }

  if (data["application/json"] !== undefined)
    return { kind: "text", content: JSON.stringify(data["application/json"], null, 2) }

  if (data["text/plain"]) return { kind: "text", content: joinSource(data["text/plain"]) }

  return null
}

/**
 * Appends `newOutput`, merging it into the previous output when both are
 * text from the same stream - matches how nbformat itself accumulates
 * consecutive stdout/stderr chunks into one entry rather than one entry per
 * flush (which is otherwise how quickly-updating output like tqdm arrives).
 */
export function appendOutput(outputs: CellOutput[], newOutput: CellOutput): void {
  const last = outputs[outputs.length - 1]

  if (
    last &&
    last.kind === "text" &&
    newOutput.kind === "text" &&
    last.stream !== undefined &&
    last.stream === newOutput.stream
  ) {
    last.content += newOutput.content
    return
  }

  outputs.push(newOutput)
}

export function renderNotebook(nb: any): RenderedCell[] {
  const language = nb.metadata?.kernelspec?.language ?? nb.metadata?.language_info?.name ?? "python"

  const cells: RenderedCell[] = []

  for (let index = 0; index < nb.cells.length; index++) {
    const cell = nb.cells[index]
    const source = joinSource(cell.source)
    const outputs: CellOutput[] = []

    if (cell.cell_type === "code" && Array.isArray(cell.outputs)) {
      for (const output of cell.outputs) {
        const rendered = renderOutput(output)
        if (rendered) appendOutput(outputs, rendered)
      }
    }

    cells.push({
      index,
      id: typeof cell.id === "string" ? cell.id : undefined,
      cell_type: cell.cell_type,
      source,
      language: cell.cell_type === "code" ? language : undefined,
      execution_count: cell.cell_type === "code" ? (cell.execution_count ?? null) : undefined,
      outputs,
      nbformat_outputs:
        cell.cell_type === "code" && Array.isArray(cell.outputs)
          ? structuredClone(cell.outputs)
          : undefined,
    })
  }

  return cells
}

/**
 * Saving the notebook (BufWritePost -> /render) fully re-parses cells from
 * disk. jupytext's python view carries no outputs, so a naive replace would
 * wipe out anything a live kernel run just produced. Preserves live outputs
 * for cells whose source text didn't change.
 */
export function mergeCells(previous: RenderedCell[], fresh: RenderedCell[]): RenderedCell[] {
  return fresh.map((cell, index) => {
    const prevCell = previous[index]
    if (
      prevCell &&
      prevCell.source === cell.source &&
      prevCell.cell_type === cell.cell_type &&
      (prevCell.outputs.length > 0 || prevCell.execution_count)
    ) {
      return {
        ...cell,
        outputs: prevCell.outputs,
        nbformat_outputs: prevCell.nbformat_outputs,
        execution_count: prevCell.execution_count,
        status: prevCell.status,
        started_at: prevCell.started_at,
        duration_ms: prevCell.duration_ms,
      }
    }
    return cell
  })
}

/**
 * Live typing sync (/sync): the notebook buffer isn't valid JSON while
 * jupytext owns it, so unlike /render this reads cell source/type straight
 * from the raw `# %%` buffer (Neovim parses it - see cells.lua) rather than
 * re-parsing a .ipynb. Unlike mergeCells, outputs/execution state are ALWAYS
 * carried forward by index regardless of whether the source changed - a
 * mid-edit keystroke should never flicker away the last run's output.
 */
export function syncCells(
  previous: RenderedCell[],
  live: { cell_type: "code" | "markdown"; source: string }[],
): RenderedCell[] {
  // Exact source/type matches form stable anchors. Unmatched one-to-one gaps
  // between them are ordinary edits and keep identity positionally; unequal
  // gaps represent insertion/deletion and deliberately stay fresh rather
  // than borrowing another cell's ID or execution state.
  const rows = Array.from({ length: previous.length + 1 }, () => new Uint16Array(live.length + 1))
  for (let oldIndex = previous.length - 1; oldIndex >= 0; oldIndex--) {
    for (let liveIndex = live.length - 1; liveIndex >= 0; liveIndex--) {
      const exact =
        previous[oldIndex].cell_type === live[liveIndex].cell_type &&
        previous[oldIndex].source === live[liveIndex].source
      rows[oldIndex][liveIndex] = exact
        ? rows[oldIndex + 1][liveIndex + 1] + 1
        : Math.max(rows[oldIndex + 1][liveIndex], rows[oldIndex][liveIndex + 1])
    }
  }

  const anchors: Array<[number, number]> = []
  let oldIndex = 0
  let liveIndex = 0
  while (oldIndex < previous.length && liveIndex < live.length) {
    if (
      previous[oldIndex].cell_type === live[liveIndex].cell_type &&
      previous[oldIndex].source === live[liveIndex].source
    ) {
      anchors.push([oldIndex++, liveIndex++])
    } else if (rows[oldIndex + 1][liveIndex] >= rows[oldIndex][liveIndex + 1]) oldIndex++
    else liveIndex++
  }

  const previousByLiveIndex = new Map<number, RenderedCell>()
  let previousStart = 0
  let liveStart = 0
  const allAnchors: Array<[number, number]> = [...anchors, [previous.length, live.length]]
  for (const [previousAnchor, liveAnchor] of allAnchors) {
    const previousGap = previousAnchor - previousStart
    const liveGap = liveAnchor - liveStart
    if (previousGap === liveGap) {
      for (let offset = 0; offset < liveGap; offset++)
        previousByLiveIndex.set(liveStart + offset, previous[previousStart + offset])
    }
    if (previousAnchor < previous.length)
      previousByLiveIndex.set(liveAnchor, previous[previousAnchor])
    previousStart = previousAnchor + 1
    liveStart = liveAnchor + 1
  }

  return live.map((liveCell, index) => {
    const prevCell = previousByLiveIndex.get(index)
    if (prevCell) {
      return {
        ...prevCell,
        index,
        cell_type: liveCell.cell_type,
        source: liveCell.source,
        language: liveCell.cell_type === "code" ? (prevCell.language ?? "python") : undefined,
      }
    }
    return {
      index,
      cell_type: liveCell.cell_type,
      source: liveCell.source,
      language: liveCell.cell_type === "code" ? "python" : undefined,
      execution_count: liveCell.cell_type === "code" ? null : undefined,
      outputs: [],
      nbformat_outputs: liveCell.cell_type === "code" ? [] : undefined,
    }
  })
}

/**
 * Reverses renderOutput's simplified browser model into a best-effort
 * nbformat output object. Live executions keep their exact raw nbformat
 * messages separately; this is only the fallback for older/in-memory cells
 * that do not have that lossless copy.
 */
export function toNbformatOutput(output: CellOutput): any {
  switch (output.kind) {
    case "text":
      if (output.stream)
        return { output_type: "stream", name: output.stream, text: [output.content] }
      return { output_type: "display_data", data: { "text/plain": [output.content] }, metadata: {} }
    case "html":
      return { output_type: "display_data", data: { "text/html": [output.content] }, metadata: {} }
    case "latex":
      return { output_type: "display_data", data: { "text/latex": [output.content] }, metadata: {} }
    case "image":
      return {
        output_type: "display_data",
        data: { [output.mime ?? "image/png"]: output.data },
        metadata: {},
      }
    case "error":
      return {
        output_type: "error",
        ename: "Error",
        evalue: "",
        traceback: output.content.split("\n"),
      }
  }
}

/**
 * Patches execution results from `currentCells` into `notebookJson`'s
 * matching cells, in place, so jupytext.vim's own --update save mode (which
 * preserves existing outputs for any cell whose source hasn't changed) can
 * keep them around on every subsequent save. Matches cells by searching for
 * stable nbformat cell ID first. Older notebooks may not have IDs, so the
 * fallback uses an unused same-position/source match and finally an unused
 * source match. Tracking used notebook positions is important: two identical
 * code cells must never both overwrite the first matching cell.
 */
export function patchNotebookOutputs(notebookJson: any, currentCells: RenderedCell[]): any {
  const nbCells = Array.isArray(notebookJson?.cells) ? notebookJson.cells : []
  const usedNotebookIndices = new Set<number>()

  for (let currentIndex = 0; currentIndex < currentCells.length; currentIndex++) {
    const cell = currentCells[currentIndex]
    if (cell.cell_type !== "code") continue
    if (cell.status === "busy") continue
    if (cell.outputs.length === 0 && cell.execution_count == null) continue

    let notebookIndex = cell.id
      ? nbCells.findIndex((candidate: any) => candidate.id === cell.id)
      : -1
    const positionalCandidate = nbCells[currentIndex]
    if (
      notebookIndex === -1 &&
      !usedNotebookIndices.has(currentIndex) &&
      positionalCandidate?.cell_type === "code" &&
      joinSource(positionalCandidate.source) === cell.source
    ) {
      notebookIndex = currentIndex
    }
    if (notebookIndex === -1) {
      notebookIndex = nbCells.findIndex(
        (candidate: any, index: number) =>
          !usedNotebookIndices.has(index) &&
          candidate.cell_type === "code" &&
          joinSource(candidate.source) === cell.source,
      )
    }
    if (notebookIndex === -1 || usedNotebookIndices.has(notebookIndex)) continue

    const nbCell = nbCells[notebookIndex]
    usedNotebookIndices.add(notebookIndex)
    nbCell.outputs = cell.nbformat_outputs
      ? structuredClone(cell.nbformat_outputs)
      : cell.outputs.map(toNbformatOutput)
    nbCell.execution_count = cell.execution_count ?? null
  }

  return notebookJson
}

export type CellStatusInfo = {
  index: number
  status: "idle" | "busy"
  execution_count?: number | null
  duration_ms?: number
  has_error: boolean
}

/**
 * Shapes the subset of a cell's state that's relevant to the in-buffer
 * status sign/virtual text pushed to Neovim over /events. `index` is a
 * required parameter rather than reading `cell.index` - that field is only
 * ever set once in renderNotebook and isn't kept in sync by syncCells' merge
 * branch, so it can go stale the moment an insert/delete shifts array
 * positions. Every other consumer of cell position (handleIopub,
 * broadcastCell) already treats the array index as the only source of
 * truth for this reason.
 */
export function cellStatusInfo(cell: RenderedCell, index: number): CellStatusInfo {
  return {
    index,
    status: cell.status ?? "idle",
    execution_count: cell.execution_count,
    duration_ms: cell.duration_ms,
    has_error: cell.outputs.some((output) => output.kind === "error"),
  }
}
