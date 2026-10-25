import { describe, expect, it } from "vitest"
// @ts-expect-error plain JS module shared with the browser bundle
import { formatBytes, totalBytes } from "./variables.js"

describe("variables helpers", () => {
  it("formats byte sizes", () => {
    expect(formatBytes(null)).toBe("")
    expect(formatBytes(12)).toBe("12 B")
    expect(formatBytes(2048)).toBe("2.0 KB")
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB")
    expect(formatBytes(300 * 1024 ** 3)).toBe("300 GB")
  })

  it("totals known sizes and ignores missing ones", () => {
    expect(totalBytes([{ size_bytes: 10 }, {}, { size_bytes: 5 }])).toBe(15)
  })
})
