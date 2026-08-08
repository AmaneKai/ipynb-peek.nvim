import { describe, test, expect } from "vitest"
import type { RenderedCell } from "./notebook"
import {
  applyStatusMessage,
  applyExecuteInputMessage,
  applyStreamMessage,
  applyResultMessage,
  applyErrorMessage,
  applyClearOutputMessage,
  handleIopub,
  reconcileBusyStatus,
  type PendingExec,
} from "./iopub"

function makeCell(overrides: Partial<RenderedCell> = {}): RenderedCell {
  return {
    index: 0,
    cell_type: "code",
    source: "1 + 1",
    outputs: [],
    ...overrides,
  }
}

function pendingMap(entries: [string, PendingExec][]): Map<string, PendingExec> {
  return new Map(entries)
}

describe("applyStatusMessage", () => {
  test("marks the cell busy and leaves pendingExecs untouched", () => {
    const cell = makeCell()
    const pendingExecs = pendingMap([["parent-1", { index: 0, source: cell.source }]])

    applyStatusMessage(cell, { execution_state: "busy" }, "parent-1", pendingExecs)

    expect(cell.status).toBe("busy")
    expect(pendingExecs.has("parent-1")).toBe(true)
  })

  test("stamps started_at when busy arrives, overriding an earlier queued-time value - so a cell queued behind a long-running one doesn't count that wait as its own duration", () => {
    const queuedAt = Date.now() - 30000
    const cell = makeCell({ started_at: queuedAt })
    const pendingExecs = pendingMap([["parent-1", { index: 0, source: cell.source }]])

    applyStatusMessage(cell, { execution_state: "busy" }, "parent-1", pendingExecs)
    expect(cell.started_at).toBeGreaterThan(queuedAt)

    applyStatusMessage(cell, { execution_state: "idle" }, "parent-1", pendingExecs)
    expect(cell.duration_ms).toBeLessThan(1000)
  })

  test("marks idle, records duration, and clears the pending entry", () => {
    const cell = makeCell({ status: "busy", started_at: Date.now() - 50 })
    const pendingExecs = pendingMap([["parent-1", { index: 0, source: cell.source }]])

    applyStatusMessage(cell, { execution_state: "idle" }, "parent-1", pendingExecs)

    expect(cell.status).toBe("idle")
    expect(cell.duration_ms).toBeGreaterThanOrEqual(0)
    expect(pendingExecs.has("parent-1")).toBe(false)
  })
})

describe("applyExecuteInputMessage", () => {
  test("records the execution_count when present", () => {
    const cell = makeCell()
    applyExecuteInputMessage(cell, { execution_count: 5 })
    expect(cell.execution_count).toBe(5)
  })

  test("leaves execution_count untouched when absent", () => {
    const cell = makeCell({ execution_count: 2 })
    applyExecuteInputMessage(cell, {})
    expect(cell.execution_count).toBe(2)
  })
})

describe("applyStreamMessage", () => {
  test("appends a text output tagged with the stream name", () => {
    const cell = makeCell()
    applyStreamMessage(cell, { name: "stdout", text: ["hello\n"] })
    expect(cell.outputs).toEqual([{ kind: "text", content: "hello\n", stream: "stdout" }])
  })

  test("merges consecutive chunks from the same stream into one output", () => {
    const cell = makeCell()
    applyStreamMessage(cell, { name: "stdout", text: ["chunk 0 "] })
    applyStreamMessage(cell, { name: "stdout", text: ["chunk 1 "] })
    applyStreamMessage(cell, { name: "stdout", text: ["chunk 2"] })

    expect(cell.outputs).toEqual([
      { kind: "text", content: "chunk 0 chunk 1 chunk 2", stream: "stdout" },
    ])
  })

  test("a bare \\r overwrites the current line instead of stacking - e.g. tqdm progress bars", () => {
    const cell = makeCell()
    applyStreamMessage(cell, { name: "stdout", text: ["\rprogress 0"] })
    applyStreamMessage(cell, { name: "stdout", text: ["\rprogress 1"] })
    applyStreamMessage(cell, { name: "stdout", text: ["\rprogress 2"] })

    expect(cell.outputs).toEqual([{ kind: "text", content: "progress 2", stream: "stdout" }])
  })

  test("keeps stdout and stderr as separate outputs even when interleaved", () => {
    const cell = makeCell()
    applyStreamMessage(cell, { name: "stdout", text: ["out\n"] })
    applyStreamMessage(cell, { name: "stderr", text: ["err\n"] })

    expect(cell.outputs).toEqual([
      { kind: "text", content: "out\n", stream: "stdout" },
      { kind: "text", content: "err\n", stream: "stderr" },
    ])
  })
})

describe("applyResultMessage", () => {
  test("prefers image/png over other mime types", () => {
    const cell = makeCell()
    applyResultMessage(
      cell,
      { data: { "image/png": "data", "text/plain": "42" } },
      "execute_result",
    )
    expect(cell.outputs).toEqual([{ kind: "image", mime: "image/png", data: "data" }])
  })

  test("renders text/latex as a latex output", () => {
    const cell = makeCell()
    applyResultMessage(cell, { data: { "text/latex": "$x^2$" } }, "display_data")
    expect(cell.outputs).toEqual([{ kind: "latex", content: "$x^2$" }])
  })

  test("renders text/markdown as a markdown output instead of falling back to text/plain", () => {
    const cell = makeCell()
    applyResultMessage(
      cell,
      { data: { "text/markdown": "**bold**", "text/plain": "**bold**" } },
      "display_data",
    )
    expect(cell.outputs).toEqual([{ kind: "markdown", content: "**bold**" }])
  })

  test("carries requested display width/height through for a PNG", () => {
    const cell = makeCell()
    applyResultMessage(
      cell,
      { data: { "image/png": "data" }, metadata: { "image/png": { width: 300, height: 150 } } },
      "display_data",
    )
    expect(cell.outputs).toEqual([
      { kind: "image", mime: "image/png", data: "data", width: 300, height: 150 },
    ])
  })

  test("pretty-prints application/json instead of falling back to a repr placeholder", () => {
    const cell = makeCell()
    applyResultMessage(cell, { data: { "application/json": { a: 1 } } }, "display_data")
    expect(cell.outputs).toEqual([{ kind: "text", content: JSON.stringify({ a: 1 }, null, 2) }])
  })

  test("records execution_count only for execute_result, not display_data", () => {
    const executeResultCell = makeCell()
    applyResultMessage(executeResultCell, { data: {}, execution_count: 7 }, "execute_result")
    expect(executeResultCell.execution_count).toBe(7)

    const displayDataCell = makeCell()
    applyResultMessage(displayDataCell, { data: {}, execution_count: 7 }, "display_data")
    expect(displayDataCell.execution_count).toBeUndefined()
  })

  test("retains the complete MIME bundle and metadata for persistence", () => {
    const cell = makeCell()
    applyResultMessage(
      cell,
      {
        data: { "text/html": "<b>42</b>", "text/plain": "42" },
        metadata: { isolated: true },
        execution_count: 3,
      },
      "execute_result",
    )

    expect(cell.nbformat_outputs).toEqual([
      {
        output_type: "execute_result",
        execution_count: 3,
        data: { "text/html": "<b>42</b>", "text/plain": "42" },
        metadata: { isolated: true },
      },
    ])
  })
})

describe("applyErrorMessage", () => {
  test("joins and ANSI-strips a traceback array", () => {
    const cell = makeCell()
    applyErrorMessage(cell, { traceback: ["\x1b[31mline one", "line two\x1b[0m"] })
    expect(cell.outputs).toEqual([{ kind: "error", content: "line one\nline two" }])
  })

  test("falls back to ename/evalue when no traceback array is given", () => {
    const cell = makeCell()
    applyErrorMessage(cell, { ename: "ValueError", evalue: "bad value" })
    expect(cell.outputs).toEqual([{ kind: "error", content: "ValueError: bad value" }])
  })
})

describe("applyClearOutputMessage", () => {
  test("empties the cell's outputs", () => {
    const cell = makeCell({ outputs: [{ kind: "text", content: "stale" }] })
    applyClearOutputMessage(cell)
    expect(cell.outputs).toEqual([])
  })
})

describe("handleIopub", () => {
  test("dispatches a stream message to the right cell and notifies the caller", () => {
    const cells = [makeCell()]
    const pendingExecs = pendingMap([["parent-1", { index: 0, source: cells[0].source }]])
    const updated: number[] = []

    handleIopub(
      "parent-1",
      "stream",
      { name: "stdout", text: ["output"] },
      cells,
      pendingExecs,
      (index) => updated.push(index),
    )

    expect(cells[0].outputs).toEqual([{ kind: "text", content: "output", stream: "stdout" }])
    expect(updated).toEqual([0])
  })

  test("ignores a message whose parent_id has no pending execution", () => {
    const cells = [makeCell()]
    const pendingExecs = pendingMap([])
    const updated: number[] = []

    handleIopub("unknown-parent", "stream", { text: ["x"] }, cells, pendingExecs, (index) =>
      updated.push(index),
    )

    expect(cells[0].outputs).toEqual([])
    expect(updated).toEqual([])
  })

  test("does not notify the caller for an unrecognized message type", () => {
    const cells = [makeCell()]
    const pendingExecs = pendingMap([["parent-1", { index: 0, source: cells[0].source }]])
    const updated: number[] = []

    handleIopub("parent-1", "comm_open", {}, cells, pendingExecs, (index) => updated.push(index))

    expect(updated).toEqual([])
  })

  test("re-locates the running cell by source when /sync shifted its index mid-execution", () => {
    // Cell "sleep(1)" was at index 0 when /execute captured this pending
    // entry. Before the kernel replies, a /sync inserted a brand new cell
    // ahead of it, so the running cell is now at index 1 and a never-run
    // cell occupies the stale index 0.
    const cells = [
      makeCell({ index: 0, source: "# brand new, never executed" }),
      makeCell({ index: 1, source: "sleep(1)" }),
    ]
    const pendingExecs = pendingMap([["parent-1", { index: 0, source: "sleep(1)" }]])
    const updated: number[] = []

    handleIopub(
      "parent-1",
      "stream",
      { name: "stdout", text: ["done\n"] },
      cells,
      pendingExecs,
      (index) => updated.push(index),
    )

    expect(cells[0].outputs).toEqual([])
    expect(cells[1].outputs).toEqual([{ kind: "text", content: "done\n", stream: "stdout" }])
    expect(updated).toEqual([1])
  })

  test("drops the message rather than guessing when the running cell can't be found at all", () => {
    // The running cell was deleted entirely while its execution was still
    // in flight - there is no safe cell to attach this output to.
    const cells = [makeCell({ index: 0, source: "something else" })]
    const pendingExecs = pendingMap([["parent-1", { index: 0, source: "sleep(1)" }]])
    const updated: number[] = []

    handleIopub(
      "parent-1",
      "stream",
      { name: "stdout", text: ["done\n"] },
      cells,
      pendingExecs,
      (index) => updated.push(index),
    )

    expect(cells[0].outputs).toEqual([])
    expect(updated).toEqual([])
  })
})

describe("reconcileBusyStatus", () => {
  test("clears a stuck busy status left on a slot no pending execution resolves to", () => {
    // Mirrors what mergeCells/syncCells produce after an insert shifts a
    // genuinely-running cell out from under its old index: the new cell
    // that lands on that old index inherits its "busy" marker positionally,
    // with nothing else ever telling it that execution actually finished
    // elsewhere.
    const cells = [
      makeCell({ index: 0, source: "# brand new, never executed", status: "busy" }),
      makeCell({ index: 1, source: "sleep(1)", status: "idle" }),
    ]
    const pendingExecs = pendingMap([["parent-1", { index: 0, source: "sleep(1)" }]])

    reconcileBusyStatus(cells, pendingExecs)

    expect(cells[0].status).toBe("idle")
    expect(cells[1].status).toBe("idle")
  })

  test("leaves a genuinely running cell's busy status alone", () => {
    const cells = [makeCell({ status: "busy" })]
    const pendingExecs = pendingMap([["parent-1", { index: 0, source: cells[0].source }]])

    reconcileBusyStatus(cells, pendingExecs)

    expect(cells[0].status).toBe("busy")
  })
})
