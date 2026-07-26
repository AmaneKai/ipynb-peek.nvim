export type CellOutput =
  | { kind: "text"; content: string; stream?: "stdout" | "stderr" }
  | { kind: "error"; content: string }
  | { kind: "image"; data: string }
  | { kind: "html"; content: string }
  | { kind: "latex"; content: string }

export type RenderedCell = {
  index: number
  cell_type: "markdown" | "code" | "raw"
  source: string
  language?: string
  execution_count?: number | null
  status?: "idle" | "busy"
  started_at?: number
  duration_ms?: number
  outputs: CellOutput[]
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

  if (data["image/png"]) return { kind: "image", data: joinSource(data["image/png"]) }

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
      cell_type: cell.cell_type,
      source,
      language: cell.cell_type === "code" ? language : undefined,
      execution_count: cell.cell_type === "code" ? (cell.execution_count ?? null) : undefined,
      outputs,
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
  return live.map((liveCell, index) => {
    const prevCell = previous[index]
    if (prevCell) {
      return {
        ...prevCell,
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
    }
  })
}

/**
 * Reverses renderOutput's simplification back into a best-effort nbformat
 * output object, so execution results can be written back into the real
 * .ipynb file. Not a byte-perfect round-trip: stream outputs keep their
 * exact output_type/name, but execute_result/display_data/image/latex all
 * collapse to display_data, since CellOutput doesn't retain which iopub
 * message type an output originally came from. nbconvert and other tools
 * render execute_result/display_data identically either way - the only
 * loss is the "Out[n]:" prompt label on the cell's own return value.
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
      return { output_type: "display_data", data: { "image/png": output.data }, metadata: {} }
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
 * matching source text rather than trusting array position, for the same
 * reason resolveCellIndex does in iopub.ts - positions drift under
 * live-typing sync. A cell with no match on disk (deleted, or the notebook
 * hasn't been saved since it was added), or with source text duplicated
 * elsewhere in the notebook, is a known, inherent limitation without stable
 * cell identity - skipped, or best-effort first-match, respectively, rather
 * than guessed at riskily.
 */
export function patchNotebookOutputs(notebookJson: any, currentCells: RenderedCell[]): any {
  const nbCells = Array.isArray(notebookJson?.cells) ? notebookJson.cells : []

  for (const cell of currentCells) {
    if (cell.cell_type !== "code") continue
    if (cell.status === "busy") continue
    if (cell.outputs.length === 0 && cell.execution_count == null) continue

    const nbCell = nbCells.find(
      (candidate: any) =>
        candidate.cell_type === "code" && joinSource(candidate.source) === cell.source,
    )
    if (!nbCell) continue

    nbCell.outputs = cell.outputs.map(toNbformatOutput)
    nbCell.execution_count = cell.execution_count ?? null
  }

  return notebookJson
}
