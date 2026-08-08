import { describe, test, expect } from "vitest"
import {
  joinSource,
  stripAnsi,
  applyCarriageReturns,
  imageSize,
  renderOutput,
  appendOutput,
  renderNotebook,
  readCellMetadata,
  mergeCells,
  syncCells,
  toNbformatOutput,
  patchNotebookOutputs,
  cellStatusInfo,
  type CellOutput,
  type RenderedCell,
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

describe("applyCarriageReturns", () => {
  test("collapses a bare \\r to only the last write on that line", () => {
    expect(applyCarriageReturns("\rprogress 0\rprogress 1\rprogress 2")).toBe("progress 2")
  })

  test("normalizes a trailing \\r before \\n instead of erasing the line", () => {
    expect(applyCarriageReturns("foo\r\nbar")).toBe("foo\nbar")
  })

  test("only affects the line containing the \\r, not the whole text", () => {
    expect(applyCarriageReturns("\ra\rb\nc\n")).toBe("b\nc\n")
  })

  test("leaves text with no carriage returns untouched", () => {
    expect(applyCarriageReturns("plain\ntext")).toBe("plain\ntext")
  })
})

describe("imageSize", () => {
  test("reads width/height from the mime-keyed metadata bundle", () => {
    const output = { metadata: { "image/png": { width: 100, height: 50 } } }
    expect(imageSize(output, "image/png")).toEqual({ width: 100, height: 50 })
  })

  test("returns undefined fields when metadata is absent", () => {
    expect(imageSize({}, "image/png")).toEqual({ width: undefined, height: undefined })
  })
})

describe("renderOutput", () => {
  test("prefers an image over text/html when both are present", () => {
    const output = { data: { "image/png": "base64data", "text/html": "<b>x</b>" } }
    expect(renderOutput(output)).toEqual({ kind: "image", mime: "image/png", data: "base64data" })
  })

  test("carries requested display width/height through for a PNG", () => {
    const output = {
      data: { "image/png": "base64data" },
      metadata: { "image/png": { width: 200, height: 100 } },
    }
    expect(renderOutput(output)).toEqual({
      kind: "image",
      mime: "image/png",
      data: "base64data",
      width: 200,
      height: 100,
    })
  })

  test("renders text/markdown as a markdown output instead of falling back to text/plain", () => {
    const output = { data: { "text/markdown": "**bold**", "text/plain": "**bold**" } }
    expect(renderOutput(output)).toEqual({ kind: "markdown", content: "**bold**" })
  })

  test("renders a stream output as text, tagged with its stream name", () => {
    const output = { output_type: "stream", name: "stdout", text: ["hello\n"] }
    expect(renderOutput(output)).toEqual({ kind: "text", content: "hello\n", stream: "stdout" })
  })

  test("tags a stderr stream output as stderr", () => {
    const output = { output_type: "stream", name: "stderr", text: ["uh oh\n"] }
    expect(renderOutput(output)).toEqual({ kind: "text", content: "uh oh\n", stream: "stderr" })
  })

  test("renders an error output, joining and stripping ANSI from the traceback", () => {
    const output = {
      output_type: "error",
      traceback: ["\x1b[31mline one", "line two\x1b[0m"],
    }
    expect(renderOutput(output)).toEqual({ kind: "error", content: "line one\nline two" })
  })

  test("renders text/latex as a latex output", () => {
    const output = { data: { "text/latex": "$x^2$" } }
    expect(renderOutput(output)).toEqual({ kind: "latex", content: "$x^2$" })
  })

  test("pretty-prints application/json instead of a repr placeholder", () => {
    const output = { data: { "application/json": { a: 1 } } }
    expect(renderOutput(output)).toEqual({
      kind: "text",
      content: JSON.stringify({ a: 1 }, null, 2),
    })
  })

  test("falls back to text/plain when nothing else matches", () => {
    const output = { data: { "text/plain": ["42"] } }
    expect(renderOutput(output)).toEqual({ kind: "text", content: "42" })
  })

  test("returns null for an output with no recognizable data", () => {
    expect(renderOutput({ data: {} })).toBeNull()
  })
})

describe("appendOutput", () => {
  test("merges consecutive text outputs from the same stream", () => {
    const outputs: CellOutput[] = []
    appendOutput(outputs, { kind: "text", content: "a", stream: "stdout" })
    appendOutput(outputs, { kind: "text", content: "b", stream: "stdout" })

    expect(outputs).toEqual([{ kind: "text", content: "ab", stream: "stdout" }])
  })

  test("keeps stdout and stderr chunks as separate outputs", () => {
    const outputs: CellOutput[] = []
    appendOutput(outputs, { kind: "text", content: "out", stream: "stdout" })
    appendOutput(outputs, { kind: "text", content: "err", stream: "stderr" })

    expect(outputs).toEqual([
      { kind: "text", content: "out", stream: "stdout" },
      { kind: "text", content: "err", stream: "stderr" },
    ])
  })

  test("does not merge a stream chunk into a preceding non-stream output", () => {
    const outputs: CellOutput[] = []
    appendOutput(outputs, { kind: "text", content: "42" })
    appendOutput(outputs, { kind: "text", content: "out", stream: "stdout" })

    expect(outputs).toEqual([
      { kind: "text", content: "42" },
      { kind: "text", content: "out", stream: "stdout" },
    ])
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
          outputs: [{ output_type: "stream", name: "stdout", text: ["2"] }],
        },
      ],
    }

    const cells = renderNotebook(notebook)

    expect(cells[0].execution_count).toBe(3)
    expect(cells[0].outputs).toEqual([{ kind: "text", content: "2", stream: "stdout" }])
    expect(cells[0].nbformat_outputs).toEqual([
      { output_type: "stream", name: "stdout", text: ["2"] },
    ])
  })

  test("merges consecutive same-stream stream outputs into one entry", () => {
    const notebook = {
      metadata: {},
      cells: [
        {
          cell_type: "code",
          source: ["loop"],
          outputs: [
            { output_type: "stream", name: "stdout", text: ["a"] },
            { output_type: "stream", name: "stdout", text: ["b"] },
          ],
        },
      ],
    }

    const cells = renderNotebook(notebook)

    expect(cells[0].outputs).toEqual([{ kind: "text", content: "ab", stream: "stdout" }])
  })

  test("carries each cell's metadata through, including skip-run-all-style tags", () => {
    const notebook = {
      metadata: {},
      cells: [
        {
          cell_type: "code",
          source: ["1 + 1"],
          outputs: [],
          metadata: { jupyter: { source_hidden: true }, tags: ["skip-run-all"] },
        },
      ],
    }

    const cells = renderNotebook(notebook)

    expect(cells[0].metadata).toMatchObject({ source_hidden: true, tags: ["skip-run-all"] })
  })
})

describe("readCellMetadata", () => {
  test("defaults to visible/editable/deletable with no tags for a bare cell", () => {
    expect(readCellMetadata({})).toEqual({
      source_hidden: false,
      outputs_hidden: false,
      editable: true,
      deletable: true,
      scrolled: false,
      tags: [],
    })
  })

  test("reads jupyter.source_hidden and jupyter.outputs_hidden", () => {
    const metadata = readCellMetadata({
      metadata: { jupyter: { source_hidden: true, outputs_hidden: true } },
    })
    expect(metadata.source_hidden).toBe(true)
    expect(metadata.outputs_hidden).toBe(true)
  })

  test("reads editable: false and deletable: false", () => {
    const metadata = readCellMetadata({ metadata: { editable: false, deletable: false } })
    expect(metadata.editable).toBe(false)
    expect(metadata.deletable).toBe(false)
  })

  test("reads scrolled: true and scrolled: 'auto'", () => {
    expect(readCellMetadata({ metadata: { scrolled: true } }).scrolled).toBe(true)
    expect(readCellMetadata({ metadata: { scrolled: "auto" } }).scrolled).toBe("auto")
  })

  test("reads string tags, filtering out non-string entries", () => {
    const metadata = readCellMetadata({ metadata: { tags: ["skip-run-all", 5, "slow"] } })
    expect(metadata.tags).toEqual(["skip-run-all", "slow"])
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

  test("keeps stable IDs and outputs with their cells when a cell is inserted", () => {
    const previous: RenderedCell[] = [
      {
        index: 0,
        id: "a",
        cell_type: "code",
        source: "a()",
        outputs: [{ kind: "text", content: "A" }],
      },
      {
        index: 1,
        id: "b",
        cell_type: "code",
        source: "b()",
        outputs: [{ kind: "text", content: "B" }],
      },
    ]
    const synced = syncCells(previous, [
      { cell_type: "code", source: "new()" },
      { cell_type: "code", source: "a()" },
      { cell_type: "code", source: "b()" },
    ])

    expect(synced[0].id).toBeUndefined()
    expect(synced[0].outputs).toEqual([])
    expect(synced[1]).toMatchObject({ id: "a", index: 1, outputs: [{ content: "A" }] })
    expect(synced[2]).toMatchObject({ id: "b", index: 2, outputs: [{ content: "B" }] })
  })

  test("keeps identity across a normal source edit", () => {
    const previous: RenderedCell[] = [
      { index: 0, id: "a", cell_type: "code", source: "old", outputs: [] },
    ]
    const synced = syncCells(previous, [{ cell_type: "code", source: "edited" }])
    expect(synced[0]).toMatchObject({ id: "a", index: 0, source: "edited" })
  })
})

describe("toNbformatOutput", () => {
  test("keeps a stream output's exact output_type and name", () => {
    const output = toNbformatOutput({ kind: "text", content: "hi\n", stream: "stderr" })
    expect(output).toEqual({ output_type: "stream", name: "stderr", text: ["hi\n"] })
  })

  test("renders a non-stream text output as display_data", () => {
    const output = toNbformatOutput({ kind: "text", content: "42" })
    expect(output).toEqual({
      output_type: "display_data",
      data: { "text/plain": ["42"] },
      metadata: {},
    })
  })

  test("renders an image output as display_data with image/png data", () => {
    const output = toNbformatOutput({ kind: "image", mime: "image/png", data: "base64data" })
    expect(output).toEqual({
      output_type: "display_data",
      data: { "image/png": "base64data" },
      metadata: {},
    })
  })

  test("round-trips requested image width/height into mime-keyed metadata", () => {
    const output = toNbformatOutput({
      kind: "image",
      mime: "image/png",
      data: "base64data",
      width: 200,
      height: 100,
    })
    expect(output).toEqual({
      output_type: "display_data",
      data: { "image/png": "base64data" },
      metadata: { "image/png": { width: 200, height: 100 } },
    })
  })

  test("renders a markdown output as display_data with text/markdown data", () => {
    const output = toNbformatOutput({ kind: "markdown", content: "**bold**" })
    expect(output).toEqual({
      output_type: "display_data",
      data: { "text/markdown": ["**bold**"] },
      metadata: {},
    })
  })

  test("renders an error output with the traceback split back into lines", () => {
    const output = toNbformatOutput({ kind: "error", content: "line one\nline two" })
    expect(output).toEqual({
      output_type: "error",
      ename: "Error",
      evalue: "",
      traceback: ["line one", "line two"],
    })
  })
})

describe("patchNotebookOutputs", () => {
  function makeCell(overrides: Partial<RenderedCell> = {}): RenderedCell {
    return { index: 0, cell_type: "code", source: "1 + 1", outputs: [], ...overrides }
  }

  test("writes outputs and execution_count into the matching cell by source text", () => {
    const notebookJson: any = {
      cells: [{ cell_type: "code", source: ["1 + 1"], outputs: [], execution_count: null }],
    }
    const cells = [
      makeCell({
        outputs: [{ kind: "text", content: "2", stream: "stdout" }],
        execution_count: 1,
      }),
    ]

    patchNotebookOutputs(notebookJson, cells)

    expect(notebookJson.cells[0].outputs).toEqual([
      { output_type: "stream", name: "stdout", text: ["2"] },
    ])
    expect(notebookJson.cells[0].execution_count).toBe(1)
  })

  test("skips a cell that's still busy, rather than persisting a mid-execution snapshot", () => {
    const notebookJson: any = {
      cells: [{ cell_type: "code", source: ["1 + 1"], outputs: [], execution_count: null }],
    }
    const cells = [makeCell({ status: "busy", outputs: [] })]

    patchNotebookOutputs(notebookJson, cells)

    expect(notebookJson.cells[0].outputs).toEqual([])
  })

  test("skips a cell with no matching source anywhere in the notebook file", () => {
    const notebookJson: any = {
      cells: [{ cell_type: "code", source: ["untouched"], outputs: [], execution_count: null }],
    }
    const cells = [
      makeCell({
        source: "not present on disk",
        outputs: [{ kind: "text", content: "x" }],
        execution_count: 1,
      }),
    ]

    patchNotebookOutputs(notebookJson, cells)

    expect(notebookJson.cells[0].outputs).toEqual([])
    expect(notebookJson.cells[0].execution_count).toBeNull()
  })

  test("skips a cell with no execution results to persist", () => {
    const notebookJson: any = {
      cells: [{ cell_type: "code", source: ["1 + 1"], outputs: [], execution_count: null }],
    }
    const cells = [makeCell()]

    patchNotebookOutputs(notebookJson, cells)

    expect(notebookJson.cells[0].outputs).toEqual([])
    expect(notebookJson.cells[0].execution_count).toBeNull()
  })

  test("uses stable cell IDs when identical source appears more than once", () => {
    const notebookJson: any = {
      cells: [
        { id: "first", cell_type: "code", source: ["x"], outputs: [], execution_count: null },
        { id: "second", cell_type: "code", source: ["x"], outputs: [], execution_count: null },
      ],
    }
    const cells = [
      makeCell({ id: "first", source: "x", outputs: [{ kind: "text", content: "one" }] }),
      makeCell({ id: "second", source: "x", outputs: [{ kind: "text", content: "two" }] }),
    ]

    patchNotebookOutputs(notebookJson, cells)

    expect(notebookJson.cells[0].outputs[0].data["text/plain"]).toEqual(["one"])
    expect(notebookJson.cells[1].outputs[0].data["text/plain"]).toEqual(["two"])
  })

  test("does not collapse duplicate legacy cells onto the first source match", () => {
    const notebookJson: any = {
      cells: [
        { cell_type: "code", source: ["x"], outputs: [], execution_count: null },
        { cell_type: "code", source: ["x"], outputs: [], execution_count: null },
      ],
    }
    const cells = [
      makeCell({ source: "x", outputs: [{ kind: "text", content: "one" }] }),
      makeCell({ index: 1, source: "x", outputs: [{ kind: "text", content: "two" }] }),
    ]

    patchNotebookOutputs(notebookJson, cells)

    expect(notebookJson.cells[0].outputs[0].data["text/plain"]).toEqual(["one"])
    expect(notebookJson.cells[1].outputs[0].data["text/plain"]).toEqual(["two"])
  })

  test("persists the exact MIME bundle and metadata retained from Jupyter", () => {
    const exactOutput = {
      output_type: "execute_result",
      execution_count: 4,
      data: { "text/html": "<b>42</b>", "text/plain": "42" },
      metadata: { isolated: true },
    }
    const notebookJson: any = {
      cells: [{ id: "a", cell_type: "code", source: ["x"], outputs: [] }],
    }
    patchNotebookOutputs(notebookJson, [
      makeCell({ id: "a", source: "x", nbformat_outputs: [exactOutput], execution_count: 4 }),
    ])

    expect(notebookJson.cells[0].outputs).toEqual([exactOutput])
  })
})

describe("cellStatusInfo", () => {
  function makeCell(overrides: Partial<RenderedCell> = {}): RenderedCell {
    return { index: 0, cell_type: "code", source: "1 + 1", outputs: [], ...overrides }
  }

  test("reports busy status while a cell is executing", () => {
    const info = cellStatusInfo(makeCell({ status: "busy" }), 2)
    expect(info).toEqual({
      index: 2,
      status: "busy",
      execution_count: undefined,
      duration_ms: undefined,
      has_error: false,
    })
  })

  test("reports has_error true when the last output is an error, alongside its execution_count", () => {
    const info = cellStatusInfo(
      makeCell({
        status: "idle",
        execution_count: 3,
        outputs: [{ kind: "error", content: "boom" }],
      }),
      0,
    )
    expect(info.has_error).toBe(true)
    expect(info.execution_count).toBe(3)
  })

  test("reports has_error false with an execution_count for a successful run", () => {
    const info = cellStatusInfo(
      makeCell({
        status: "idle",
        execution_count: 1,
        duration_ms: 250,
        outputs: [{ kind: "text", content: "2" }],
      }),
      0,
    )
    expect(info.has_error).toBe(false)
    expect(info.execution_count).toBe(1)
    expect(info.duration_ms).toBe(250)
  })

  test("reports a null execution_count and no error for a cell that's never been run", () => {
    const info = cellStatusInfo(makeCell({ execution_count: null }), 0)
    expect(info.execution_count).toBeNull()
    expect(info.has_error).toBe(false)
  })

  test("uses the index parameter rather than the cell's own (possibly stale) index field", () => {
    const info = cellStatusInfo(makeCell({ index: 9 }), 3)
    expect(info.index).toBe(3)
  })
})
