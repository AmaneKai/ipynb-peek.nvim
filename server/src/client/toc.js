/**
 * Outline model for the sidebar: markdown headings plus one row per code
 * cell, in notebook order. Pure data in, rows out.
 */

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/

/** Headings of a markdown cell, skipping anything inside ``` fences. */
export function markdownHeadings(source) {
  const headings = []
  let fenced = false
  for (const line of (source || "").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const match = HEADING.exec(line)
    if (match) headings.push({ level: match[1].length, title: match[2] })
  }
  return headings
}

export function firstCodeLine(source) {
  for (const line of (source || "").split("\n")) {
    const trimmed = line.trim()
    if (trimmed) return trimmed.length > 60 ? trimmed.slice(0, 59) + "…" : trimmed
  }
  return "(empty)"
}

/** busy | error | ok | idle */
export function codeStatus(cell) {
  if (cell.status === "busy") return "busy"
  if ((cell.outputs || []).some((output) => output.kind === "error")) return "error"
  if (cell.execution_count != null) return "ok"
  return "idle"
}

/**
 * @returns {{index: number, kind: "heading"|"code", level: number, label: string,
 *            status?: string, duration_ms?: number, execution_count?: number|null}[]}
 * `level` is the heading depth (1-6); code rows nest one level below the most
 * recent heading (level 1 before any heading).
 */
export function buildToc(cells) {
  const entries = []
  let currentLevel = 0
  cells.forEach((cell, index) => {
    if (cell.cell_type === "markdown") {
      for (const heading of markdownHeadings(cell.source)) {
        currentLevel = heading.level
        entries.push({ index, kind: "heading", level: heading.level, label: heading.title })
      }
    } else if (cell.cell_type === "code") {
      entries.push({
        index,
        kind: "code",
        level: Math.min(currentLevel + 1, 7),
        label: firstCodeLine(cell.source),
        status: codeStatus(cell),
        duration_ms: cell.duration_ms,
        execution_count: cell.execution_count,
      })
    }
  })
  return entries
}

const BADGES = { busy: "●", error: "✗", ok: "✓", idle: "○" }

function formatDuration(ms) {
  return ms == null ? "" : (ms / 1000).toFixed(1) + "s"
}

/** Rebuilds the sidebar rows. `onSelect(index)` is called when a row is clicked. */
export function renderToc(container, entries, activeIndex, onSelect) {
  const fragment = document.createDocumentFragment()
  if (entries.length === 0) {
    const empty = document.createElement("div")
    empty.className = "toc-empty"
    empty.textContent = "No cells yet"
    fragment.appendChild(empty)
  }
  for (const entry of entries) {
    const row = document.createElement("button")
    row.className = `toc-row toc-${entry.kind}` + (entry.index === activeIndex ? " active" : "")
    row.style.paddingLeft = 8 + (entry.level - 1) * 12 + "px"
    row.title = entry.label

    if (entry.kind === "code") {
      const badge = document.createElement("span")
      badge.className = `toc-badge toc-${entry.status}`
      badge.textContent = BADGES[entry.status]
      row.appendChild(badge)

      const count = document.createElement("span")
      count.className = "toc-count"
      count.textContent = entry.execution_count ? `[${entry.execution_count}]` : "[ ]"
      row.appendChild(count)
    }

    const label = document.createElement("span")
    label.className = "toc-label"
    label.textContent = entry.label
    row.appendChild(label)

    if (entry.kind === "code" && entry.status !== "busy" && entry.duration_ms != null) {
      const time = document.createElement("span")
      time.className = "toc-time"
      time.textContent = formatDuration(entry.duration_ms)
      row.appendChild(time)
    }

    row.addEventListener("click", () => onSelect(entry.index))
    fragment.appendChild(row)
  }
  container.replaceChildren(fragment)
}
