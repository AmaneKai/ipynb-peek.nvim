/**
 * Built-in color presets, keyed by the same snake_case names used on the Lua
 * side (`setup({ theme = { preset = "..." } })`) so no camelCase/snake_case
 * mapping layer is needed between config and CSS. Every key here has a
 * matching `--ipynb-<key-with-dashes>` custom property consumed by
 * style.css - see buildThemeCss below.
 */
export interface ThemeColors {
  bg: string
  fg: string
  surface: string
  border: string
  muted: string
  dim: string
  accent: string
  heading: string
  danger: string
  error: string
  syn_keyword: string
  syn_string: string
  syn_comment: string
  syn_number: string
  syn_function: string
  syn_variable: string
  syn_type: string
}

export const PRESETS: Record<string, ThemeColors> = {
  dark: {
    bg: "#1e1e1e",
    fg: "#d4d4d4",
    surface: "#252526",
    border: "#3c3c3c",
    muted: "#6a6a6a",
    dim: "#5a5a5a",
    accent: "#007acc",
    heading: "#e8e8e8",
    danger: "#c74e39",
    error: "#f48771",
    syn_keyword: "#569cd6",
    syn_string: "#ce9178",
    syn_comment: "#6a9955",
    syn_number: "#b5cea8",
    syn_function: "#dcdcaa",
    syn_variable: "#9cdcfe",
    syn_type: "#4ec9b0",
  },
  tokyonight: {
    bg: "#1a1b26",
    fg: "#c0caf5",
    surface: "#24283b",
    border: "#3b4261",
    muted: "#565f89",
    dim: "#414868",
    accent: "#7aa2f7",
    heading: "#c0caf5",
    danger: "#f7768e",
    error: "#f7768e",
    syn_keyword: "#bb9af7",
    syn_string: "#9ece6a",
    syn_comment: "#565f89",
    syn_number: "#ff9e64",
    syn_function: "#7aa2f7",
    syn_variable: "#c0caf5",
    syn_type: "#2ac3de",
  },
  gruvbox: {
    bg: "#282828",
    fg: "#ebdbb2",
    surface: "#3c3836",
    border: "#504945",
    muted: "#928374",
    dim: "#7c6f64",
    accent: "#fe8019",
    heading: "#fabd2f",
    danger: "#fb4934",
    error: "#fb4934",
    syn_keyword: "#fb4934",
    syn_string: "#b8bb26",
    syn_comment: "#928374",
    syn_number: "#d3869b",
    syn_function: "#fabd2f",
    syn_variable: "#ebdbb2",
    syn_type: "#fabd2f",
  },
  "rose-pine": {
    bg: "#191724",
    fg: "#e0def4",
    surface: "#1f1d2e",
    border: "#26233a",
    muted: "#6e6a86",
    dim: "#524f67",
    accent: "#c4a7e7",
    heading: "#e0def4",
    danger: "#eb6f92",
    error: "#eb6f92",
    syn_keyword: "#c4a7e7",
    syn_string: "#f6c177",
    syn_comment: "#6e6a86",
    syn_number: "#ea9a97",
    syn_function: "#9ccfd8",
    syn_variable: "#e0def4",
    syn_type: "#ebbcba",
  },
}

export interface FontConfig {
  ui?: string
  mono?: string
  size_code?: string | number
  size_md?: string | number
}

export interface ThemeConfig {
  preset?: string
  colors?: Partial<ThemeColors>
  font?: FontConfig
}

function cssVar(prefix: string, key: string): string {
  return `${prefix}${key.replace(/_/g, "-")}`
}

/**
 * A bare number is a pixel size coming straight out of Lua (`size_code =
 * 13`); a string is passed through as-is so users can hand any valid CSS
 * length/font-family list.
 */
function cssValue(value: string | number): string {
  if (typeof value === "number") return `${value}px`
  return value
}

/**
 * Builds a `:root { --ipynb-x: ... }` block from the plugin's IPYNB_PEEK_THEME
 * env var (JSON-encoded by lua/ipynb-peek/server.lua from `M.config.theme`).
 * Unset/unparseable input falls back to the `dark` preset with no per-field
 * overrides - style.css's own `var(--ipynb-x, <default>)` fallbacks already
 * match `dark` exactly, so this is mostly redundant with that, but keeps the
 * generated <style> block self-consistent even if style.css's defaults ever
 * drift.
 */
export function buildThemeCss(rawConfig: string | undefined): string {
  let config: ThemeConfig = {}
  if (rawConfig) {
    try {
      const parsed = JSON.parse(rawConfig)
      config = typeof parsed === "string" ? { preset: parsed } : (parsed ?? {})
    } catch (error) {
      console.error("[ipynb-peek] invalid IPYNB_PEEK_THEME, falling back to default:", error)
    }
  }

  const base = PRESETS[config.preset ?? "dark"] ?? PRESETS.dark
  const colors: Record<string, string> = { ...base, ...(config.colors ?? {}) }
  const font: Record<string, string | number> = { ...(config.font ?? {}) }

  const lines = [":root {"]
  for (const [key, value] of Object.entries(colors)) {
    lines.push(`  ${cssVar("--ipynb-", key)}: ${value};`)
  }
  for (const [key, value] of Object.entries(font)) {
    if (value == null) continue
    lines.push(`  ${cssVar("--ipynb-font-", key)}: ${cssValue(value)};`)
  }
  lines.push("}")
  return lines.join("\n")
}
