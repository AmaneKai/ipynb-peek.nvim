import { AnsiUp } from "ansi_up"
import DOMPurify from "dompurify"
import hljs from "highlight.js/lib/core"
import python from "highlight.js/lib/languages/python"
import { marked } from "marked"
import { cellKey } from "./store.js"
import { cellSignature } from "./reconcile.js"
import { renderMath } from "./math.js"
import { renderTraceback } from "./traceback.js"
import { enhanceDataFrames } from "./dataframe.js"
import { renderChart } from "./charts.js"

const ansiUp = new AnsiUp()
hljs.registerLanguage("python", python)

function formatSeconds(milliseconds) {
  return (milliseconds / 1000).toFixed(1) + "s"
}

/**
 * Builds and updates the DOM for individual cells. Each page cell is an
 * "entry": { cell, index, sig, el, bar } where `el` is the cell element and
 * `bar` the "+ Code / + Markdown" bar after it. The view never reads global
 * state - what to show is passed in, and user actions go out through `deps`.
 *
 * deps: { sessionToken, state(), onInsert(afterIndex, type), onDelete(index),
 *         onInterrupt(), onTracebackJump(link, ownIndex), onToggleSource(key), onToggleOutputs(key), onOpenImage(src) }
 */
export function createCellView(deps) {
  const highlightObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        highlightObserver.unobserve(entry.target)
        try {
          hljs.highlightElement(entry.target)
        } catch (error) {
          console.error("[ipynb-peek] syntax highlighting failed:", error)
        }
      }
    },
    // Highlight just before a cell scrolls into view so users normally never
    // see the unhighlighted intermediate state.
    { rootMargin: "600px 0px" },
  )

  // One shared interval drives every busy cell's elapsed-time readout.
  const busyTicks = new Map()
  let busyTimer = null

  function setBusyTick(entry, tick) {
    busyTicks.set(entry, tick)
    if (!busyTimer) {
      busyTimer = setInterval(() => {
        for (const run of busyTicks.values()) run()
      }, 100)
    }
  }

  function clearBusyTick(entry) {
    busyTicks.delete(entry)
    if (busyTicks.size === 0 && busyTimer) {
      clearInterval(busyTimer)
      busyTimer = null
    }
  }

  function localizeImages(root) {
    for (const img of root.querySelectorAll("img[src]")) {
      const src = img.getAttribute("src") || ""
      if (!src || /^(?:[a-z]+:|\/\/|#|data:)/i.test(src)) continue
      const query = new URLSearchParams({ path: src, token: deps.sessionToken })
      img.src = "/notebook-asset?" + query
    }
  }

  function renderOutputs(outputs, scrolled, entry) {
    const wrap = document.createElement("div")
    wrap.className = "outputs" + (scrolled ? " scrolled" : "")
    for (const out of outputs || []) {
      if (out.kind === "image") {
        const img = document.createElement("img")
        const mime = out.mime || "image/png"
        img.src =
          mime === "image/svg+xml"
            ? "data:image/svg+xml;charset=utf-8," + encodeURIComponent(out.data)
            : `data:${mime};base64,${out.data}`
        if (out.width) img.style.width = out.width + "px"
        if (out.height) img.style.height = out.height + "px"
        img.addEventListener("click", () => deps.onOpenImage(img.src))
        wrap.appendChild(img)
      } else if (out.kind === "plotly" || out.kind === "vega") {
        wrap.appendChild(renderChart(out))
      } else if (out.kind === "html") {
        const div = document.createElement("div")
        div.className = "table-scroll"
        div.innerHTML = DOMPurify.sanitize(out.content)
        localizeImages(div)
        enhanceDataFrames(div)
        wrap.appendChild(div)
      } else if (out.kind === "markdown") {
        const div = document.createElement("div")
        div.className = "md-cell"
        div.innerHTML = DOMPurify.sanitize(marked.parse(out.content || ""))
        localizeImages(div)
        renderMath(div)
        wrap.appendChild(div)
      } else if (out.kind === "latex") {
        const div = document.createElement("div")
        div.textContent = out.content
        renderMath(div)
        wrap.appendChild(div)
      } else if (out.kind === "text") {
        const pre = document.createElement("pre")
        if (out.stream === "stderr") pre.className = "stderr-output"
        pre.innerHTML = ansiUp.ansi_to_html(out.content)
        wrap.appendChild(pre)
      } else if (out.kind === "error") {
        wrap.appendChild(
          renderTraceback(out.content || "", (link) => deps.onTracebackJump(link, entry.index)),
        )
      } else {
        const pre = document.createElement("pre")
        pre.textContent = out.content
        wrap.appendChild(pre)
      }
    }
    return wrap
  }

  function renderTagChips(cell) {
    const tags = (cell.metadata && cell.metadata.tags) || []
    if (!tags.length) return null
    const tagsEl = document.createElement("div")
    tagsEl.className = "cell-tags"
    for (const tag of tags) {
      const chip = document.createElement("span")
      chip.className = "tag-chip"
      chip.textContent = tag
      tagsEl.appendChild(chip)
    }
    return tagsEl
  }

  function renderHiddenBar(label, onClick) {
    const bar = document.createElement("button")
    bar.className = "hidden-bar"
    bar.textContent = label
    bar.addEventListener("click", onClick)
    return bar
  }

  function renderFoldButton(title, onClick) {
    const button = document.createElement("button")
    button.className = "fold-btn"
    button.textContent = "▾"
    button.title = title
    button.addEventListener("click", onClick)
    return button
  }

  /** Builds the cell element for `entry.cell` at `entry.index` (side effect: wires busy tick). */
  function renderCell(entry) {
    const { cell } = entry
    const state = deps.state()
    const key = cellKey(cell, entry.index)
    const el = document.createElement("div")
    el.className = "cell"

    const metadata = cell.metadata || {}

    const cellNumber = document.createElement("div")
    cellNumber.className = "cell-number"
    cellNumber.textContent = String(entry.index + 1)
    el.appendChild(cellNumber)

    const tagChips = renderTagChips(cell)
    if (tagChips) el.appendChild(tagChips)

    if (metadata.deletable !== false && metadata.editable !== false) {
      const deleteBtn = document.createElement("button")
      deleteBtn.className = "delete-cell-btn"
      deleteBtn.textContent = "✕"
      deleteBtn.title = "Delete cell"
      deleteBtn.addEventListener("click", () => deps.onDelete(entry.index))
      el.appendChild(deleteBtn)
    }

    if (cell.cell_type === "markdown") {
      el.classList.add("md-cell")
      const content = document.createElement("div")
      content.innerHTML = DOMPurify.sanitize(marked.parse(cell.source || ""))
      localizeImages(content)
      renderMath(content)
      el.appendChild(content)
    } else if (cell.cell_type === "code") {
      el.classList.add("code-cell")

      // Folded = what the notebook metadata says, flipped if the user toggled it.
      const sourceHidden = Boolean(metadata.source_hidden) !== state.revealedSource.has(key)
      if (sourceHidden) {
        const bar = renderHiddenBar("‣ input hidden - click to show", () =>
          deps.onToggleSource(key),
        )
        bar.classList.add("input-hidden-bar")
        el.appendChild(bar)
      } else {
        const box = document.createElement("div")
        box.className = "code-box"
        box.appendChild(renderFoldButton("Fold input", () => deps.onToggleSource(key)))

        const pre = document.createElement("pre")
        const code = document.createElement("code")
        code.className = "language-" + (cell.language || "python")
        code.textContent = cell.source || ""
        pre.appendChild(code)
        box.appendChild(pre)

        const statusBar = document.createElement("span")
        statusBar.className = "status-bar"

        const execCount = document.createElement("span")
        execCount.className = "exec-count"
        statusBar.appendChild(execCount)

        const timing = document.createElement("span")
        timing.className = "timing"
        statusBar.appendChild(timing)

        if (cell.status === "busy") {
          const interruptBtn = document.createElement("button")
          interruptBtn.className = "interrupt-btn"
          interruptBtn.textContent = "■"
          interruptBtn.title = "Interrupt kernel"
          interruptBtn.addEventListener("click", deps.onInterrupt)
          statusBar.appendChild(interruptBtn)
        }

        const tick = () => {
          if (cell.status !== "busy") {
            execCount.classList.remove("busy")
            execCount.textContent = cell.execution_count ? "[" + cell.execution_count + "]" : "[ ]"
            timing.textContent = cell.duration_ms != null ? formatSeconds(cell.duration_ms) : ""
            return
          }
          execCount.textContent = "[*]"
          execCount.classList.add("busy")
          timing.textContent = formatSeconds(Date.now() - (cell.started_at || Date.now()))
        }
        tick()
        if (cell.status === "busy") setBusyTick(entry, tick)

        box.appendChild(statusBar)

        const langLabel = document.createElement("span")
        langLabel.className = "lang-label"
        langLabel.textContent = cell.language || ""
        box.appendChild(langLabel)

        el.appendChild(box)

        highlightObserver.observe(code)
      }

      if (cell.outputs && cell.outputs.length) {
        const outputsHidden = Boolean(metadata.outputs_hidden) !== state.revealedOutputs.has(key)
        if (outputsHidden) {
          el.appendChild(
            renderHiddenBar("‣ output hidden - click to show", () => deps.onToggleOutputs(key)),
          )
        } else {
          const wrap = renderOutputs(cell.outputs, metadata.scrolled === true, entry)
          wrap.prepend(renderFoldButton("Fold output", () => deps.onToggleOutputs(key)))
          el.appendChild(wrap)
        }
      }
    } else {
      el.classList.add("raw-cell")
      const pre = document.createElement("pre")
      pre.textContent = cell.source || ""
      el.appendChild(pre)
    }

    return el
  }

  function renderAddBar(entry) {
    const bar = document.createElement("div")
    bar.className = "add-cell-bar"

    for (const [label, type] of [
      ["+ Code", "code"],
      ["+ Markdown", "markdown"],
    ]) {
      const button = document.createElement("button")
      button.className = "add-cell-btn"
      button.textContent = label
      // Reads entry.index at click time: the entry keeps its DOM when cells
      // are inserted above it, so its position is not fixed at creation.
      button.addEventListener("click", () => deps.onInsert(entry.index, type))
      bar.appendChild(button)
    }
    return bar
  }

  function releaseCell(entry) {
    const code = entry.el.querySelector(".code-box code")
    if (code) highlightObserver.unobserve(code)
    clearBusyTick(entry)
  }

  return {
    /** A leading "+ Code / + Markdown" bar, inserting before the first cell. */
    createLeadingBar() {
      return renderAddBar({
        get index() {
          return -1
        },
      })
    },

    create(cell, index) {
      const entry = { cell, index, sig: cellSignature(cell), el: null, bar: null }
      entry.el = renderCell(entry)
      entry.bar = renderAddBar(entry)
      return entry
    },

    /** Re-renders `entry` in place for a new cell value / position. */
    update(entry, cell, index) {
      releaseCell(entry)
      const previous = entry.el
      entry.cell = cell
      entry.index = index
      entry.sig = cellSignature(cell)
      entry.el = renderCell(entry)
      if (previous.classList.contains("active-cell")) entry.el.classList.add("active-cell")
      previous.replaceWith(entry.el)
    },

    /** Cell kept as-is but moved: only its displayed number changes. */
    setIndex(entry, index) {
      if (entry.index === index) return
      entry.index = index
      const number = entry.el.querySelector(".cell-number")
      if (number) number.textContent = String(index + 1)
    },

    destroy(entry) {
      releaseCell(entry)
      entry.el.remove()
      entry.bar.remove()
    },
  }
}
