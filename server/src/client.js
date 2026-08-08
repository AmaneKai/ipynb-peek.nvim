import { AnsiUp } from "ansi_up"
import hljs from "highlight.js/lib/core"
import python from "highlight.js/lib/languages/python"
import renderMathInElement from "katex/contrib/auto-render"
import { marked } from "marked"

const ansiUp = new AnsiUp()
hljs.registerLanguage("python", python)

;(function () {
  /**
   * Tags the page title with this server instance's port, so the Neovim
   * plugin's best-effort popup-close logic (window title matching on
   * non-macOS platforms) can find the right window among any others.
   */
  document.title = "ipynb-peek:" + location.port

  const container = document.getElementById("notebook")
  const sessionToken = document.querySelector('meta[name="ipynb-peek-token"]')?.content || ""
  const cellEls = []
  const cellTimers = []
  // Cells whose source/outputs the user has manually revealed past what
  // source_hidden/outputs_hidden metadata says to hide by default - kept
  // keyed by index across re-renders so a toggle survives live-typing
  // updates to other cells.
  const revealedSource = new Set()
  const revealedOutputs = new Set()

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
   * A cell blocked on Python's input()/getpass() shows this bar rather than
   * a browser-native window.prompt() - window.prompt can't mask a getpass()
   * password field, and its synchronous nature would freeze this page's own
   * websocket handling while it's up.
   */
  const stdinBar = document.getElementById("stdin-bar")
  const stdinPromptText = document.getElementById("stdin-prompt-text")
  const stdinInput = document.getElementById("stdin-input")
  const stdinSend = document.getElementById("stdin-send")

  function openStdinPrompt(prompt, password) {
    stdinPromptText.textContent = prompt || "Input requested:"
    stdinInput.type = password ? "password" : "text"
    stdinInput.value = ""
    stdinBar.classList.add("open")
    stdinInput.focus()
  }

  function closeStdinPrompt() {
    stdinBar.classList.remove("open")
    stdinInput.value = ""
  }

  function submitStdinReply() {
    if (!stdinBar.classList.contains("open")) return
    const value = stdinInput.value
    closeStdinPrompt()
    fetch("/input", {
      method: "POST",
      headers: { "content-type": "application/json", "x-ipynb-peek-token": sessionToken },
      body: JSON.stringify({ value }),
    }).catch((error) => console.error("[ipynb-peek] failed to send stdin reply:", error))
  }

  stdinSend.addEventListener("click", submitStdinReply)
  stdinInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submitStdinReply()
  })

  /**
   * Runs after marked.js has already turned markdown into HTML, so KaTeX
   * only ever sees plain text/HTML, never raw markdown syntax - matches how
   * Jupyter's own markdown-it + katex renderer is ordered.
   */
  function renderMath(container) {
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

  function localizeImages(root) {
    for (const img of root.querySelectorAll("img[src]")) {
      const src = img.getAttribute("src") || ""
      if (!src || /^(?:[a-z]+:|\/\/|#|data:)/i.test(src)) continue
      const query = new URLSearchParams({ path: src, token: sessionToken })
      img.src = "/notebook-asset?" + query
    }
  }

  function renderOutputs(outputs, scrolled) {
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
        img.addEventListener("click", () => openLightbox(img.src))
        wrap.appendChild(img)
      } else if (out.kind === "html") {
        const div = document.createElement("div")
        div.className = "table-scroll"
        div.innerHTML = out.content
        localizeImages(div)
        wrap.appendChild(div)
      } else if (out.kind === "markdown") {
        const div = document.createElement("div")
        div.className = "md-cell"
        div.innerHTML = marked.parse(out.content || "")
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
      } else {
        const pre = document.createElement("pre")
        if (out.kind === "error") pre.className = "error-output"
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

  function renderCell(cell, index) {
    const el = document.createElement("div")
    el.className = "cell"

    const metadata = cell.metadata || {}

    const cellNumber = document.createElement("div")
    cellNumber.className = "cell-number"
    cellNumber.textContent = String(index + 1)
    el.appendChild(cellNumber)

    const tagChips = renderTagChips(cell)
    if (tagChips) el.appendChild(tagChips)

    if (metadata.deletable !== false && metadata.editable !== false) {
      const deleteBtn = document.createElement("button")
      deleteBtn.className = "delete-cell-btn"
      deleteBtn.textContent = "✕"
      deleteBtn.title = "Delete cell"
      deleteBtn.addEventListener("click", () => sendDelete(index))
      el.appendChild(deleteBtn)
    }

    if (cell.cell_type === "markdown") {
      el.classList.add("md-cell")
      const content = document.createElement("div")
      content.innerHTML = marked.parse(cell.source || "")
      localizeImages(content)
      renderMath(content)
      el.appendChild(content)
    } else if (cell.cell_type === "code") {
      el.classList.add("code-cell")

      const sourceHidden = metadata.source_hidden && !revealedSource.has(index)
      if (sourceHidden) {
        el.appendChild(
          renderHiddenBar("‣ input hidden - click to show", () => {
            revealedSource.add(index)
            updateCell(index, cell)
          }),
        )
      } else {
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
      }

      if (cell.outputs && cell.outputs.length) {
        const outputsHidden = metadata.outputs_hidden && !revealedOutputs.has(index)
        if (outputsHidden) {
          el.appendChild(
            renderHiddenBar("‣ output hidden - click to show", () => {
              revealedOutputs.add(index)
              updateCell(index, cell)
            }),
          )
        } else {
          el.appendChild(renderOutputs(cell.outputs, metadata.scrolled === true))
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
    closeStdinPrompt()
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
    const query = sessionToken ? "?token=" + encodeURIComponent(sessionToken) : ""
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
        else if (msg.type === "input_request") openStdinPrompt(msg.prompt, msg.password)
      } catch (error) {
        console.error("[ipynb-peek] failed to handle websocket message:", error)
      }
    }
    ws.onclose = () => {
      closeStdinPrompt()
      setTimeout(connect, backoff)
      backoff = Math.min(backoff * 2, 5000)
    }
    ws.onerror = () => ws.close()
  }
  connect()
})()
