/** Kernel variable inspector panel ("Kernel Peek"). */

export function formatBytes(bytes) {
  if (bytes == null) return ""
  if (bytes < 1024) return bytes + " B"
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes
  let unit = -1
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return value.toFixed(value >= 100 ? 0 : 1) + " " + units[unit]
}

export function totalBytes(rows) {
  return rows.reduce((sum, row) => sum + (row.size_bytes || 0), 0)
}

function cell(tag, text, className) {
  const element = document.createElement(tag)
  element.textContent = text
  if (className) element.className = className
  return element
}

/** @param {{open: boolean, rows: object[]|null, error: string|null}} variables */
export function renderVariables(container, variables) {
  if (!variables.open) return
  if (variables.error) {
    container.replaceChildren(cell("div", variables.error, "vars-error"))
    return
  }
  if (!variables.rows) {
    container.replaceChildren(
      cell("div", "Reading kernel namespace… (waits for any running cell to finish)", "vars-note"),
    )
    return
  }
  if (variables.rows.length === 0) {
    container.replaceChildren(cell("div", "No user variables in the kernel yet.", "vars-note"))
    return
  }

  const table = document.createElement("table")
  table.className = "vars-table"
  const head = table.createTHead().insertRow()
  for (const title of ["Name", "Type", "Shape / size", "Memory", "Preview"])
    head.appendChild(cell("th", title))
  const body = table.createTBody()
  for (const row of variables.rows) {
    const tr = body.insertRow()
    tr.appendChild(cell("td", row.name))
    tr.appendChild(cell("td", row.type))
    tr.appendChild(cell("td", row.shape || "", "num"))
    tr.appendChild(cell("td", formatBytes(row.size_bytes), "num"))
    tr.appendChild(cell("td", row.preview || "", "preview"))
  }
  container.replaceChildren(
    cell(
      "div",
      `${variables.rows.length} variables · ~${formatBytes(totalBytes(variables.rows))}`,
      "vars-note",
    ),
    table,
  )
}
