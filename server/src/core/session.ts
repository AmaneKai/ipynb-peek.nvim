import { WebSocket } from "ws"
import { cellStatusInfo, patchNotebookOutputs, type RenderedCell } from "../notebook"
import type { PendingExec } from "../iopub"
import { updateNotebookFile } from "../persist"
import { PRESET_NAMES } from "../themes"

export type PendingInputRequest = { index: number | null; prompt: string; password: boolean }

/** Keep the exact nbformat copy used for persistence on the server. */
export function publicCell(cell: RenderedCell): Omit<RenderedCell, "nbformat_outputs"> {
  const { nbformat_outputs: _nbformatOutputs, ...visibleCell } = cell
  return visibleCell
}

export function appendExecutionFailure(cell: RenderedCell, message: string) {
  cell.outputs.push({ kind: "error", content: message })
  cell.nbformat_outputs ??= []
  cell.nbformat_outputs.push({
    output_type: "error",
    ename: "KernelError",
    evalue: message,
    traceback: [message],
  })
}

/**
 * Everything one preview server knows about the notebook it is showing, and
 * the two ways it tells others about changes: websocket broadcasts to
 * connected browsers, and events pushed to Neovim.
 */
export class NotebookSession {
  cells: RenderedCell[] = []
  kernelName: string | undefined
  notebookDir: string | undefined
  notebookPath: string | undefined
  readonly pendingExecs = new Map<string, PendingExec>()

  /**
   * The kernel's outstanding input_request, if any - kept server-side (not
   * just fired once over the websocket) so a browser that reconnects while a
   * cell is blocked on input() still sees the prompt instead of a cell that
   * looks permanently busy with no way to unblock it short of an interrupt.
   * Cleared once answered or once the kernel that owned it goes away.
   */
  pendingInputRequest: PendingInputRequest | null = null

  /** Palette picked from Neovim (`:IpynbPeekTheme`); null = the configured default. */
  theme: string | null = null

  /** Kernel picked via `:IpynbPeekSelectKernel`; outranks the notebook's own kernelspec. */
  kernelOverride: string | undefined
  kernelRunning = false

  /** Report requests sent to the browser, waiting for it to post the HTML back. */
  readonly pendingExports = new Map<
    string,
    {
      resolve: (html: string) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  readonly wsClients = new Set<WebSocket>()
  private readonly eventSubscribers = new Set<(line: string) => void>()

  reset() {
    this.cells = []
    this.kernelName = undefined
    this.notebookDir = undefined
    this.notebookPath = undefined
    this.pendingExecs.clear()
    this.pendingInputRequest = null
    this.theme = null
    this.kernelOverride = undefined
    this.kernelRunning = false
    for (const pending of this.pendingExports.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error("preview closed"))
    }
    this.pendingExports.clear()
  }

  emitKernel() {
    this.emitEvent({ type: "kernel", name: this.kernelName ?? null, running: this.kernelRunning })
  }

  setKernelRunning(running: boolean) {
    if (this.kernelRunning === running) return
    this.kernelRunning = running
    this.emitKernel()
  }

  /** Asks the connected preview page to build a report and send it back. */
  requestExport(mode: "html" | "report", timeoutMs = 30000): Promise<string> {
    if (this.wsClients.size === 0)
      return Promise.reject(new Error("no preview window is connected to export from"))
    const id = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingExports.delete(id)
        reject(new Error("the preview did not answer the export request"))
      }, timeoutMs)
      this.pendingExports.set(id, { resolve, reject, timer })
      this.broadcast(JSON.stringify({ type: "export_request", id, mode }))
    })
  }

  /** The browser's answer to requestExport. False if the id is unknown/expired. */
  resolveExport(id: string, html: unknown, error: unknown): boolean {
    const pending = this.pendingExports.get(id)
    if (!pending) return false
    clearTimeout(pending.timer)
    this.pendingExports.delete(id)
    if (typeof html === "string") pending.resolve(html)
    else pending.reject(new Error(String(error ?? "export failed")))
    return true
  }

  themePayload(): string {
    return JSON.stringify({ type: "theme", name: this.theme, available: PRESET_NAMES })
  }

  /** Subscribes to events pushed to Neovim; returns the unsubscribe function. */
  subscribe(send: (line: string) => void): () => void {
    this.eventSubscribers.add(send)
    return () => this.eventSubscribers.delete(send)
  }

  emitEvent(event: any) {
    const line = JSON.stringify(event)
    for (const send of this.eventSubscribers) send(line)
  }

  renderPayload(): string {
    return JSON.stringify({ type: "render", cells: this.cells.map(publicCell) })
  }

  inputRequestPayload(): string {
    return JSON.stringify({ type: "input_request", ...this.pendingInputRequest })
  }

  broadcast(payload: string) {
    for (const ws of this.wsClients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload)
    }
  }

  /**
   * Also pushes a bulk in-buffer status snapshot to Neovim, so the
   * sign-column icon/virtual-text on each cell's marker line stays correct
   * after a full re-render/sync/restart, not just after individual cell
   * updates (see broadcastCell) - covers a shrunk/reordered cell list, which
   * a single-cell event can't safely reconcile on its own.
   */
  broadcastFull() {
    this.broadcast(this.renderPayload())
    this.emitEvent({ type: "cells_status", cells: this.cells.map((c, i) => cellStatusInfo(c, i)) })
  }

  /**
   * Also pushes a single-cell status update to Neovim (see broadcastFull for
   * the bulk counterpart) - this is what lands the sign-column
   * icon/virtual-text change onto the right buffer line the moment a cell
   * goes busy, streams output, errors, or finishes.
   */
  broadcastCell(index: number) {
    this.broadcast(
      JSON.stringify({ type: "cell_update", index, cell: publicCell(this.cells[index]) }),
    )
    this.emitEvent({ type: "cell_status", ...cellStatusInfo(this.cells[index], index) })
  }

  broadcastSync(previousCells: RenderedCell[]) {
    if (previousCells.length !== this.cells.length) {
      this.broadcastFull()
      return
    }
    for (let index = 0; index < this.cells.length; index++) {
      const previous = previousCells[index]
      const current = this.cells[index]
      if (previous.source !== current.source || previous.cell_type !== current.cell_type)
        this.broadcastCell(index)
    }
  }

  /**
   * Writes execution results into the real .ipynb file right after a cell
   * settles, rather than waiting for an explicit save. jupytext's percent
   * format has no channel for outputs at all - without this, results computed
   * here only ever exist in this server's memory and the browser popup, never
   * in the file itself, so tools like `jupyter nbconvert` would always see
   * empty outputs. jupytext.vim's own --update save mode preserves whatever's
   * already on disk for a cell whose source hasn't changed, so writing here
   * is enough for those results to survive every later save. Best-effort and
   * non-fatal: a disk write failing here shouldn't break the live preview.
   */
  async persistOutputsToDisk() {
    const path = this.notebookPath
    if (!path) return

    // Tell Neovim before touching the file so its file watcher can tell this
    // write from an external edit (it would otherwise warn about "external"
    // changes whenever a cell finishes while the buffer has unsaved edits).
    this.emitEvent({ type: "persisting", path })
    try {
      const cellsSnapshot = structuredClone(this.cells)
      await updateNotebookFile(path, (notebookJson) => {
        patchNotebookOutputs(notebookJson, cellsSnapshot)
      })
    } catch (error) {
      console.error("[ipynb-peek] failed to persist outputs to disk:", error)
    } finally {
      this.emitEvent({ type: "persisted", path })
    }
  }

  pendingCellIndex(pending: PendingExec): number | null {
    if (pending.id) {
      const idIndex = this.cells.findIndex((cell) => cell.id === pending.id)
      if (idIndex !== -1) return idIndex
    }
    if (this.cells[pending.index]?.source === pending.source) return pending.index
    const sourceIndex = this.cells.findIndex((cell) => cell.source === pending.source)
    return sourceIndex === -1 ? null : sourceIndex
  }

  failPendingExecutions(message: string) {
    const updated = new Set<number>()

    for (const pending of this.pendingExecs.values()) {
      const index = this.pendingCellIndex(pending)
      if (index === null || updated.has(index)) continue
      const cell = this.cells[index]
      appendExecutionFailure(cell, message)
      cell.status = "idle"
      cell.duration_ms = cell.started_at ? Date.now() - cell.started_at : undefined
      updated.add(index)
    }
    this.pendingExecs.clear()
    for (const index of updated) this.broadcastCell(index)
  }
}
