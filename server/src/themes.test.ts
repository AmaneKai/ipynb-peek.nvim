import { describe, test, expect } from "vitest"
import { buildThemeCss, PRESETS } from "./themes"

describe("buildThemeCss", () => {
  test("falls back to the dark preset when given undefined", () => {
    const css = buildThemeCss(undefined)
    expect(css).toContain(`--ipynb-bg: ${PRESETS.dark.bg};`)
    expect(css).toContain(`--ipynb-syn-keyword: ${PRESETS.dark.syn_keyword};`)
  })

  test("falls back to the dark preset for invalid JSON, without throwing", () => {
    const css = buildThemeCss("not json")
    expect(css).toContain(`--ipynb-bg: ${PRESETS.dark.bg};`)
  })

  test("falls back to the dark preset for an unknown preset name", () => {
    const css = buildThemeCss(JSON.stringify({ preset: "nonexistent" }))
    expect(css).toContain(`--ipynb-bg: ${PRESETS.dark.bg};`)
  })

  test("accepts a bare preset name string, not just an object", () => {
    const css = buildThemeCss(JSON.stringify("gruvbox"))
    expect(css).toContain(`--ipynb-bg: ${PRESETS.gruvbox.bg};`)
  })

  test("applies a named preset's colors", () => {
    const css = buildThemeCss(JSON.stringify({ preset: "tokyonight" }))
    expect(css).toContain(`--ipynb-bg: ${PRESETS.tokyonight.bg};`)
    expect(css).toContain(`--ipynb-accent: ${PRESETS.tokyonight.accent};`)
  })

  test("per-field color overrides win over the preset", () => {
    const css = buildThemeCss(JSON.stringify({ preset: "dark", colors: { bg: "#123456" } }))
    expect(css).toContain("--ipynb-bg: #123456;")
    // Untouched fields still come from the preset.
    expect(css).toContain(`--ipynb-fg: ${PRESETS.dark.fg};`)
  })

  test("renders font overrides, converting bare numbers to pixel sizes", () => {
    const css = buildThemeCss(
      JSON.stringify({ font: { mono: "Fira Code", size_code: 13, size_md: "1.1em" } }),
    )
    expect(css).toContain("--ipynb-font-mono: Fira Code;")
    expect(css).toContain("--ipynb-font-size-code: 13px;")
    expect(css).toContain("--ipynb-font-size-md: 1.1em;")
  })

  test("omits font lines entirely when no font config is given", () => {
    const css = buildThemeCss(undefined)
    expect(css).not.toContain("--ipynb-font-")
  })
})
