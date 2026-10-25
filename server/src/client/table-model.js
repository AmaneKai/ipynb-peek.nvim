/** Sorting, filtering, paging and export for dataframe-style tables. Pure. */

export function parseNumber(text) {
  const cleaned = String(text).trim().replace(/,/g, "").replace(/%$/, "")
  if (cleaned === "" || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(cleaned)) return NaN
  return Number(cleaned)
}

export function isBlank(text) {
  return text.trim() === "" || text === "NaN" || text === "None"
}

/** Numbers sort numerically, other text alphabetically. Blanks are the caller's concern. */
export function compareValues(a, b) {
  const numA = parseNumber(a)
  const numB = parseNumber(b)
  if (!Number.isNaN(numA) && !Number.isNaN(numB)) return numA - numB
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
}

/**
 * @param {string[][]} rows cell text per row
 * @param {{filter?: string, sortCol?: number|null, sortDir?: "asc"|"desc", page?: number, pageSize?: number}} query
 * @returns {{order: number[], pageRows: number[], total: number, matched: number,
 *            page: number, pageCount: number}}
 *   `order` is every matching row index, sorted; `pageRows` the current page of it.
 */
export function queryRows(rows, query) {
  const needle = (query.filter || "").trim().toLowerCase()
  let order = rows.map((_, index) => index)
  if (needle)
    order = order.filter((index) => rows[index].some((text) => text.toLowerCase().includes(needle)))

  if (query.sortCol != null) {
    const direction = query.sortDir === "desc" ? -1 : 1
    const col = query.sortCol
    // Array.prototype.sort is stable, so ties keep their original order.
    order = order.slice().sort((a, b) => {
      const left = rows[a][col] ?? ""
      const right = rows[b][col] ?? ""
      // Blanks sink to the bottom whichever way the column is sorted.
      if (isBlank(left) || isBlank(right))
        return isBlank(left) === isBlank(right) ? 0 : isBlank(left) ? 1 : -1
      return direction * compareValues(left, right)
    })
  }

  const pageSize = query.pageSize || 10
  const pageCount = Math.max(1, Math.ceil(order.length / pageSize))
  const page = Math.min(Math.max(0, query.page || 0), pageCount - 1)
  return {
    order,
    pageRows: order.slice(page * pageSize, (page + 1) * pageSize),
    total: rows.length,
    matched: order.length,
    page,
    pageCount,
  }
}

function csvField(text) {
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function toCsv(header, rows) {
  return [header, ...rows].map((row) => row.map(csvField).join(",")).join("\n") + "\n"
}

export function toMarkdown(header, rows) {
  const escape = (text) => text.replace(/\|/g, "\\|").replace(/\n/g, " ")
  const line = (row) => "| " + row.map(escape).join(" | ") + " |"
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n") + "\n"
}
