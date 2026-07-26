import { describe, test, expect } from "bun:test"
import {
  joinSource,
  stripAnsi,
  renderOutput,
  renderNotebook,
  mergeCells,
  syncCells,
} from "./notebook"

describe("joinSource", () => {
  test("joins a jupyter-style source array into one string", () => {
    expect(joinSource(["a = 1\n", "b = 2"])).toBe("a = 1\nb = 2")
  })

  test("passes a plain string through unchanged", () => {
    expect(joinSource("already joined")).toBe("already joined")
  })

  test("returns an empty string for undefined", () => {
    expect(joinSource(undefined)).toBe("")
  })
})

describe("stripAnsi", () => {
  test("removes ANSI color escape codes from a traceback", () => {
    expect(stripAnsi("\x1b[31mValueError\x1b[0m: bad value")).toBe("ValueError: bad value")
  })

  test("leaves plain text untouched", () => {
    expect(stripAnsi("plain text")).toBe("plain text")
  })
})

describe("renderOutput", () => {
  test("prefers an image over text/html when both are present", () => {
    const output = { data: { "image/png": "base64data", "text/html": "<b>x</b>" } }
    expect(renderOutput(output)).toEqual({ kind: "image", data: "base64data" })
  })

  test("renders a stream output as text", () => {
    const output = { output_type: "stream", text: ["hello\n"] }
    expect(renderOutput(output)).toEqual({ kind: "text", content: "hello\n" })
  })

  test("renders an error output, joining and stripping ANSI from the traceback", () => {
    const output = {
      output_type: "error",
      traceback: ["\x1b[31mline one", "line two\x1b[0m"],
    }
    expect(renderOutput(output)).toEqual({ kind: "error", content: "line one\nline two" })
  })

  test("falls back to text/plain when nothing else matches", () => {
    const output = { data: { "text/plain": ["42"] } }
    expect(renderOutput(output)).toEqual({ kind: "text", content: "42" })
  })

  test("returns null for an output with no recognizable data", () => {
    expect(renderOutput({ data: {} })).toBeNull()
  })
})

describe("renderNotebook", () => {
  test("assigns sequential indices and the kernel language to code cells only", () => {
    const notebook = {
      metadata: { kernelspec: { language: "python" } },
      cells: [
        { cell_type: "markdown", source: ["# title"] },
        { cell_type: "code", source: ["1 + 1"], outputs: [] },
      ],
    }

    const cells = renderNotebook(notebook)

    expect(cells).toHaveLength(2)
    expect(cells[0]).toMatchObject({ index: 0, cell_type: "markdown", language: undefined })
    expect(cells[1]).toMatchObject({ index: 1, cell_type: "code", language: "python" })
  })

  test("renders a code cell's outputs and preserves its execution_count", () => {
    const notebook = {
      metadata: {},
      cells: [
        {
          cell_type: "code",
          source: ["1 + 1"],
          execution_count: 3,
          outputs: [{ output_type: "stream", text: ["2"] }],
        },
      ],
    }

    const cells = renderNotebook(notebook)

    expect(cells[0].execution_count).toBe(3)
    expect(cells[0].outputs).toEqual([{ kind: "text", content: "2" }])
  })
})

describe("mergeCells", () => {
  test("carries forward outputs when source and cell_type are unchanged", () => {
    const previous = [
      {
        index: 0,
        cell_type: "code" as const,
        source: "1 + 1",
        outputs: [{ kind: "text" as const, content: "2" }],
        execution_count: 1,
      },
    ]
    const fresh = [{ index: 0, cell_type: "code" as const, source: "1 + 1", outputs: [] }]

    const merged = mergeCells(previous, fresh)

    expect(merged[0].outputs).toEqual([{ kind: "text", content: "2" }])
    expect(merged[0].execution_count).toBe(1)
  })

  test("drops stale outputs when the cell's source changed", () => {
    const previous = [
      {
        index: 0,
        cell_type: "code" as const,
        source: "1 + 1",
        outputs: [{ kind: "text" as const, content: "2" }],
        execution_count: 1,
      },
    ]
    const fresh = [{ index: 0, cell_type: "code" as const, source: "2 + 2", outputs: [] }]

    const merged = mergeCells(previous, fresh)

    expect(merged[0].outputs).toEqual([])
  })

  test("passes through a cell with no previous counterpart", () => {
    const fresh = [{ index: 0, cell_type: "code" as const, source: "1 + 1", outputs: [] }]
    expect(mergeCells([], fresh)).toEqual(fresh)
  })
})

describe("syncCells", () => {
  test("carries forward outputs/execution state by index regardless of source changes", () => {
    const previous = [
      {
        index: 0,
        cell_type: "code" as const,
        source: "old",
        outputs: [{ kind: "text" as const, content: "result" }],
        execution_count: 2,
      },
    ]
    const live = [{ cell_type: "code" as const, source: "new source mid-edit" }]

    const synced = syncCells(previous, live)

    expect(synced[0].source).toBe("new source mid-edit")
    expect(synced[0].outputs).toEqual([{ kind: "text", content: "result" }])
    expect(synced[0].execution_count).toBe(2)
  })

  test("creates a fresh cell entry for an index with no previous state", () => {
    const live = [{ cell_type: "markdown" as const, source: "# hello" }]
    const synced = syncCells([], live)

    expect(synced[0]).toMatchObject({
      index: 0,
      cell_type: "markdown",
      source: "# hello",
      outputs: [],
    })
  })
})
