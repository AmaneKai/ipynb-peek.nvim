import { AnsiUp } from "https://cdn.jsdelivr.net/npm/ansi_up@6.0.6/+esm"

const ansiUp = new AnsiUp()

;(function () {
  /**
   * Tags the page title with this server instance's port, so the Neovim
   * plugin's best-effort popup-close logic (window title matching on
   * non-macOS platforms) can find the right window among any others.
   */
  document.title = "ipynb-peek:" + location.port

  const container = document.getElementById("notebook")
  const cellEls = []
  const cellTimers = []

  const lightbox = document.getElementById("lightbox")
  const lightboxImg = document.getElementById("lightbox-img")
  function openLightbox(src) {
    lightboxImg.src = src
    lightbox.classList.add("open")
  }
  function closeLightbox() {
    lightbox.classList.remove("open")
  }
  lightbox.addEventListener("click", closeLightbox)
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeLightbox()
  })

  /**
   * Runs after marked.js has already turned markdown into HTML, so KaTeX
   * only ever sees plain text/HTML, never raw markdown syntax - matches how
   * Jupyter's own markdown-it + katex renderer is ordered.
   */
  function renderMath(container) {
    if (!window.renderMathInElement) return

    try {
      renderMathInElement(container, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "$", right: "$", display: false },
          { left: "\\(", right: "\\)", display: false },
          { left: "\\[", right: "\\]", display: true },
        ],
        throwOnError: false,
      })
    } catch (error) {
      console.error("[ipynb-peek] LaTeX rendering failed:", error)
    }
  }

  function clearCellTimer(index) {
    if (!cellTimers[index]) return
    clearInterval(cellTimers[index])
    cellTimers[index] = null
  }

  function formatSeconds(milliseconds) {
    return (milliseconds / 1000).toFixed(1) + "s"
  }

  function renderOutputs(outputs) {
    const wrap = document.createElement("div")
    wrap.className = "outputs"
    for (const out of outputs || []) {
      if (out.kind === "image") {
        const img = document.createElement("img")
        img.src = "data:image/png;base64," + out.data
        img.addEventListener("click", () => openLightbox(img.src))
        wrap.appendChild(img)
      } else if (out.kind === "html") {
        const div = document.createElement("div")
        div.className = "table-scroll"
        div.innerHTML = out.content
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
      } else {
        const pre = document.createElement("pre")
        if (out.kind === "error") pre.className = "error-output"
        pre.textContent = out.content
        wrap.appendChild(pre)
      }
    }
    return wrap
  }

  function renderCell(cell, index) {
    const el = document.createElement("div")
    el.className = "cell"

    const cellNumber = document.createElement("div")
    cellNumber.className = "cell-number"
    cellNumber.textContent = String(index + 1)
    el.appendChild(cellNumber)

    const deleteBtn = document.createElement("button")
    deleteBtn.className = "delete-cell-btn"
    deleteBtn.textContent = "✕"
    deleteBtn.title = "Delete cell"
    deleteBtn.addEventListener("click", () => sendDelete(index))
    el.appendChild(deleteBtn)

    if (cell.cell_type === "markdown") {
      el.classList.add("md-cell")
      const content = document.createElement("div")
      content.innerHTML = marked.parse(cell.source || "")
      renderMath(content)
      el.appendChild(content)
    } else if (cell.cell_type === "code") {
      el.classList.add("code-cell")
      const box = document.createElement("div")
      box.className = "code-box"

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

      function tick() {
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
      if (cell.status === "busy") cellTimers[index] = setInterval(tick, 100)

      box.appendChild(statusBar)

      const langLabel = document.createElement("span")
      langLabel.className = "lang-label"
      langLabel.textContent = cell.language || ""
      box.appendChild(langLabel)

      el.appendChild(box)

      try {
        hljs.highlightElement(code)
      } catch (error) {
        console.error("[ipynb-peek] syntax highlighting failed:", error)
      }

      if (cell.outputs && cell.outputs.length) el.appendChild(renderOutputs(cell.outputs))
    } else {
      el.classList.add("raw-cell")
      const pre = document.createElement("pre")
      pre.textContent = cell.source || ""
      el.appendChild(pre)
    }

    return el
  }

  function sendInsert(afterIndex, cellType) {
    if (!currentWs || currentWs.readyState !== WebSocket.OPEN) return
    currentWs.send(
      JSON.stringify({ type: "insert_cell", after_index: afterIndex, cell_type: cellType }),
    )
  }

  function sendDelete(index) {
    if (!currentWs || currentWs.readyState !== WebSocket.OPEN) return
    currentWs.send(JSON.stringify({ type: "delete_cell", index }))
  }

  function renderAddBar(afterIndex) {
    const bar = document.createElement("div")
    bar.className = "add-cell-bar"

    const codeBtn = document.createElement("button")
    codeBtn.className = "add-cell-btn"
    codeBtn.textContent = "+ Code"
    codeBtn.addEventListener("click", () => sendInsert(afterIndex, "code"))
    bar.appendChild(codeBtn)

    const markdownBtn = document.createElement("button")
    markdownBtn.className = "add-cell-btn"
    markdownBtn.textContent = "+ Markdown"
    markdownBtn.addEventListener("click", () => sendInsert(afterIndex, "markdown"))
    bar.appendChild(markdownBtn)

    return bar
  }

  function fullRender(cells) {
    for (let position = 0; position < cellTimers.length; position++) clearCellTimer(position)
    container.innerHTML = ""
    cellEls.length = 0
    cellTimers.length = 0
    container.appendChild(renderAddBar(-1))
    cells.forEach((cell, index) => {
      const el = renderCell(cell, index)
      cellEls.push(el)
      container.appendChild(el)
      container.appendChild(renderAddBar(index))
    })
  }

  function updateCell(index, cell) {
    const old = cellEls[index]
    if (!old) return
    clearCellTimer(index)
    const el = renderCell(cell, index)
    if (old.classList.contains("active-cell")) el.classList.add("active-cell")
    old.replaceWith(el)
    cellEls[index] = el
  }

  function focusCell(index) {
    const el = cellEls[index]
    if (!el) return
    for (const cellEl of cellEls) cellEl.classList.remove("active-cell")
    el.classList.add("active-cell")
    el.scrollIntoView({ block: "center", behavior: "smooth" })
  }

  let backoff = 300
  let currentWs = null
  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws"
    const token = window.__IPYNB_PEEK_TOKEN__
    const query = token ? "?token=" + encodeURIComponent(token) : ""
    const ws = new WebSocket(proto + "://" + location.host + "/ws" + query)
    currentWs = ws
    ws.onopen = () => {
      backoff = 300
    }
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.type === "render") fullRender(msg.cells)
        else if (msg.type === "cell_update") updateCell(msg.index, msg.cell)
        else if (msg.type === "cursor") focusCell(msg.index)
      } catch (error) {
        console.error("[ipynb-peek] failed to handle websocket message:", error)
      }
    }
    ws.onclose = () => {
      setTimeout(connect, backoff)
      backoff = Math.min(backoff * 2, 5000)
    }
    ws.onerror = () => ws.close()
  }
  connect()
})()
