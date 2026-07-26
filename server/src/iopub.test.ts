import { describe, test, expect } from "bun:test"
import type { RenderedCell } from "./notebook"
import {
  applyStatusMessage,
  applyExecuteInputMessage,
  applyStreamMessage,
  applyResultMessage,
  applyErrorMessage,
  applyClearOutputMessage,
  handleIopub,
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

describe("applyStatusMessage", () => {
  test("marks the cell busy and leaves pendingExecs untouched", () => {
    const cell = makeCell()
    const pendingExecs = new Map([["parent-1", 0]])

    applyStatusMessage(cell, { execution_state: "busy" }, "parent-1", pendingExecs)

    expect(cell.status).toBe("busy")
    expect(pendingExecs.has("parent-1")).toBe(true)
  })

  test("marks idle, records duration, and clears the pending entry", () => {
    const cell = makeCell({ status: "busy", started_at: Date.now() - 50 })
    const pendingExecs = new Map([["parent-1", 0]])

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
  test("appends a text output built from the stream content", () => {
    const cell = makeCell()
    applyStreamMessage(cell, { text: ["hello\n"] })
    expect(cell.outputs).toEqual([{ kind: "text", content: "hello\n" }])
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
    expect(cell.outputs).toEqual([{ kind: "image", data: "data" }])
  })

  test("records execution_count only for execute_result, not display_data", () => {
    const executeResultCell = makeCell()
    applyResultMessage(executeResultCell, { data: {}, execution_count: 7 }, "execute_result")
    expect(executeResultCell.execution_count).toBe(7)

    const displayDataCell = makeCell()
    applyResultMessage(displayDataCell, { data: {}, execution_count: 7 }, "display_data")
    expect(displayDataCell.execution_count).toBeUndefined()
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
    const pendingExecs = new Map([["parent-1", 0]])
    const updated: number[] = []

    handleIopub("parent-1", "stream", { text: ["output"] }, cells, pendingExecs, (index) =>
      updated.push(index),
    )

    expect(cells[0].outputs).toEqual([{ kind: "text", content: "output" }])
    expect(updated).toEqual([0])
  })

  test("ignores a message whose parent_id has no pending execution", () => {
    const cells = [makeCell()]
    const pendingExecs = new Map<string, number>()
    const updated: number[] = []

    handleIopub("unknown-parent", "stream", { text: ["x"] }, cells, pendingExecs, (index) =>
      updated.push(index),
    )

    expect(cells[0].outputs).toEqual([])
    expect(updated).toEqual([])
  })

  test("does not notify the caller for an unrecognized message type", () => {
    const cells = [makeCell()]
    const pendingExecs = new Map([["parent-1", 0]])
    const updated: number[] = []

    handleIopub("parent-1", "comm_open", {}, cells, pendingExecs, (index) => updated.push(index))

    expect(updated).toEqual([])
  })
})
