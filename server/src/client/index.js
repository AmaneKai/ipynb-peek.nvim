import { cellKey, createStore, initialState } from "./store.js"
import { planReconcile } from "./reconcile.js"
import { createCellView } from "./cell-view.js"
import { buildToc, renderToc } from "./toc.js"
import { createLightbox } from "./lightbox.js"
import { renderVariables } from "./variables.js"
import { buildExportHtml } from "./export.js"

/**
 * Tags the page title with this server instance's port, so the Neovim
 * plugin's best-effort popup-close logic (window title matching on
 * non-macOS platforms) can find the right window among any others.
 */
document.title = "ipynb-peek:" + location.port

const container = document.getElementById("notebook")
const sessionToken = document.querySelector('meta[name="ipynb-peek-token"]')?.content || ""
const store = createStore(initialState())

let currentWs = null

function postJson(path, body) {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ipynb-peek-token": sessionToken },
    body: JSON.stringify(body),
  })
}

function sendOverWs(message) {
  if (!currentWs || currentWs.readyState !== WebSocket.OPEN) return
  currentWs.send(JSON.stringify(message))
}

// --- lightbox -------------------------------------------------------------

const lightbox = createLightbox(document.getElementById("lightbox"))

// --- stdin prompt ---------------------------------------------------------

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

function showStdinPrompt(input) {
  if (!input) {
    stdinBar.classList.remove("open")
    stdinInput.value = ""
    return
  }
  stdinPromptText.textContent = input.prompt || "Input requested:"
  stdinInput.type = input.password ? "password" : "text"
  stdinInput.value = ""
  stdinBar.classList.add("open")
  stdinInput.focus()
}

function submitStdinReply() {
  if (!store.getState().input) return
  const value = stdinInput.value
  store.dispatch({ type: "INPUT_CLEARED" })
  postJson("/input", { value }).catch((error) =>
    console.error("[ipynb-peek] failed to send stdin reply:", error),
  )
}

stdinSend.addEventListener("click", submitStdinReply)
stdinInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") submitStdinReply()
})

// --- cells ----------------------------------------------------------------

const view = createCellView({
  sessionToken,
  state: store.getState,
  onInsert: (afterIndex, cellType) =>
    sendOverWs({ type: "insert_cell", after_index: afterIndex, cell_type: cellType }),
  onDelete: (index) => sendOverWs({ type: "delete_cell", index }),
  /** Sends SIGINT to the running kernel - the only way to stop a busy cell from the preview itself. */
  onInterrupt: () =>
    postJson("/interrupt", {}).catch((error) =>
      console.error("[ipynb-peek] failed to send interrupt:", error),
    ),
  /**
   * A traceback location was clicked. "Cell In[N]" names an execution count,
   * so find the cell that was run as In[N]; fall back to the cell the
   * traceback is shown in. File frames open the file in Neovim.
   */
  onTracebackJump: (link, ownIndex) => {
    if (link.file) {
      sendOverWs({ type: "open_file", path: link.file, line: link.line })
      return
    }
    const cells = store.getState().cells
    const byCount = cells.findIndex((cell) => cell.execution_count === link.execCount)
    sendOverWs({
      type: "jump_cell_line",
      cell_index: byCount === -1 ? ownIndex : byCount,
      line_offset: link.line,
    })
  },
  onToggleSource: (key) => store.dispatch({ type: "TOGGLE_SOURCE", key }),
  onToggleOutputs: (key) => store.dispatch({ type: "TOGGLE_OUTPUTS", key }),
  onOpenImage: (src) => lightbox.open(src),
})

const leadingBar = view.createLeadingBar()
container.appendChild(leadingBar)
/** Entries currently on the page, in order. */
let entries = []

/**
 * Brings the page in line with `cells` touching only what changed: untouched
 * cells keep their DOM (syntax highlighting, image zoom, selection, scroll
 * position), edited ones re-render in place, and only genuinely new or
 * removed cells add or remove nodes.
 */
function reconcile(cells) {
  const { items, removed } = planReconcile(entries, cells)
  for (const entry of removed) view.destroy(entry)

  const next = items.map(({ cell, entry, changed }, index) => {
    if (!entry) return view.create(cell, index)
    if (changed) view.update(entry, cell, index)
    else {
      entry.cell = cell
      view.setIndex(entry, index)
    }
    return entry
  })

  // Put every entry's nodes in the right order, moving only those out of place.
  let ref = leadingBar.nextSibling
  for (const entry of next) {
    for (const node of [entry.el, entry.bar]) {
      if (ref === node) ref = ref.nextSibling
      else container.insertBefore(node, ref)
    }
  }
  entries = next
}

function focusCell(index) {
  const entry = entries[index]
  if (!entry) return
  for (const other of entries) other.el.classList.remove("active-cell")
  entry.el.classList.add("active-cell")
  entry.el.scrollIntoView({ block: "center", behavior: "smooth" })
}

store.subscribe((state, _previous, action) => {
  switch (action.type) {
    case "NOTEBOOK_RENDERED":
      reconcile(state.cells)
      break
    case "CELL_UPDATED": {
      const entry = entries[action.index]
      if (entry) view.update(entry, action.cell, action.index)
      break
    }
    case "CURSOR_MOVED":
      focusCell(action.index)
      break
    case "INPUT_REQUESTED":
    case "INPUT_CLEARED":
      showStdinPrompt(state.input)
      break
    case "TOGGLE_SOURCE":
    case "TOGGLE_OUTPUTS": {
      const entry = entries.find(
        (candidate) => cellKey(candidate.cell, candidate.index) === action.key,
      )
      if (entry) view.update(entry, entry.cell, entry.index)
      break
    }
  }
})

// --- toolbar, outline, theme, presentation --------------------------------

/** Per-viewer preferences survive reloads; storage may be unavailable. */
const prefs = {
  get(key) {
    try {
      return localStorage.getItem("ipynb-peek:" + key)
    } catch {
      return null
    }
  },
  set(key, value) {
    try {
      localStorage.setItem("ipynb-peek:" + key, String(value))
    } catch {}
  },
}

const themeSelect = document.getElementById("theme-select")
const tocContent = document.getElementById("toc-content")
const variablesBody = document.getElementById("variables-body")

function fillThemeOptions(names) {
  themeSelect.replaceChildren(
    ...["default", ...names].map((name) => {
      const option = document.createElement("option")
      option.value = name
      option.textContent = name === "default" ? "◐ theme" : name
      return option
    }),
  )
  themeSelect.value = store.getState().theme
}

function applyUi(state) {
  const root = document.documentElement
  if (state.theme === "default") delete root.dataset.theme
  else root.dataset.theme = state.theme
  themeSelect.value = state.theme
  document.body.classList.toggle("presentation-mode", state.presentation)
  document.getElementById("present-toggle").classList.toggle("on", state.presentation)
  document.body.classList.toggle("toc-open", state.tocOpen)
  document.getElementById("toc-toggle").classList.toggle("on", state.tocOpen)
  root.style.setProperty("--toc-width", state.tocWidth + "px")
  document.body.classList.toggle("variables-open", state.variables.open)
  document.getElementById("variables-toggle").classList.toggle("on", state.variables.open)
}

function refreshToc(state) {
  if (!state.tocOpen) return
  renderToc(tocContent, buildToc(state.cells), state.activeIndex, (index) => {
    store.dispatch({ type: "CURSOR_MOVED", index })
    sendOverWs({ type: "goto_cell", index })
  })
}

function loadVariables() {
  store.dispatch({ type: "SET_VARIABLES_PANEL", open: true })
  store.dispatch({ type: "VARIABLES_LOADED", variables: null, error: null })
  postJson("/variables", {})
    .then((response) => response.json())
    .then((result) =>
      store.dispatch({
        type: "VARIABLES_LOADED",
        variables: result.ok ? result.variables : null,
        error: result.ok ? null : result.error || "failed to read variables",
      }),
    )
    .catch((error) =>
      store.dispatch({ type: "VARIABLES_LOADED", variables: null, error: String(error) }),
    )
}

themeSelect.addEventListener("change", () =>
  store.dispatch({ type: "SET_THEME", name: themeSelect.value }),
)
document
  .getElementById("toc-toggle")
  .addEventListener("click", () =>
    store.dispatch({ type: "SET_TOC", open: !store.getState().tocOpen }),
  )
document
  .getElementById("present-toggle")
  .addEventListener("click", () =>
    store.dispatch({ type: "SET_PRESENTATION", on: !store.getState().presentation }),
  )
document.getElementById("variables-toggle").addEventListener("click", () => {
  if (store.getState().variables.open) store.dispatch({ type: "SET_VARIABLES_PANEL", open: false })
  else loadVariables()
})
document.getElementById("variables-refresh").addEventListener("click", loadVariables)
document
  .getElementById("variables-close")
  .addEventListener("click", () => store.dispatch({ type: "SET_VARIABLES_PANEL", open: false }))

function downloadHtml(html, filename) {
  const link = document.createElement("a")
  link.href = URL.createObjectURL(new Blob([html], { type: "text/html" }))
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 10000)
}
document.getElementById("export-html").addEventListener("click", async () => {
  downloadHtml(await buildExportHtml({ noCode: false }), "notebook.html")
})
document.getElementById("export-html-nocode").addEventListener("click", async () => {
  downloadHtml(await buildExportHtml({ noCode: true }), "notebook-report.html")
})

/** Drag the divider to resize the outline. */
document.getElementById("toc-resizer").addEventListener("pointerdown", (event) => {
  const resizer = event.currentTarget
  resizer.setPointerCapture(event.pointerId)
  const move = (moveEvent) => store.dispatch({ type: "SET_TOC_WIDTH", width: moveEvent.clientX })
  resizer.addEventListener("pointermove", move)
  resizer.addEventListener("pointerup", () => resizer.removeEventListener("pointermove", move), {
    once: true,
  })
})

// Restore saved preferences, then persist every change.
{
  const names = (document.querySelector('meta[name="ipynb-peek-themes"]')?.content || "")
    .split(",")
    .filter(Boolean)
  store.dispatch({ type: "THEME_AVAILABLE", themes: names })
  fillThemeOptions(names)
  const savedTheme = prefs.get("theme")
  if (savedTheme && (savedTheme === "default" || names.includes(savedTheme)))
    store.dispatch({ type: "SET_THEME", name: savedTheme })
  store.dispatch({ type: "SET_PRESENTATION", on: prefs.get("presentation") === "true" })
  store.dispatch({ type: "SET_TOC", open: prefs.get("toc") === "true" })
  const savedWidth = Number(prefs.get("toc-width"))
  if (savedWidth) store.dispatch({ type: "SET_TOC_WIDTH", width: savedWidth })
}
applyUi(store.getState())

store.subscribe((state, previous, action) => {
  applyUi(state)
  if (state.theme !== previous.theme && action.type === "SET_THEME") prefs.set("theme", state.theme)
  if (state.presentation !== previous.presentation) prefs.set("presentation", state.presentation)
  if (state.tocOpen !== previous.tocOpen) prefs.set("toc", state.tocOpen)
  if (state.tocWidth !== previous.tocWidth) prefs.set("toc-width", state.tocWidth)
  if (
    state.cells !== previous.cells ||
    state.activeIndex !== previous.activeIndex ||
    state.tocOpen !== previous.tocOpen
  )
    refreshToc(state)
  if (state.variables !== previous.variables) renderVariables(variablesBody, state.variables)
})

// --- connection -----------------------------------------------------------

/** Neovim asked for a report (`:IpynbPeekExport`): build it here, post it back. */
async function handleExportRequest(msg) {
  try {
    const html = await buildExportHtml({ noCode: msg.mode === "report" })
    await postJson("/export-result", { id: msg.id, html })
  } catch (error) {
    await postJson("/export-result", { id: msg.id, error: String(error) }).catch(() => {})
  }
}

let backoff = 300
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
      if (msg.type === "render") store.dispatch({ type: "NOTEBOOK_RENDERED", cells: msg.cells })
      else if (msg.type === "cell_update")
        store.dispatch({ type: "CELL_UPDATED", index: msg.index, cell: msg.cell })
      else if (msg.type === "cursor") store.dispatch({ type: "CURSOR_MOVED", index: msg.index })
      else if (msg.type === "theme") store.dispatch({ type: "SET_THEME", name: msg.name })
      else if (msg.type === "print") window.print()
      else if (msg.type === "export_request") handleExportRequest(msg)
      else if (msg.type === "input_request")
        store.dispatch({ type: "INPUT_REQUESTED", prompt: msg.prompt, password: msg.password })
    } catch (error) {
      console.error("[ipynb-peek] failed to handle websocket message:", error)
    }
  }
  ws.onclose = () => {
    store.dispatch({ type: "INPUT_CLEARED" })
    setTimeout(connect, backoff)
    backoff = Math.min(backoff * 2, 5000)
  }
  ws.onerror = () => ws.close()
}
connect()
