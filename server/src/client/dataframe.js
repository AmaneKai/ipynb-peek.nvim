import { queryRows, toCsv, toMarkdown } from "./table-model.js"

const PAGE_SIZES = [10, 25, 50, 100]

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

/** Only plain pandas-style tables: one header row, no merged cells. */
function isSimpleTable(table) {
  const head = table.tHead
  if (!head || head.rows.length !== 1) return false
  if (table.tBodies.length !== 1) return false
  return !table.querySelector("[rowspan], [colspan]")
}

function enhance(table) {
  const header = [...table.tHead.rows[0].cells]
  const rowEls = [...table.tBodies[0].rows]
  const rows = rowEls.map((tr) => [...tr.cells].map((cell) => cell.textContent || ""))
  if (rowEls.length === 0) return

  const query = { filter: "", sortCol: null, sortDir: "asc", page: 0, pageSize: 10 }
  const wrap = el("div", "df-wrap")
  const bar = el("div", "df-bar")
  const search = el("input")
  search.type = "search"
  search.placeholder = "Filter rows…"
  const sizeSelect = el("select")
  for (const size of PAGE_SIZES) {
    const option = el("option", null, `${size} / page`)
    option.value = String(size)
    sizeSelect.appendChild(option)
  }
  const prev = el("button", "tool-btn", "‹ Prev")
  const next = el("button", "tool-btn", "Next ›")
  const csv = el("button", "tool-btn", "Copy CSV")
  const markdown = el("button", "tool-btn", "Copy Markdown")
  const status = el("span", "df-status")
  bar.append(search, sizeSelect, prev, next, csv, markdown, status)

  const original = table.cloneNode(true)

  function draw() {
    const result = queryRows(rows, query)
    query.page = result.page
    table.tBodies[0].replaceChildren(...result.pageRows.map((index) => rowEls[index]))
    header.forEach((th, col) => {
      if (query.sortCol === col)
        th.setAttribute("aria-sort", query.sortDir === "asc" ? "ascending" : "descending")
      else th.removeAttribute("aria-sort")
    })
    prev.disabled = result.page === 0
    next.disabled = result.page >= result.pageCount - 1
    const first = result.matched === 0 ? 0 : result.page * query.pageSize + 1
    const last = Math.min(result.matched, (result.page + 1) * query.pageSize)
    status.textContent =
      result.matched === result.total
        ? `Showing ${first}–${last} of ${result.total.toLocaleString()} rows`
        : `Showing ${first}–${last} of ${result.matched.toLocaleString()} matches (${result.total.toLocaleString()} rows)`
    return result
  }

  header.forEach((th, col) => {
    th.classList.add("sortable")
    th.addEventListener("click", () => {
      if (query.sortCol !== col) {
        query.sortCol = col
        query.sortDir = "asc"
      } else if (query.sortDir === "asc") query.sortDir = "desc"
      else query.sortCol = null
      query.page = 0
      draw()
    })
  })
  search.addEventListener("input", () => {
    query.filter = search.value
    query.page = 0
    draw()
  })
  sizeSelect.addEventListener("change", () => {
    query.pageSize = Number(sizeSelect.value)
    query.page = 0
    draw()
  })
  prev.addEventListener("click", () => {
    query.page--
    draw()
  })
  next.addEventListener("click", () => {
    query.page++
    draw()
  })

  function copyAll(format, button, label) {
    const { order } = queryRows(rows, { ...query, page: 0, pageSize: rows.length || 1 })
    const head = header.map((th) => th.textContent || "")
    const body = order.map((index) => rows[index])
    const text = format === "csv" ? toCsv(head, body) : toMarkdown(head, body)
    navigator.clipboard
      .writeText(text)
      .then(() => {
        button.textContent = "Copied ✓"
      })
      .catch(() => {
        button.textContent = "Copy failed"
      })
      .finally(() => setTimeout(() => (button.textContent = label), 1500))
  }
  csv.addEventListener("click", () => copyAll("csv", csv, "Copy CSV"))
  markdown.addEventListener("click", () => copyAll("markdown", markdown, "Copy Markdown"))

  table.replaceWith(wrap)
  wrap.append(bar, table)
  // Used by the HTML export: the whole table, unsorted and unpaged.
  wrap.__exportTable = () => original.cloneNode(true)
  draw()
}

/** Upgrades every pandas/polars-style `table.dataframe` under `root` in place. */
export function enhanceDataFrames(root) {
  for (const table of root.querySelectorAll("table.dataframe")) {
    try {
      if (isSimpleTable(table)) enhance(table)
    } catch (error) {
      console.error("[ipynb-peek] dataframe enhancement failed:", error)
    }
  }
}
