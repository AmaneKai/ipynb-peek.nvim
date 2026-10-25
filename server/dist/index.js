// src/core/daemon.ts
import http from "node:http";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import readline2 from "node:readline";
import { randomBytes } from "node:crypto";

// src/core/session.ts
import { WebSocket } from "ws";

// src/notebook.ts
function isCellDeletable(cell) {
  return cell?.metadata?.deletable !== false;
}
function joinSource(src) {
  if (!src) return "";
  return Array.isArray(src) ? src.join("") : src;
}
function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}
function applyCarriageReturns(text) {
  return text.split("\n").map((line) => {
    if (!line.includes("\r")) return line;
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    const index = trimmed.lastIndexOf("\r");
    return index === -1 ? trimmed : trimmed.slice(index + 1);
  }).join("\n");
}
function imageSize(output, mime) {
  const meta = output.metadata?.[mime];
  const width = typeof meta?.width === "number" ? meta.width : void 0;
  const height = typeof meta?.height === "number" ? meta.height : void 0;
  return { width, height };
}
var PLOTLY_MIME = "application/vnd.plotly.v1+json";
var VEGA_LITE_MIME = /^application\/vnd\.vegalite\.v\d+\+json$/;
var VEGA_MIME = /^application\/vnd\.vega\.v\d+\+json$/;
function parseSpec(value) {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === "object" ? value : null;
}
function chartOutput(data) {
  const plotly = parseSpec(data[PLOTLY_MIME]);
  if (plotly) return { kind: "plotly", spec: plotly };
  for (const mime of Object.keys(data)) {
    const lite = VEGA_LITE_MIME.test(mime);
    if (!lite && !VEGA_MIME.test(mime)) continue;
    const spec = parseSpec(data[mime]);
    if (spec) return { kind: "vega", spec, lite };
  }
  return null;
}
function renderOutput(output) {
  const data = output.data ?? {};
  const chart = chartOutput(data);
  if (chart) return chart;
  if (data["image/png"])
    return {
      kind: "image",
      mime: "image/png",
      data: joinSource(data["image/png"]),
      ...imageSize(output, "image/png")
    };
  if (data["image/jpeg"])
    return {
      kind: "image",
      mime: "image/jpeg",
      data: joinSource(data["image/jpeg"]),
      ...imageSize(output, "image/jpeg")
    };
  if (data["image/svg+xml"])
    return { kind: "image", mime: "image/svg+xml", data: joinSource(data["image/svg+xml"]) };
  if (data["text/html"]) return { kind: "html", content: joinSource(data["text/html"]) };
  if (data["text/latex"]) return { kind: "latex", content: joinSource(data["text/latex"]) };
  if (data["text/markdown"]) return { kind: "markdown", content: joinSource(data["text/markdown"]) };
  if (output.output_type === "stream")
    return {
      kind: "text",
      content: joinSource(output.text),
      stream: output.name === "stderr" ? "stderr" : "stdout"
    };
  if (output.output_type === "error") {
    const traceback = Array.isArray(output.traceback) ? output.traceback.join("\n") : output.traceback ?? "";
    return { kind: "error", content: stripAnsi(traceback) };
  }
  if (data["application/json"] !== void 0)
    return { kind: "text", content: JSON.stringify(data["application/json"], null, 2) };
  if (data["text/plain"]) return { kind: "text", content: joinSource(data["text/plain"]) };
  return null;
}
function appendOutput(outputs, newOutput) {
  const last = outputs[outputs.length - 1];
  if (last && last.kind === "text" && newOutput.kind === "text" && last.stream !== void 0 && last.stream === newOutput.stream) {
    last.content = applyCarriageReturns(last.content + newOutput.content);
    return;
  }
  outputs.push(
    newOutput.kind === "text" ? { ...newOutput, content: applyCarriageReturns(newOutput.content) } : newOutput
  );
}
function readCellMetadata(cell) {
  const jupyterMeta = cell.metadata?.jupyter ?? {};
  const tags = Array.isArray(cell.metadata?.tags) ? cell.metadata.tags.filter((tag) => typeof tag === "string") : [];
  return {
    source_hidden: jupyterMeta.source_hidden === true || cell.metadata?.hide_input === true,
    outputs_hidden: jupyterMeta.outputs_hidden === true || cell.metadata?.collapsed === true || tags.includes("hide-output"),
    editable: cell.metadata?.editable !== false,
    deletable: cell.metadata?.deletable !== false,
    scrolled: cell.metadata?.scrolled === "auto" ? "auto" : cell.metadata?.scrolled === true,
    tags
  };
}
function renderNotebook(nb) {
  const language = nb.metadata?.kernelspec?.language ?? nb.metadata?.language_info?.name ?? "python";
  const cells = [];
  for (let index = 0; index < nb.cells.length; index++) {
    const cell = nb.cells[index];
    const source = joinSource(cell.source);
    const outputs = [];
    if (cell.cell_type === "code" && Array.isArray(cell.outputs)) {
      for (const output of cell.outputs) {
        const rendered = renderOutput(output);
        if (rendered) appendOutput(outputs, rendered);
      }
    }
    cells.push({
      index,
      id: typeof cell.id === "string" ? cell.id : void 0,
      cell_type: cell.cell_type,
      source,
      language: cell.cell_type === "code" ? language : void 0,
      execution_count: cell.cell_type === "code" ? cell.execution_count ?? null : void 0,
      outputs,
      nbformat_outputs: cell.cell_type === "code" && Array.isArray(cell.outputs) ? structuredClone(cell.outputs) : void 0,
      metadata: readCellMetadata(cell)
    });
  }
  return cells;
}
function mergeCells(previous, fresh) {
  return fresh.map((cell, index) => {
    const prevCell = previous[index];
    if (prevCell && prevCell.source === cell.source && prevCell.cell_type === cell.cell_type && // A cell on its very first run has neither outputs nor an execution
    // count yet, but must not lose its busy state to an unrelated re-render.
    (prevCell.outputs.length > 0 || prevCell.execution_count || prevCell.status === "busy")) {
      return {
        ...cell,
        outputs: prevCell.outputs,
        nbformat_outputs: prevCell.nbformat_outputs,
        execution_count: prevCell.execution_count,
        status: prevCell.status,
        started_at: prevCell.started_at,
        duration_ms: prevCell.duration_ms
      };
    }
    return cell;
  });
}
function syncCells(previous, live) {
  const rows = Array.from({ length: previous.length + 1 }, () => new Uint16Array(live.length + 1));
  for (let oldIndex2 = previous.length - 1; oldIndex2 >= 0; oldIndex2--) {
    for (let liveIndex2 = live.length - 1; liveIndex2 >= 0; liveIndex2--) {
      const exact = previous[oldIndex2].cell_type === live[liveIndex2].cell_type && previous[oldIndex2].source === live[liveIndex2].source;
      rows[oldIndex2][liveIndex2] = exact ? rows[oldIndex2 + 1][liveIndex2 + 1] + 1 : Math.max(rows[oldIndex2 + 1][liveIndex2], rows[oldIndex2][liveIndex2 + 1]);
    }
  }
  const anchors = [];
  let oldIndex = 0;
  let liveIndex = 0;
  while (oldIndex < previous.length && liveIndex < live.length) {
    if (previous[oldIndex].cell_type === live[liveIndex].cell_type && previous[oldIndex].source === live[liveIndex].source) {
      anchors.push([oldIndex++, liveIndex++]);
    } else if (rows[oldIndex + 1][liveIndex] >= rows[oldIndex][liveIndex + 1]) oldIndex++;
    else liveIndex++;
  }
  const previousByLiveIndex = /* @__PURE__ */ new Map();
  let previousStart = 0;
  let liveStart = 0;
  const allAnchors = [...anchors, [previous.length, live.length]];
  for (const [previousAnchor, liveAnchor] of allAnchors) {
    const previousGap = previousAnchor - previousStart;
    const liveGap = liveAnchor - liveStart;
    if (previousGap === liveGap) {
      for (let offset = 0; offset < liveGap; offset++)
        previousByLiveIndex.set(liveStart + offset, previous[previousStart + offset]);
    }
    if (previousAnchor < previous.length)
      previousByLiveIndex.set(liveAnchor, previous[previousAnchor]);
    previousStart = previousAnchor + 1;
    liveStart = liveAnchor + 1;
  }
  return live.map((liveCell, index) => {
    const prevCell = previousByLiveIndex.get(index);
    if (prevCell) {
      return {
        ...prevCell,
        index,
        cell_type: liveCell.cell_type,
        source: liveCell.source,
        language: liveCell.cell_type === "code" ? prevCell.language ?? "python" : void 0
      };
    }
    return {
      index,
      cell_type: liveCell.cell_type,
      source: liveCell.source,
      language: liveCell.cell_type === "code" ? "python" : void 0,
      execution_count: liveCell.cell_type === "code" ? null : void 0,
      outputs: [],
      nbformat_outputs: liveCell.cell_type === "code" ? [] : void 0
    };
  });
}
function toNbformatOutput(output) {
  switch (output.kind) {
    case "text":
      if (output.stream)
        return { output_type: "stream", name: output.stream, text: [output.content] };
      return { output_type: "display_data", data: { "text/plain": [output.content] }, metadata: {} };
    case "html":
      return { output_type: "display_data", data: { "text/html": [output.content] }, metadata: {} };
    case "latex":
      return { output_type: "display_data", data: { "text/latex": [output.content] }, metadata: {} };
    case "markdown":
      return {
        output_type: "display_data",
        data: { "text/markdown": [output.content] },
        metadata: {}
      };
    case "image": {
      const mime = output.mime ?? "image/png";
      const size = {};
      if (output.width) size.width = output.width;
      if (output.height) size.height = output.height;
      return {
        output_type: "display_data",
        data: { [mime]: output.data },
        metadata: Object.keys(size).length ? { [mime]: size } : {}
      };
    }
    case "error":
      return {
        output_type: "error",
        ename: "Error",
        evalue: "",
        traceback: output.content.split("\n")
      };
  }
}
function patchNotebookOutputs(notebookJson, currentCells) {
  const nbCells = Array.isArray(notebookJson?.cells) ? notebookJson.cells : [];
  const usedNotebookIndices = /* @__PURE__ */ new Set();
  for (let currentIndex = 0; currentIndex < currentCells.length; currentIndex++) {
    const cell = currentCells[currentIndex];
    if (cell.cell_type !== "code") continue;
    if (cell.status === "busy") continue;
    if (cell.outputs.length === 0 && cell.execution_count == null) continue;
    let notebookIndex = cell.id ? nbCells.findIndex((candidate) => candidate.id === cell.id) : -1;
    const positionalCandidate = nbCells[currentIndex];
    if (notebookIndex === -1 && !usedNotebookIndices.has(currentIndex) && positionalCandidate?.cell_type === "code" && joinSource(positionalCandidate.source) === cell.source) {
      notebookIndex = currentIndex;
    }
    if (notebookIndex === -1) {
      notebookIndex = nbCells.findIndex(
        (candidate, index) => !usedNotebookIndices.has(index) && candidate.cell_type === "code" && joinSource(candidate.source) === cell.source
      );
    }
    if (notebookIndex === -1 || usedNotebookIndices.has(notebookIndex)) continue;
    const nbCell = nbCells[notebookIndex];
    usedNotebookIndices.add(notebookIndex);
    nbCell.outputs = cell.nbformat_outputs ? structuredClone(cell.nbformat_outputs) : cell.outputs.map(toNbformatOutput);
    nbCell.execution_count = cell.execution_count ?? null;
  }
  return notebookJson;
}
function cellStatusInfo(cell, index) {
  return {
    index,
    status: cell.status ?? "idle",
    execution_count: cell.execution_count,
    duration_ms: cell.duration_ms,
    has_error: cell.outputs.some((output) => output.kind === "error")
  };
}

// src/persist.ts
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
var writeQueues = /* @__PURE__ */ new Map();
function enqueueWrite(path, action) {
  const queued = (writeQueues.get(path) ?? Promise.resolve()).catch(() => {
  }).then(action);
  writeQueues.set(path, queued);
  const cleanup = () => {
    if (writeQueues.get(path) === queued) writeQueues.delete(path);
  };
  void queued.then(cleanup, cleanup);
  return queued;
}
function updateNotebookFile(path, update) {
  return enqueueWrite(path, async () => {
    const tmpPath = `${path}.ipynb-peek.tmp`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const original = await readFile(path, "utf8");
      const notebookJson = JSON.parse(original);
      update(notebookJson);
      await writeFile(tmpPath, JSON.stringify(notebookJson, null, 1), "utf8");
      const current = await readFile(path, "utf8");
      if (current === original) {
        await rename(tmpPath, path);
        return;
      }
      await unlink(tmpPath).catch(() => {
      });
    }
    throw new Error(`notebook kept changing while outputs were being persisted: ${path}`);
  });
}

// src/themes.ts
var PRESETS = {
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
    syn_type: "#4ec9b0"
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
    syn_type: "#2ac3de"
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
    syn_type: "#fabd2f"
  },
  "github-dark": {
    bg: "#0d1117",
    fg: "#e6edf3",
    surface: "#161b22",
    border: "#30363d",
    muted: "#7d8590",
    dim: "#6e7681",
    accent: "#2f81f7",
    heading: "#e6edf3",
    danger: "#da3633",
    error: "#ff7b72",
    syn_keyword: "#ff7b72",
    syn_string: "#a5d6ff",
    syn_comment: "#8b949e",
    syn_number: "#79c0ff",
    syn_function: "#d2a8ff",
    syn_variable: "#ffa657",
    syn_type: "#7ee787"
  },
  "github-light": {
    bg: "#ffffff",
    fg: "#1f2328",
    surface: "#f6f8fa",
    border: "#d0d7de",
    muted: "#656d76",
    dim: "#8c959f",
    accent: "#0969da",
    heading: "#1f2328",
    danger: "#cf222e",
    error: "#cf222e",
    syn_keyword: "#cf222e",
    syn_string: "#0a3069",
    syn_comment: "#6e7781",
    syn_number: "#0550ae",
    syn_function: "#8250df",
    syn_variable: "#953800",
    syn_type: "#116329"
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
    syn_type: "#ebbcba"
  }
};
var LIGHT_PRESETS = /* @__PURE__ */ new Set(["github-light"]);
var PRESET_NAMES = Object.keys(PRESETS);
function cssVar(prefix, key) {
  return `${prefix}${key.replace(/_/g, "-")}`;
}
function cssValue(value) {
  if (typeof value === "number") return `${value}px`;
  return value;
}
function buildThemeCss(rawConfig) {
  let config = {};
  if (rawConfig) {
    try {
      const parsed = JSON.parse(rawConfig);
      config = typeof parsed === "string" ? { preset: parsed } : parsed ?? {};
    } catch (error) {
      console.error("[ipynb-peek] invalid IPYNB_PEEK_THEME, falling back to default:", error);
    }
  }
  const base = PRESETS[config.preset ?? "dark"] ?? PRESETS.dark;
  const colors = { ...base, ...config.colors ?? {} };
  const font = { ...config.font ?? {} };
  const lines = [":root {"];
  lines.push(`  color-scheme: ${LIGHT_PRESETS.has(config.preset ?? "dark") ? "light" : "dark"};`);
  for (const [key, value] of Object.entries(colors)) {
    lines.push(`  ${cssVar("--ipynb-", key)}: ${value};`);
  }
  for (const [key, value] of Object.entries(font)) {
    if (value == null) continue;
    lines.push(`  ${cssVar("--ipynb-font-", key)}: ${cssValue(value)};`);
  }
  lines.push("}");
  for (const [name, palette] of Object.entries(PRESETS)) {
    lines.push(`:root[data-theme="${name}"] {`);
    lines.push(`  color-scheme: ${LIGHT_PRESETS.has(name) ? "light" : "dark"};`);
    for (const [key, value] of Object.entries(palette)) {
      lines.push(`  ${cssVar("--ipynb-", key)}: ${value};`);
    }
    lines.push("}");
  }
  return lines.join("\n");
}

// src/core/session.ts
function publicCell(cell) {
  const { nbformat_outputs: _nbformatOutputs, ...visibleCell } = cell;
  return visibleCell;
}
function appendExecutionFailure(cell, message) {
  cell.outputs.push({ kind: "error", content: message });
  cell.nbformat_outputs ??= [];
  cell.nbformat_outputs.push({
    output_type: "error",
    ename: "KernelError",
    evalue: message,
    traceback: [message]
  });
}
var NotebookSession = class {
  cells = [];
  kernelName;
  notebookDir;
  notebookPath;
  pendingExecs = /* @__PURE__ */ new Map();
  /**
   * The kernel's outstanding input_request, if any - kept server-side (not
   * just fired once over the websocket) so a browser that reconnects while a
   * cell is blocked on input() still sees the prompt instead of a cell that
   * looks permanently busy with no way to unblock it short of an interrupt.
   * Cleared once answered or once the kernel that owned it goes away.
   */
  pendingInputRequest = null;
  /** Palette picked from Neovim (`:IpynbPeekTheme`); null = the configured default. */
  theme = null;
  /** Kernel picked via `:IpynbPeekSelectKernel`; outranks the notebook's own kernelspec. */
  kernelOverride;
  kernelRunning = false;
  /** Report requests sent to the browser, waiting for it to post the HTML back. */
  pendingExports = /* @__PURE__ */ new Map();
  wsClients = /* @__PURE__ */ new Set();
  eventSubscribers = /* @__PURE__ */ new Set();
  reset() {
    this.cells = [];
    this.kernelName = void 0;
    this.notebookDir = void 0;
    this.notebookPath = void 0;
    this.pendingExecs.clear();
    this.pendingInputRequest = null;
    this.theme = null;
    this.kernelOverride = void 0;
    this.kernelRunning = false;
    for (const pending of this.pendingExports.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("preview closed"));
    }
    this.pendingExports.clear();
  }
  emitKernel() {
    this.emitEvent({ type: "kernel", name: this.kernelName ?? null, running: this.kernelRunning });
  }
  setKernelRunning(running) {
    if (this.kernelRunning === running) return;
    this.kernelRunning = running;
    this.emitKernel();
  }
  /** Asks the connected preview page to build a report and send it back. */
  requestExport(mode, timeoutMs = 3e4) {
    if (this.wsClients.size === 0)
      return Promise.reject(new Error("no preview window is connected to export from"));
    const id = crypto.randomUUID();
    return new Promise((resolve2, reject) => {
      const timer = setTimeout(() => {
        this.pendingExports.delete(id);
        reject(new Error("the preview did not answer the export request"));
      }, timeoutMs);
      this.pendingExports.set(id, { resolve: resolve2, reject, timer });
      this.broadcast(JSON.stringify({ type: "export_request", id, mode }));
    });
  }
  /** The browser's answer to requestExport. False if the id is unknown/expired. */
  resolveExport(id, html, error) {
    const pending = this.pendingExports.get(id);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingExports.delete(id);
    if (typeof html === "string") pending.resolve(html);
    else pending.reject(new Error(String(error ?? "export failed")));
    return true;
  }
  themePayload() {
    return JSON.stringify({ type: "theme", name: this.theme, available: PRESET_NAMES });
  }
  /** Subscribes to events pushed to Neovim; returns the unsubscribe function. */
  subscribe(send) {
    this.eventSubscribers.add(send);
    return () => this.eventSubscribers.delete(send);
  }
  emitEvent(event) {
    const line = JSON.stringify(event);
    for (const send of this.eventSubscribers) send(line);
  }
  renderPayload() {
    return JSON.stringify({ type: "render", cells: this.cells.map(publicCell) });
  }
  inputRequestPayload() {
    return JSON.stringify({ type: "input_request", ...this.pendingInputRequest });
  }
  broadcast(payload) {
    for (const ws of this.wsClients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }
  /**
   * Also pushes a bulk in-buffer status snapshot to Neovim, so the
   * sign-column icon/virtual-text on each cell's marker line stays correct
   * after a full re-render/sync/restart, not just after individual cell
   * updates (see broadcastCell) - covers a shrunk/reordered cell list, which
   * a single-cell event can't safely reconcile on its own.
   */
  broadcastFull() {
    this.broadcast(this.renderPayload());
    this.emitEvent({ type: "cells_status", cells: this.cells.map((c, i) => cellStatusInfo(c, i)) });
  }
  /**
   * Also pushes a single-cell status update to Neovim (see broadcastFull for
   * the bulk counterpart) - this is what lands the sign-column
   * icon/virtual-text change onto the right buffer line the moment a cell
   * goes busy, streams output, errors, or finishes.
   */
  broadcastCell(index) {
    this.broadcast(
      JSON.stringify({ type: "cell_update", index, cell: publicCell(this.cells[index]) })
    );
    this.emitEvent({ type: "cell_status", ...cellStatusInfo(this.cells[index], index) });
  }
  broadcastSync(previousCells) {
    if (previousCells.length !== this.cells.length) {
      this.broadcastFull();
      return;
    }
    for (let index = 0; index < this.cells.length; index++) {
      const previous = previousCells[index];
      const current = this.cells[index];
      if (previous.source !== current.source || previous.cell_type !== current.cell_type)
        this.broadcastCell(index);
    }
  }
  /**
   * Writes execution results into the real .ipynb file right after a cell
   * settles, rather than waiting for an explicit save. jupytext's percent
   * format has no channel for outputs at all - without this, results computed
   * here only ever exist in this server's memory and the browser popup, never
   * in the file itself, so tools like `jupyter nbconvert` would always see
   * empty outputs. jupytext.vim's own --update save mode preserves whatever's
   * already on disk for a cell whose source hasn't changed, so writing here
   * is enough for those results to survive every later save. Best-effort and
   * non-fatal: a disk write failing here shouldn't break the live preview.
   */
  async persistOutputsToDisk() {
    const path = this.notebookPath;
    if (!path) return;
    this.emitEvent({ type: "persisting", path });
    try {
      const cellsSnapshot = structuredClone(this.cells);
      await updateNotebookFile(path, (notebookJson) => {
        patchNotebookOutputs(notebookJson, cellsSnapshot);
      });
    } catch (error) {
      console.error("[ipynb-peek] failed to persist outputs to disk:", error);
    } finally {
      this.emitEvent({ type: "persisted", path });
    }
  }
  pendingCellIndex(pending) {
    if (pending.id) {
      const idIndex = this.cells.findIndex((cell) => cell.id === pending.id);
      if (idIndex !== -1) return idIndex;
    }
    if (this.cells[pending.index]?.source === pending.source) return pending.index;
    const sourceIndex = this.cells.findIndex((cell) => cell.source === pending.source);
    return sourceIndex === -1 ? null : sourceIndex;
  }
  failPendingExecutions(message) {
    const updated = /* @__PURE__ */ new Set();
    for (const pending of this.pendingExecs.values()) {
      const index = this.pendingCellIndex(pending);
      if (index === null || updated.has(index)) continue;
      const cell = this.cells[index];
      appendExecutionFailure(cell, message);
      cell.status = "idle";
      cell.duration_ms = cell.started_at ? Date.now() - cell.started_at : void 0;
      updated.add(index);
    }
    this.pendingExecs.clear();
    for (const index of updated) this.broadcastCell(index);
  }
};

// src/core/commands.ts
import { writeFile as writeFile2 } from "node:fs/promises";
import { dirname, basename, extname, join } from "node:path";

// src/iopub.ts
function applyStatusMessage(cell, content, parentId, pendingExecs) {
  if (content.execution_state === "busy") {
    cell.status = "busy";
    cell.started_at = Date.now();
  } else if (content.execution_state === "idle") {
    cell.status = "idle";
    cell.duration_ms = cell.started_at ? Date.now() - cell.started_at : void 0;
    pendingExecs.delete(parentId);
  }
}
function applyExecuteInputMessage(cell, content) {
  if (typeof content.execution_count === "number") cell.execution_count = content.execution_count;
}
function applyStreamMessage(cell, content) {
  appendOutput(cell.outputs, {
    kind: "text",
    content: joinSource(content.text),
    stream: content.name === "stderr" ? "stderr" : "stdout"
  });
  cell.nbformat_outputs ??= [];
  const stream = content.name === "stderr" ? "stderr" : "stdout";
  const text = joinSource(content.text);
  const last = cell.nbformat_outputs[cell.nbformat_outputs.length - 1];
  if (last?.output_type === "stream" && last.name === stream) {
    last.text = [joinSource(last.text) + text];
  } else {
    cell.nbformat_outputs.push({ output_type: "stream", name: stream, text: [text] });
  }
}
function applyResultMessage(cell, content, msgType) {
  const data = content.data ?? {};
  const chart = chartOutput(data);
  if (chart) cell.outputs.push(chart);
  else if (data["image/png"])
    cell.outputs.push({
      kind: "image",
      mime: "image/png",
      data: joinSource(data["image/png"]),
      ...imageSize(content, "image/png")
    });
  else if (data["image/jpeg"])
    cell.outputs.push({
      kind: "image",
      mime: "image/jpeg",
      data: joinSource(data["image/jpeg"]),
      ...imageSize(content, "image/jpeg")
    });
  else if (data["image/svg+xml"])
    cell.outputs.push({
      kind: "image",
      mime: "image/svg+xml",
      data: joinSource(data["image/svg+xml"])
    });
  else if (data["text/html"])
    cell.outputs.push({ kind: "html", content: joinSource(data["text/html"]) });
  else if (data["text/latex"])
    cell.outputs.push({ kind: "latex", content: joinSource(data["text/latex"]) });
  else if (data["text/markdown"])
    cell.outputs.push({ kind: "markdown", content: joinSource(data["text/markdown"]) });
  else if (data["application/json"] !== void 0)
    cell.outputs.push({ kind: "text", content: JSON.stringify(data["application/json"], null, 2) });
  else if (data["text/plain"])
    cell.outputs.push({ kind: "text", content: joinSource(data["text/plain"]) });
  if (msgType === "execute_result" && typeof content.execution_count === "number")
    cell.execution_count = content.execution_count;
  cell.nbformat_outputs ??= [];
  cell.nbformat_outputs.push({
    output_type: msgType,
    data: structuredClone(data),
    metadata: structuredClone(content.metadata ?? {}),
    ...msgType === "execute_result" ? { execution_count: content.execution_count ?? null } : {}
  });
}
function applyErrorMessage(cell, content) {
  const traceback = Array.isArray(content.traceback) ? content.traceback.join("\n") : `${content.ename}: ${content.evalue}`;
  cell.outputs.push({ kind: "error", content: stripAnsi(traceback) });
  cell.nbformat_outputs ??= [];
  cell.nbformat_outputs.push({
    output_type: "error",
    ename: content.ename ?? "Error",
    evalue: content.evalue ?? "",
    traceback: Array.isArray(content.traceback) ? structuredClone(content.traceback) : [traceback]
  });
}
function applyClearOutputMessage(cell) {
  cell.outputs = [];
  cell.nbformat_outputs = [];
}
function resolveCellIndex(currentCells, pending) {
  if (pending.id) {
    const idIndex = currentCells.findIndex((cell) => cell.id === pending.id);
    if (idIndex !== -1) return idIndex;
  }
  if (currentCells[pending.index]?.source === pending.source) return pending.index;
  const foundIndex = currentCells.findIndex((cell) => cell.source === pending.source);
  return foundIndex === -1 ? null : foundIndex;
}
function reconcileBusyStatus(currentCells, pendingExecs) {
  const runningIndices = /* @__PURE__ */ new Set();
  for (const pending of pendingExecs.values()) {
    const index = resolveCellIndex(currentCells, pending);
    if (index !== null) runningIndices.add(index);
  }
  currentCells.forEach((cell, index) => {
    if (cell.status === "busy" && !runningIndices.has(index)) {
      cell.status = "idle";
      cell.duration_ms = void 0;
    }
  });
}
function handleIopub(parentId, msgType, content, currentCells, pendingExecs, onCellUpdated) {
  const pending = pendingExecs.get(parentId);
  if (pending === void 0) return;
  const index = resolveCellIndex(currentCells, pending);
  if (index === null) return;
  const cell = currentCells[index];
  if (!cell) return;
  switch (msgType) {
    case "status":
      applyStatusMessage(cell, content, parentId, pendingExecs);
      break;
    case "execute_input":
      applyExecuteInputMessage(cell, content);
      break;
    case "stream":
      applyStreamMessage(cell, content);
      break;
    case "execute_result":
    case "display_data":
      applyResultMessage(cell, content, msgType);
      break;
    case "error":
      applyErrorMessage(cell, content);
      break;
    case "clear_output":
      applyClearOutputMessage(cell);
      break;
    default:
      return;
  }
  onCellUpdated(index);
}

// src/core/commands.ts
function createCommands(session, kernel) {
  const commands = {
    async render(raw, dir, path) {
      const hadExistingServerState = session.cells.length > 0;
      if (dir !== void 0) session.notebookDir = dir;
      if (path !== void 0) session.notebookPath = path;
      const nb = JSON.parse(raw);
      session.kernelName = session.kernelOverride ?? nb.metadata?.kernelspec?.name ?? session.kernelName;
      session.emitKernel();
      session.cells = mergeCells(session.cells, renderNotebook(nb));
      reconcileBusyStatus(session.cells, session.pendingExecs);
      session.broadcastFull();
      if (hadExistingServerState) await session.persistOutputsToDisk();
    },
    async sync(body) {
      const previousCells = session.cells;
      session.cells = syncCells(session.cells, body.cells ?? []);
      reconcileBusyStatus(session.cells, session.pendingExecs);
      session.broadcastSync(previousCells);
    },
    async execute(body) {
      const index = body.index;
      const code = body.code ?? "";
      if (typeof index !== "number" || typeof code !== "string" || session.cells[index]?.cell_type !== "code")
        return { status: 400, body: { ok: false, error: "invalid cell index" } };
      const cell = session.cells[index];
      const msgId = crypto.randomUUID();
      cell.source = code;
      session.pendingExecs.set(msgId, { index, id: cell.id, source: code });
      cell.outputs = [];
      cell.nbformat_outputs = [];
      cell.status = "busy";
      cell.started_at = void 0;
      cell.duration_ms = void 0;
      session.broadcastCell(index);
      const abandon = (error) => {
        const pending = session.pendingExecs.get(msgId);
        if (!pending) return;
        session.pendingExecs.delete(msgId);
        const failed = session.pendingCellIndex(pending);
        if (failed === null) return;
        appendExecutionFailure(
          session.cells[failed],
          String(error instanceof Error ? error.message : error)
        );
        session.cells[failed].status = "idle";
        session.broadcastCell(failed);
      };
      try {
        await kernel.ensureStarted(session.kernelName || "python3");
        kernel.write({ cmd: "execute", id: msgId, code, allow_stdin: session.wsClients.size > 0 });
      } catch (error) {
        abandon(error);
        throw error;
      }
    },
    restart() {
      kernel.cleanup();
      for (const cell of session.cells) {
        if (cell.status === "busy") cell.status = "idle";
      }
      session.broadcastFull();
    },
    async input(body) {
      if (!kernel.running) return { status: 409, body: { ok: false, error: "no running kernel" } };
      kernel.write({ cmd: "input_reply", value: String(body.value ?? "") });
      session.pendingInputRequest = null;
    },
    async interrupt() {
      if (!kernel.running)
        return { status: 409, body: { ok: false, error: "no running kernel to interrupt" } };
      kernel.write({ cmd: "interrupt" });
    },
    /** The kernel's user variables. Empty (without starting a kernel) before the first run. */
    async variables() {
      if (!kernel.running)
        return { status: 200, body: { ok: true, variables: [], kernel_running: false } };
      return {
        status: 200,
        body: { ok: true, variables: await kernel.listVariables(), kernel_running: true }
      };
    },
    async kernels() {
      return {
        status: 200,
        body: {
          ok: true,
          kernels: await kernel.listKernels(),
          current: session.kernelName ?? null
        }
      };
    },
    /** Switches kernels: the next run starts the chosen one, in-memory state is lost. */
    async selectKernel(body) {
      const available = await kernel.listKernels();
      if (typeof body.name !== "string" || !available.some((k) => k.name === body.name))
        return { status: 400, body: { ok: false, error: `unknown kernel: ${body.name}` } };
      session.kernelOverride = body.name;
      session.kernelName = body.name;
      commands.restart();
      session.emitKernel();
      return { status: 200, body: { ok: true, kernel: body.name } };
    },
    /**
     * Builds a report in the connected preview page and writes it to `path`
     * (default: next to the notebook). `mode` "report" omits code inputs.
     */
    async export(body) {
      const mode = body.mode === "report" ? "report" : "html";
      const html = await session.requestExport(mode);
      const target = body.path || defaultExportPath(session.notebookPath, mode);
      if (!target) return { status: 400, body: { ok: false, error: "no output path known" } };
      await writeFile2(target, html, "utf8");
      return { status: 200, body: { ok: true, path: target } };
    },
    async print() {
      if (session.wsClients.size === 0)
        return { status: 409, body: { ok: false, error: "no preview window is connected" } };
      session.broadcast(JSON.stringify({ type: "print" }));
    },
    async theme(body) {
      const name = body.name === "default" ? null : body.name;
      if (name !== null && !PRESET_NAMES.includes(name))
        return { status: 400, body: { ok: false, error: `unknown theme: ${body.name}` } };
      session.theme = name;
      session.broadcast(session.themePayload());
    },
    async cursor(body) {
      session.broadcast(JSON.stringify({ type: "cursor", index: body.index }));
    }
  };
  return commands;
}
function defaultExportPath(notebookPath, mode) {
  if (!notebookPath) return void 0;
  const stem = basename(notebookPath, extname(notebookPath));
  return join(dirname(notebookPath), `${stem}${mode === "report" ? "-report" : ""}.html`);
}

// src/kernel/coordinator.ts
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { randomUUID } from "node:crypto";

// src/kernel/inspect-code.ts
var INSPECT_START = "IPK_VARS";
var INSPECT_END = "";
var INSPECT_CODE = `
def __ipk_vars():
    import json, sys, types, reprlib
    ip = get_ipython()
    ns, hidden = ip.user_ns, getattr(ip, "user_ns_hidden", {})
    skip = (types.ModuleType, types.FunctionType, types.BuiltinFunctionType, type)
    short = reprlib.Repr()
    short.maxstring = short.maxother = 60
    short.maxlist = short.maxtuple = short.maxdict = short.maxset = 6
    rows = []
    for name, val in list(ns.items()):
        if name.startswith("_") or name in hidden or isinstance(val, skip):
            continue
        row = {"name": name, "type": type(val).__name__, "shape": "", "size_bytes": None, "preview": ""}
        try:
            if isinstance(val, (str, bytes)):
                pass
            elif hasattr(val, "shape"):
                row["shape"] = str(tuple(val.shape))
            elif hasattr(val, "__len__"):
                n = len(val)
                row["shape"] = "%d %s" % (n, "keys" if isinstance(val, dict) else "items")
        except Exception:
            pass
        try:
            if hasattr(val, "memory_usage") and hasattr(val, "columns"):
                row["size_bytes"] = int(val.memory_usage(deep=True).sum())
            elif hasattr(val, "memory_usage"):
                row["size_bytes"] = int(val.memory_usage(deep=True))
            elif hasattr(val, "nbytes"):
                row["size_bytes"] = int(val.nbytes)
            elif hasattr(val, "element_size") and hasattr(val, "nelement"):
                row["size_bytes"] = int(val.element_size() * val.nelement())
            else:
                row["size_bytes"] = int(sys.getsizeof(val))
        except Exception:
            pass
        try:
            if hasattr(val, "columns") and hasattr(val, "shape"):
                row["preview"] = short.repr(list(val.columns))
            elif hasattr(val, "device") and hasattr(val, "dtype"):
                row["preview"] = "%s on %s" % (val.dtype, val.device)
            else:
                row["preview"] = short.repr(val).replace("\\n", " ")[:100]
        except Exception:
            row["preview"] = "<unrepresentable>"
        rows.append(row)
    rows.sort(key=lambda r: -(r["size_bytes"] or 0))
    print("\\x1eIPK_VARS" + json.dumps(rows) + "\\x1e")
__ipk_vars()
del __ipk_vars
`;

// src/kernel/coordinator.ts
function readLines(stream, onLine) {
  const rl = readline.createInterface({ input: stream });
  rl.on("line", (line) => {
    if (line.trim()) onLine(line);
  });
}
var KernelCoordinator = class {
  constructor(session, bridgeUrl) {
    this.session = session;
    this.bridgeUrl = bridgeUrl;
    process.on("exit", this.onProcessExit);
  }
  session;
  bridgeUrl;
  bridgeProc = null;
  readyPromise = null;
  readyResolve = null;
  readyReject = null;
  inspections = /* @__PURE__ */ new Map();
  onProcessExit = () => this.cleanup();
  get running() {
    return this.bridgeProc !== null;
  }
  write(obj) {
    if (!this.bridgeProc?.stdin?.writable) throw new Error("kernel bridge is not available");
    this.bridgeProc.stdin.write(JSON.stringify(obj) + "\n");
  }
  async ensureStarted(kernelName) {
    if (!this.bridgeProc) this.start(kernelName);
    const ready = this.readyPromise;
    if (!ready) throw new Error("kernel bridge failed to initialize");
    await ready;
  }
  /** Kills the bridge and forgets any in-flight execution/input state. */
  cleanup() {
    const proc = this.bridgeProc;
    this.readyReject?.(new Error("kernel stopped"));
    this.readyResolve = null;
    this.readyReject = null;
    this.bridgeProc = null;
    this.readyPromise = null;
    try {
      proc?.kill();
    } catch {
    }
    this.session.pendingExecs.clear();
    this.session.pendingInputRequest = null;
    this.rejectInspections("kernel stopped");
    this.session.setKernelRunning(false);
  }
  /**
   * Runs `code` quietly (no execution count, no history) and resolves with
   * what it printed. Queues behind whatever the kernel is already running.
   */
  async runQuiet(code, timeoutMs = 6e4) {
    await this.ensureStarted(this.session.kernelName || "python3");
    const id = randomUUID();
    return new Promise((resolve2, reject) => {
      const timer = setTimeout(() => {
        this.inspections.delete(id);
        reject(new Error("timed out waiting for the kernel (is a cell still running?)"));
      }, timeoutMs);
      this.inspections.set(id, { chunks: [], resolve: resolve2, reject, timer });
      try {
        this.write({ cmd: "execute", id, code, allow_stdin: false, quiet: true });
      } catch (error) {
        clearTimeout(timer);
        this.inspections.delete(id);
        reject(error);
      }
    });
  }
  /** The user's variables as the quiet inspection script reports them. */
  async listVariables() {
    const output = await this.runQuiet(INSPECT_CODE);
    const start = output.lastIndexOf(INSPECT_START);
    const end = output.indexOf(INSPECT_END, start + INSPECT_START.length);
    if (start === -1 || end === -1) throw new Error("the kernel did not report its variables");
    return JSON.parse(output.slice(start + INSPECT_START.length, end));
  }
  /**
   * Installed kernelspecs, found the way the bridge itself would (the
   * notebook's project-local venv first) via a short-lived bridge process, so
   * this works before any kernel has been started.
   */
  listKernels() {
    const id = randomUUID();
    return new Promise((resolve2, reject) => {
      const proc = spawn("node", [fileURLToPath(this.bridgeUrl)]);
      const finish = (action) => {
        clearTimeout(timer);
        try {
          proc.kill();
        } catch {
        }
        action();
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error("timed out listing Jupyter kernels"))),
        15e3
      );
      readLines(proc.stdout, (line) => {
        try {
          const message = JSON.parse(line);
          if (message.type === "kernelspecs" && message.id === id)
            finish(() => resolve2(message.kernels));
          else if (message.type === "error" && message.operation === "list_kernels")
            finish(() => reject(new Error(message.message)));
        } catch {
        }
      });
      proc.on("error", (error) => finish(() => reject(error)));
      proc.stdin.write(
        JSON.stringify({ cmd: "list_kernels", id, cwd: this.session.notebookDir }) + "\n"
      );
    });
  }
  rejectInspections(message) {
    for (const inspection of this.inspections.values()) {
      clearTimeout(inspection.timer);
      inspection.reject(new Error(message));
    }
    this.inspections.clear();
  }
  dispose() {
    process.off("exit", this.onProcessExit);
    this.cleanup();
  }
  fail(proc, message) {
    if (this.bridgeProc !== proc) return;
    this.readyReject?.(new Error(message));
    this.readyResolve = null;
    this.readyReject = null;
    this.bridgeProc = null;
    this.readyPromise = null;
    try {
      proc.kill();
    } catch {
    }
    this.session.failPendingExecutions(message);
    this.rejectInspections(message);
    this.session.setKernelRunning(false);
  }
  collectInspection(message) {
    const inspection = this.inspections.get(message.parent_id);
    if (message.msg_type === "stream") inspection.chunks.push(String(message.content?.text ?? ""));
    else if (message.msg_type === "error") {
      clearTimeout(inspection.timer);
      this.inspections.delete(message.parent_id);
      inspection.reject(new Error(`${message.content?.ename}: ${message.content?.evalue}`));
    } else if (message.msg_type === "status" && message.content?.execution_state === "idle") {
      clearTimeout(inspection.timer);
      this.inspections.delete(message.parent_id);
      inspection.resolve(inspection.chunks.join(""));
    }
  }
  start(kernelName) {
    if (this.bridgeProc) return;
    const { session } = this;
    this.readyPromise = new Promise((resolve2, reject) => {
      this.readyResolve = resolve2;
      this.readyReject = reject;
    });
    const proc = spawn("node", [fileURLToPath(this.bridgeUrl)]);
    this.bridgeProc = proc;
    readLines(proc.stdout, (line) => {
      let bridgeMessage;
      try {
        bridgeMessage = JSON.parse(line);
      } catch (error) {
        console.error("[kernel-bridge] received malformed line on stdout:", line, error);
        return;
      }
      if (bridgeMessage.type === "ready") {
        this.session.setKernelRunning(true);
        this.readyResolve?.();
        this.readyResolve = null;
        this.readyReject = null;
      } else if (bridgeMessage.type === "iopub" && this.inspections.has(bridgeMessage.parent_id)) {
        this.collectInspection(bridgeMessage);
      } else if (bridgeMessage.type === "iopub")
        handleIopub(
          bridgeMessage.parent_id,
          bridgeMessage.msg_type,
          bridgeMessage.content,
          session.cells,
          session.pendingExecs,
          (index) => {
            session.broadcastCell(index);
            if (session.cells[index]?.status === "idle") void session.persistOutputsToDisk();
          }
        );
      else if (bridgeMessage.type === "input_request") {
        const pending = session.pendingExecs.get(bridgeMessage.parent_id);
        const index = pending ? session.pendingCellIndex(pending) : null;
        session.pendingInputRequest = {
          index,
          prompt: String(bridgeMessage.prompt ?? ""),
          password: bridgeMessage.password === true
        };
        session.broadcast(session.inputRequestPayload());
      } else if (bridgeMessage.type === "error") {
        const message = String(bridgeMessage.message ?? "kernel bridge error");
        const inspection = bridgeMessage.id ? this.inspections.get(bridgeMessage.id) : void 0;
        if (inspection) {
          clearTimeout(inspection.timer);
          this.inspections.delete(bridgeMessage.id);
          inspection.reject(new Error(message));
        } else if (bridgeMessage.operation === "start") this.fail(proc, message);
        else if (bridgeMessage.operation === "execute" && bridgeMessage.id) {
          const pending = session.pendingExecs.get(bridgeMessage.id);
          if (pending) {
            const index = session.pendingCellIndex(pending);
            session.pendingExecs.delete(bridgeMessage.id);
            if (index !== null) {
              const cell = session.cells[index];
              appendExecutionFailure(cell, message);
              cell.status = "idle";
              cell.duration_ms = cell.started_at ? Date.now() - cell.started_at : void 0;
              session.broadcastCell(index);
            }
          }
        } else console.error("[kernel-bridge]", message);
      } else if (bridgeMessage.type === "kernel_exit") {
        const detail = bridgeMessage.stderr ? `: ${bridgeMessage.stderr}` : "";
        this.fail(proc, `kernel process exited with code ${bridgeMessage.code}${detail}`);
      }
    });
    proc.stdout.on("error", (error) => this.fail(proc, `kernel bridge stdout failed: ${error}`));
    readLines(proc.stderr, (line) => {
      console.error("[kernel-bridge stderr]", line);
    });
    proc.stderr.on("error", () => {
    });
    proc.on("error", (error) => this.fail(proc, `failed to start kernel bridge: ${error.message}`));
    proc.on("exit", (code, signal) => {
      this.fail(proc, `kernel bridge exited (${signal ?? code ?? "unknown"})`);
    });
    this.write({ cmd: "start", kernel_name: kernelName, cwd: session.notebookDir });
  }
};

// src/core/security.ts
function hasLoopbackHost(req) {
  const host = req.headers.host;
  if (!host) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
}
function isAuthorized(req, url, token) {
  if (!token) return true;
  const header = req.headers["x-ipynb-peek-token"];
  if (typeof header === "string" && header === token) return true;
  return url.searchParams.get("token") === token;
}
function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

// src/http/asset-handler.ts
import { readFileSync } from "node:fs";
import { extname as extname2 } from "node:path";

// src/asset-path.ts
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
var AssetOutsideNotebookDirectoryError = class extends Error {
  constructor() {
    super("asset path escapes the notebook directory");
    this.name = "AssetOutsideNotebookDirectoryError";
  }
};
function resolveNotebookAssetPath(notebookDir, requestedPath) {
  const root = realpathSync(resolve(notebookDir));
  const unresolvedAssetPath = resolve(root, requestedPath);
  const assetPath = realpathSync(unresolvedAssetPath);
  const pathFromRoot = relative(root, assetPath);
  const escapesRoot = pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot);
  if (escapesRoot) {
    throw new AssetOutsideNotebookDirectoryError();
  }
  return assetPath;
}

// src/http/respond.ts
function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve2, reject) => {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => resolve2(body));
    req.on("error", reject);
  });
}
async function handleJsonRoute(res, fn) {
  try {
    const override = await fn();
    if (override) sendJson(res, override.status, override.body);
    else sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: String(error?.stack ?? error) });
  }
}

// src/http/asset-handler.ts
var contentTypes = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml"
};
function serveNotebookAsset(res, notebookDir, requested) {
  if (!notebookDir || !requested)
    return sendJson(res, 404, { ok: false, error: "notebook asset not found" });
  let assetPath;
  try {
    assetPath = resolveNotebookAssetPath(notebookDir, requested);
  } catch (err) {
    if (err instanceof AssetOutsideNotebookDirectoryError)
      return sendJson(res, 403, { ok: false, error: "asset path leaves notebook directory" });
    return sendJson(res, 404, { ok: false, error: "notebook asset not found" });
  }
  try {
    const contentType = contentTypes[extname2(assetPath).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": contentType, "x-content-type-options": "nosniff" });
    return res.end(readFileSync(assetPath));
  } catch {
    return sendJson(res, 404, { ok: false, error: "notebook asset not found" });
  }
}

// src/http/router.ts
function createRouter({ session, commands, statics, themeCss, token }) {
  return async function handleRequest(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!hasLoopbackHost(req))
      return sendJson(res, 403, { ok: false, error: "invalid host header" });
    if (url.pathname === "/") return statics.serveIndexHtml(res);
    if (url.pathname === "/style.css")
      return statics.serveAsset(res, "style.css", "text/css; charset=utf-8");
    if (url.pathname === "/theme.css") {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      return res.end(themeCss);
    }
    if (url.pathname === "/katex.min.css")
      return statics.serveAsset(res, "katex.min.css", "text/css; charset=utf-8");
    if (url.pathname.startsWith("/fonts/") && /^[a-zA-Z0-9_.-]+\.woff2$/.test(url.pathname.slice(7)))
      return statics.serveAsset(res, url.pathname.slice(1), "font/woff2");
    if (url.pathname === "/client.js")
      return statics.serveAsset(res, "client.js", "text/javascript; charset=utf-8");
    if (["/math-renderer.js", "/chart-plotly.js", "/chart-vega.js"].includes(url.pathname))
      return statics.serveAsset(res, url.pathname.slice(1), "text/javascript; charset=utf-8");
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("ok");
    }
    if (!isAuthorized(req, url, token))
      return sendJson(res, 401, { ok: false, error: "unauthorized" });
    if (url.pathname === "/notebook-asset" && req.method === "GET")
      return serveNotebookAsset(res, session.notebookDir, url.searchParams.get("path"));
    if (url.pathname === "/render" && req.method === "POST") {
      return handleJsonRoute(res, async () => {
        const dirHeader = req.headers["x-notebook-dir"];
        const pathHeader = req.headers["x-notebook-path"];
        return commands.render(
          await readBody(req),
          typeof dirHeader === "string" ? dirHeader : void 0,
          typeof pathHeader === "string" ? pathHeader : void 0
        );
      });
    }
    if (url.pathname === "/sync" && req.method === "POST") {
      return handleJsonRoute(res, async () => commands.sync(JSON.parse(await readBody(req))));
    }
    if (url.pathname === "/execute" && req.method === "POST") {
      return handleJsonRoute(res, async () => commands.execute(JSON.parse(await readBody(req))));
    }
    if (url.pathname === "/restart" && req.method === "POST") {
      commands.restart();
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === "/input" && req.method === "POST") {
      return handleJsonRoute(res, async () => commands.input(JSON.parse(await readBody(req))));
    }
    if (url.pathname === "/interrupt" && req.method === "POST") {
      return handleJsonRoute(res, async () => commands.interrupt());
    }
    if (url.pathname === "/variables" && req.method === "POST") {
      return handleJsonRoute(res, async () => commands.variables());
    }
    if (url.pathname === "/export-result" && req.method === "POST") {
      return handleJsonRoute(res, async () => {
        const body = JSON.parse(await readBody(req));
        const known = session.resolveExport(String(body.id), body.html, body.error);
        if (!known) return { status: 404, body: { ok: false, error: "unknown export id" } };
      });
    }
    if (url.pathname === "/events") {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      const unsubscribe = session.subscribe((line) => {
        try {
          res.write(line + "\n");
        } catch {
        }
      });
      req.on("close", unsubscribe);
      return;
    }
    if (url.pathname === "/cursor" && req.method === "POST") {
      return handleJsonRoute(res, async () => commands.cursor(JSON.parse(await readBody(req))));
    }
    res.writeHead(404);
    res.end("not found");
  };
}

// src/http/static-handler.ts
import { existsSync, readFileSync as readFileSync2 } from "node:fs";
var SOURCE_LAYOUT_ALIASES = {
  "client.js": "client/index.js",
  "math-renderer.js": "client/math-renderer.js",
  "chart-plotly.js": "client/chart-plotly.js",
  "chart-vega.js": "client/chart-vega.js"
};
function resolveAsset(assetBase, filename) {
  const direct = new URL(`./${filename}`, assetBase);
  const alias = SOURCE_LAYOUT_ALIASES[filename];
  return alias && !existsSync(direct) ? new URL(`./${alias}`, assetBase) : direct;
}
function createStaticHandler(assetBase, token) {
  return {
    serveAsset(res, filename, contentType) {
      res.writeHead(200, { "content-type": contentType });
      res.end(readFileSync2(resolveAsset(assetBase, filename)));
    },
    /**
     * Injects the auth token the page's own client.js needs to open its /ws
     * connection into a meta element in index.html before serving it. Safe to
     * embed unauthenticated: a cross-origin page can navigate/iframe this URL
     * but can't read the response body or reach into the iframe's DOM
     * (Same-Origin Policy), so the token never leaves this page's own JS
     * context.
     */
    serveIndexHtml(res) {
      const html = readFileSync2(new URL("./index.html", assetBase), "utf8");
      const injected = html.replace("__IPYNB_PEEK_TOKEN__", token ?? "").replace("__IPYNB_PEEK_THEMES__", PRESET_NAMES.join(","));
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "font-src 'self'",
          "connect-src 'self' ws://127.0.0.1:*",
          "object-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-ancestors 'none'"
        ].join("; "),
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff"
      });
      res.end(injected);
    }
  };
}

// src/ws/gateway.ts
import { WebSocketServer } from "ws";
function isIndex(value, length) {
  return Number.isInteger(value) && value >= 0 && value < length;
}
function attachWebSocketGateway(httpServer, session, token) {
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws) => {
    session.wsClients.add(ws);
    ws.send(session.renderPayload());
    if (session.theme !== null) ws.send(session.themePayload());
    if (session.pendingInputRequest) ws.send(session.inputRequestPayload());
    ws.on("message", (data) => {
      try {
        const parsedMessage = JSON.parse(data.toString());
        if (parsedMessage.type === "insert_cell" && Number.isInteger(parsedMessage.after_index) && parsedMessage.after_index >= -1 && (parsedMessage.cell_type === "code" || parsedMessage.cell_type === "markdown")) {
          session.emitEvent({
            type: "insert_cell",
            after_index: parsedMessage.after_index,
            cell_type: parsedMessage.cell_type
          });
        } else if (parsedMessage.type === "jump_cell_line" && isIndex(parsedMessage.cell_index, session.cells.length) && Number.isInteger(parsedMessage.line_offset) && parsedMessage.line_offset >= 1) {
          session.emitEvent({
            type: "jump_cell_line",
            cell_index: parsedMessage.cell_index,
            line_offset: parsedMessage.line_offset
          });
        } else if (parsedMessage.type === "goto_cell" && isIndex(parsedMessage.index, session.cells.length)) {
          session.emitEvent({ type: "goto_cell", index: parsedMessage.index });
        } else if (parsedMessage.type === "open_file" && typeof parsedMessage.path === "string" && parsedMessage.path.length > 0 && parsedMessage.path.length < 4096 && Number.isInteger(parsedMessage.line) && parsedMessage.line >= 1) {
          session.emitEvent({
            type: "open_file",
            path: parsedMessage.path,
            line: parsedMessage.line
          });
        } else if (parsedMessage.type === "delete_cell" && Number.isInteger(parsedMessage.index) && parsedMessage.index >= 0 && isCellDeletable(session.cells[parsedMessage.index])) {
          session.emitEvent({ type: "delete_cell", index: parsedMessage.index });
        }
      } catch (error) {
        console.error("[ipynb-peek] received malformed websocket message from client:", data, error);
      }
    });
    ws.on("close", () => session.wsClients.delete(ws));
  });
  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!hasLoopbackHost(req) || !isSameOrigin(req) || url.pathname !== "/ws" || !isAuthorized(req, url, token)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });
  return wss;
}

// src/core/daemon.ts
function createServer(entryUrl, port, token) {
  const session = new NotebookSession();
  const kernel = new KernelCoordinator(session, new URL("./kernel-bridge.mjs", entryUrl));
  const commands = createCommands(session, kernel);
  const handleRequest = createRouter({
    session,
    commands,
    statics: createStaticHandler(new URL("./", entryUrl), token),
    // IPYNB_PEEK_THEME is fixed for the lifetime of this process (set once by
    // lua/ipynb-peek/server.lua when it spawns this server, from
    // M.config.theme) - computed once here rather than per-request.
    themeCss: buildThemeCss(process.env.IPYNB_PEEK_THEME),
    token
  });
  const httpServer = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      console.error("[ipynb-peek] unhandled request error:", error);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error?.stack ?? error) });
    });
  });
  httpServer.timeout = 0;
  httpServer.keepAliveTimeout = 0;
  const wss = attachWebSocketGateway(httpServer, session, token);
  return new Promise((resolve2, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "127.0.0.1", () => {
      httpServer.removeListener("error", reject);
      const address = httpServer.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolve2({
        port: actualPort,
        session,
        commands,
        stop(force = false) {
          kernel.dispose();
          if (force) {
            for (const ws of session.wsClients) ws.terminate();
            httpServer.closeAllConnections();
          }
          wss.close();
          httpServer.close();
          session.reset();
        }
      });
    });
  });
}
function serveStdio(input, write, session, commands) {
  const respond = (id, result, error) => {
    if (id === void 0) return;
    if (error !== void 0)
      write(
        JSON.stringify({
          type: "response",
          id,
          ok: false,
          error: String(error?.stack ?? error)
        })
      );
    else if (result) write(JSON.stringify({ type: "response", id, ...result.body }));
    else write(JSON.stringify({ type: "response", id, ok: true }));
  };
  const dispatch = async (msg) => {
    switch (msg.type) {
      case "render":
        return commands.render(String(msg.notebook ?? ""), msg.dir, msg.path);
      case "sync":
        return commands.sync(msg);
      case "execute":
        return commands.execute(msg);
      case "cursor":
        return commands.cursor(msg);
      case "restart":
        return commands.restart();
      case "input":
        return commands.input(msg);
      case "interrupt":
        return commands.interrupt();
      case "theme":
        return commands.theme(msg);
      case "variables":
        return commands.variables();
      case "kernels":
        return commands.kernels();
      case "select_kernel":
        return commands.selectKernel(msg);
      case "export":
        return commands.export(msg);
      case "print":
        return commands.print();
      default:
        return { status: 400, body: { ok: false, error: `unknown command: ${msg.type}` } };
    }
  };
  const unordered = /* @__PURE__ */ new Set([
    "restart",
    "interrupt",
    "input",
    "variables",
    "kernels",
    "select_kernel",
    "export",
    "print"
  ]);
  let queue = Promise.resolve();
  const rl = readline2.createInterface({ input });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (error) {
      console.error("[ipynb-peek] received malformed command on stdin:", line, error);
      return;
    }
    const run = () => dispatch(msg).then(
      (result) => respond(msg.id, result),
      (error) => respond(msg.id, void 0, error)
    );
    if (unordered.has(msg.type)) void run();
    else queue = queue.then(run);
  });
  const unsubscribe = session.subscribe(write);
  return {
    closed: new Promise((resolve2) => rl.once("close", resolve2)),
    stop() {
      unsubscribe();
      rl.close();
    }
  };
}
async function runDaemon(entryUrl) {
  const token = process.env.IPYNB_PEEK_TOKEN || randomBytes(32).toString("hex");
  const server = await createServer(entryUrl, Number(process.env.IPYNB_PEEK_PORT ?? 0), token);
  const stdio = serveStdio(
    process.stdin,
    (line) => process.stdout.write(line + "\n"),
    server.session,
    server.commands
  );
  const shutdown = () => {
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdout.write(
    JSON.stringify({
      type: "ready",
      port: server.port,
      token,
      url: `http://127.0.0.1:${server.port}/`
    }) + "\n"
  );
  void stdio.closed.then(shutdown);
}
function isMainModule(entryUrl) {
  return Boolean(
    import.meta.main || process.argv[1] && fileURLToPath2(entryUrl) === process.argv[1]
  );
}

// src/index.ts
function createServer2(port = Number(process.env.IPYNB_PEEK_PORT ?? 0), token = process.env.IPYNB_PEEK_TOKEN) {
  return createServer(import.meta.url, port, token);
}
if (isMainModule(import.meta.url)) await runDaemon(import.meta.url);
export {
  createServer2 as createServer,
  serveStdio
};
