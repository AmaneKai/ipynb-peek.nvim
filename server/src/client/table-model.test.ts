import { describe, expect, it } from "vitest"
// @ts-expect-error plain JS module shared with the browser bundle
import { compareValues, isBlank, parseNumber, queryRows, toCsv, toMarkdown } from "./table-model.js"

const rows = [
  ["0", "carol", "30"],
  ["1", "alice", "1,200"],
  ["2", "bob", ""],
  ["3", "dave", "7.5"],
]

describe("parseNumber / compareValues", () => {
  it("parses plain, comma and percent numbers", () => {
    expect(parseNumber("1,200")).toBe(1200)
    expect(parseNumber("12.5%")).toBe(12.5)
    expect(parseNumber("1e3")).toBe(1000)
    expect(parseNumber("abc")).toBeNaN()
    expect(parseNumber("")).toBeNaN()
  })

  it("orders numbers numerically and text naturally; detects blanks", () => {
    expect(compareValues("9", "10")).toBeLessThan(0)
    expect(compareValues("a2", "a10")).toBeLessThan(0)
    expect(isBlank("")).toBe(true)
    expect(isBlank("NaN")).toBe(true)
    expect(isBlank("0")).toBe(false)
  })
})

describe("queryRows", () => {
  it("pages without sorting", () => {
    const result = queryRows(rows, { pageSize: 3, page: 1 })
    expect(result.pageRows).toEqual([3])
    expect(result.pageCount).toBe(2)
    expect(result.total).toBe(4)
  })

  it("sorts a numeric column both ways and keeps blanks last", () => {
    expect(queryRows(rows, { sortCol: 2, sortDir: "asc" }).order).toEqual([3, 0, 1, 2])
    expect(queryRows(rows, { sortCol: 2, sortDir: "desc" }).order).toEqual([1, 0, 3, 2])
  })

  it("filters across all columns, case-insensitively", () => {
    const result = queryRows(rows, { filter: "AL" })
    expect(result.order).toEqual([1])
    expect(result.matched).toBe(1)
    expect(result.total).toBe(4)
  })

  it("clamps an out-of-range page", () => {
    expect(queryRows(rows, { page: 99, pageSize: 2 }).page).toBe(1)
    expect(queryRows([], { page: 3 }).pageCount).toBe(1)
  })
})

describe("export formats", () => {
  it("quotes csv fields that need it", () => {
    expect(toCsv(["a", "b"], [["x,y", 'say "hi"']])).toBe('a,b\n"x,y","say ""hi"""\n')
  })

  it("escapes pipes in markdown tables", () => {
    expect(toMarkdown(["a"], [["x|y"]])).toBe("| a |\n| --- |\n| x\\|y |\n")
  })
})
