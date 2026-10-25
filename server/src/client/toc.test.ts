import { describe, expect, it } from "vitest"
// @ts-expect-error plain JS module shared with the browser bundle
import { buildToc, codeStatus, firstCodeLine, markdownHeadings } from "./toc.js"

describe("markdownHeadings", () => {
  it("finds ATX headings with their levels", () => {
    expect(markdownHeadings("# Title\ntext\n## Part *two*  ##")).toEqual([
      { level: 1, title: "Title" },
      { level: 2, title: "Part *two*" },
    ])
  })

  it("ignores hashes inside code fences and non-headings", () => {
    expect(markdownHeadings("```python\n# comment\n```\n#hashtag\n####### seven")).toEqual([])
  })
})

describe("firstCodeLine / codeStatus", () => {
  it("uses the first non-empty line, truncated", () => {
    expect(firstCodeLine("\n\n  import pandas as pd\nx")).toBe("import pandas as pd")
    expect(firstCodeLine("x".repeat(100))).toHaveLength(60)
    expect(firstCodeLine("  \n")).toBe("(empty)")
  })

  it("prioritizes busy, then error, then ok", () => {
    expect(codeStatus({ status: "busy", outputs: [] })).toBe("busy")
    expect(codeStatus({ outputs: [{ kind: "error" }], execution_count: 2 })).toBe("error")
    expect(codeStatus({ outputs: [], execution_count: 2 })).toBe("ok")
    expect(codeStatus({ outputs: [] })).toBe("idle")
  })
})

describe("buildToc", () => {
  it("lists headings and code cells in order, nesting code under its heading", () => {
    const toc = buildToc([
      { cell_type: "markdown", source: "# Load\n## Raw" },
      {
        cell_type: "code",
        source: "df = read()",
        outputs: [],
        execution_count: 1,
        duration_ms: 120,
      },
      { cell_type: "raw", source: "skip" },
      { cell_type: "markdown", source: "prose only" },
      { cell_type: "code", source: "df.head()", outputs: [{ kind: "error" }] },
    ])
    expect(toc.map((e: any) => [e.index, e.kind, e.level, e.label])).toEqual([
      [0, "heading", 1, "Load"],
      [0, "heading", 2, "Raw"],
      [1, "code", 3, "df = read()"],
      [4, "code", 3, "df.head()"],
    ])
    expect(toc[2].status).toBe("ok")
    expect(toc[3].status).toBe("error")
  })

  it("nests code at level 1 before any heading", () => {
    expect(buildToc([{ cell_type: "code", source: "x", outputs: [] }])[0].level).toBe(1)
  })
})
