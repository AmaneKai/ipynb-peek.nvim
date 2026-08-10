// src/index.ts
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extname } from "node:path";
import readline from "node:readline";
import { WebSocketServer, WebSocket } from "ws";

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
function renderOutput(output) {
  const data = output.data ?? {};
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
    if (prevCell && prevCell.source === cell.source && prevCell.cell_type === cell.cell_type && (prevCell.outputs.length > 0 || prevCell.execution_count)) {
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
function patchNotebookOutputs(notebookJson, currentCells2) {
  const nbCells = Array.isArray(notebookJson?.cells) ? notebookJson.cells : [];
  const usedNotebookIndices = /* @__PURE__ */ new Set();
  for (let currentIndex = 0; currentIndex < currentCells2.length; currentIndex++) {
    const cell = currentCells2[currentIndex];
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

// src/iopub.ts
function applyStatusMessage(cell, content, parentId, pendingExecs2) {
  if (content.execution_state === "busy") {
    cell.status = "busy";
    cell.started_at = Date.now();
  } else if (content.execution_state === "idle") {
    cell.status = "idle";
    cell.duration_ms = cell.started_at ? Date.now() - cell.started_at : void 0;
    pendingExecs2.delete(parentId);
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
  if (data["image/png"])
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
function resolveCellIndex(currentCells2, pending) {
  if (pending.id) {
    const idIndex = currentCells2.findIndex((cell) => cell.id === pending.id);
    if (idIndex !== -1) return idIndex;
  }
  if (currentCells2[pending.index]?.source === pending.source) return pending.index;
  const foundIndex = currentCells2.findIndex((cell) => cell.source === pending.source);
  return foundIndex === -1 ? null : foundIndex;
}
function reconcileBusyStatus(currentCells2, pendingExecs2) {
  const runningIndices = /* @__PURE__ */ new Set();
  for (const pending of pendingExecs2.values()) {
    const index = resolveCellIndex(currentCells2, pending);
    if (index !== null) runningIndices.add(index);
  }
  currentCells2.forEach((cell, index) => {
    if (cell.status === "busy" && !runningIndices.has(index)) {
      cell.status = "idle";
      cell.duration_ms = void 0;
    }
  });
}
function handleIopub(parentId, msgType, content, currentCells2, pendingExecs2, onCellUpdated) {
  const pending = pendingExecs2.get(parentId);
  if (pending === void 0) return;
  const index = resolveCellIndex(currentCells2, pending);
  if (index === null) return;
  const cell = currentCells2[index];
  if (!cell) return;
  switch (msgType) {
    case "status":
      applyStatusMessage(cell, content, parentId, pendingExecs2);
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
  for (const [key, value] of Object.entries(colors)) {
    lines.push(`  ${cssVar("--ipynb-", key)}: ${value};`);
  }
  for (const [key, value] of Object.entries(font)) {
    if (value == null) continue;
    lines.push(`  ${cssVar("--ipynb-font-", key)}: ${cssValue(value)};`);
  }
  lines.push("}");
  return lines.join("\n");
}

// src/asset-path.ts
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
var AssetOutsideNotebookDirectoryError = class extends Error {
  constructor() {
    super("asset path escapes the notebook directory");
    this.name = "AssetOutsideNotebookDirectoryError";
  }
};
function resolveNotebookAssetPath(notebookDir2, requestedPath) {
  const root = realpathSync(resolve(notebookDir2));
  const unresolvedAssetPath = resolve(root, requestedPath);
  const assetPath = realpathSync(unresolvedAssetPath);
  const pathFromRoot = relative(root, assetPath);
  const escapesRoot = pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot);
  if (escapesRoot) {
    throw new AssetOutsideNotebookDirectoryError();
  }
  return assetPath;
}

// src/index.ts
var currentCells = [];
var notebookKernelName;
var notebookDir;
var notebookPath;
var wsClients = /* @__PURE__ */ new Set();
var authToken;
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
function isAuthorized(req, url) {
  if (!authToken) return true;
  const header = req.headers["x-ipynb-peek-token"];
  if (typeof header === "string" && header === authToken) return true;
  return url.searchParams.get("token") === authToken;
}
function publicCell(cell) {
  const { nbformat_outputs: _nbformatOutputs, ...visibleCell } = cell;
  return visibleCell;
}
function renderPayload() {
  return JSON.stringify({ type: "render", cells: currentCells.map(publicCell) });
}
function broadcast(payload) {
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}
function broadcastFull() {
  broadcast(renderPayload());
  emitEvent({ type: "cells_status", cells: currentCells.map(cellStatusInfo) });
}
function broadcastCell(index) {
  broadcast(JSON.stringify({ type: "cell_update", index, cell: publicCell(currentCells[index]) }));
  emitEvent({ type: "cell_status", ...cellStatusInfo(currentCells[index], index) });
}
function broadcastSync(previousCells) {
  if (previousCells.length !== currentCells.length) {
    broadcastFull();
    return;
  }
  for (let index = 0; index < currentCells.length; index++) {
    const previous = previousCells[index];
    const current = currentCells[index];
    if (previous.source !== current.source || previous.cell_type !== current.cell_type)
      broadcastCell(index);
  }
}
async function persistOutputsToDisk() {
  if (!notebookPath) return;
  try {
    const path = notebookPath;
    const cellsSnapshot = structuredClone(currentCells);
    await updateNotebookFile(path, (notebookJson) => {
      patchNotebookOutputs(notebookJson, cellsSnapshot);
    });
  } catch (error) {
    console.error("[ipynb-peek] failed to persist outputs to disk:", error);
  }
}
var eventSubscribers = /* @__PURE__ */ new Set();
function emitEvent(event) {
  const line = JSON.stringify(event) + "\n";
  for (const send of eventSubscribers) send(line);
}
var bridgeProc = null;
var kernelReadyPromise = null;
var kernelReadyResolve = null;
var kernelReadyReject = null;
var pendingExecs = /* @__PURE__ */ new Map();
var pendingInputRequest = null;
function inputRequestPayload() {
  return JSON.stringify({ type: "input_request", ...pendingInputRequest });
}
function readLines(stream, onLine) {
  const rl = readline.createInterface({ input: stream });
  rl.on("line", (line) => {
    if (line.trim()) onLine(line);
  });
}
function writeToBridge(obj) {
  if (!bridgeProc?.stdin?.writable) throw new Error("kernel bridge is not available");
  bridgeProc.stdin.write(JSON.stringify(obj) + "\n");
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
function pendingCellIndex(pending) {
  if (pending.id) {
    const idIndex = currentCells.findIndex((cell) => cell.id === pending.id);
    if (idIndex !== -1) return idIndex;
  }
  if (currentCells[pending.index]?.source === pending.source) return pending.index;
  const sourceIndex = currentCells.findIndex((cell) => cell.source === pending.source);
  return sourceIndex === -1 ? null : sourceIndex;
}
function failPendingExecutions(message) {
  const updated = /* @__PURE__ */ new Set();
  for (const pending of pendingExecs.values()) {
    const index = pendingCellIndex(pending);
    if (index === null || updated.has(index)) continue;
    const cell = currentCells[index];
    appendExecutionFailure(cell, message);
    cell.status = "idle";
    cell.duration_ms = cell.started_at ? Date.now() - cell.started_at : void 0;
    updated.add(index);
  }
  pendingExecs.clear();
  for (const index of updated) broadcastCell(index);
}
function failBridge(proc, message) {
  if (bridgeProc !== proc) return;
  kernelReadyReject?.(new Error(message));
  kernelReadyResolve = null;
  kernelReadyReject = null;
  bridgeProc = null;
  kernelReadyPromise = null;
  try {
    proc.kill();
  } catch {
  }
  failPendingExecutions(message);
}
function startBridge(kernelName) {
  if (bridgeProc) return;
  kernelReadyPromise = new Promise((resolve2, reject) => {
    kernelReadyResolve = resolve2;
    kernelReadyReject = reject;
  });
  const bridgePath = fileURLToPath(new URL("./kernel-bridge.mjs", import.meta.url));
  const proc = spawn("node", [bridgePath]);
  bridgeProc = proc;
  readLines(proc.stdout, (line) => {
    let bridgeMessage;
    try {
      bridgeMessage = JSON.parse(line);
    } catch (error) {
      console.error("[kernel-bridge] received malformed line on stdout:", line, error);
      return;
    }
    if (bridgeMessage.type === "ready") {
      kernelReadyResolve?.();
      kernelReadyResolve = null;
      kernelReadyReject = null;
    } else if (bridgeMessage.type === "iopub")
      handleIopub(
        bridgeMessage.parent_id,
        bridgeMessage.msg_type,
        bridgeMessage.content,
        currentCells,
        pendingExecs,
        (index) => {
          broadcastCell(index);
          if (currentCells[index]?.status === "idle") void persistOutputsToDisk();
        }
      );
    else if (bridgeMessage.type === "input_request") {
      const pending = pendingExecs.get(bridgeMessage.parent_id);
      const index = pending ? pendingCellIndex(pending) : null;
      pendingInputRequest = {
        index,
        prompt: String(bridgeMessage.prompt ?? ""),
        password: bridgeMessage.password === true
      };
      broadcast(inputRequestPayload());
    } else if (bridgeMessage.type === "error") {
      const message = String(bridgeMessage.message ?? "kernel bridge error");
      if (bridgeMessage.operation === "start") failBridge(proc, message);
      else if (bridgeMessage.operation === "execute" && bridgeMessage.id) {
        const pending = pendingExecs.get(bridgeMessage.id);
        if (pending) {
          const index = pendingCellIndex(pending);
          pendingExecs.delete(bridgeMessage.id);
          if (index !== null) {
            const cell = currentCells[index];
            appendExecutionFailure(cell, message);
            cell.status = "idle";
            cell.duration_ms = cell.started_at ? Date.now() - cell.started_at : void 0;
            broadcastCell(index);
          }
        }
      } else console.error("[kernel-bridge]", message);
    } else if (bridgeMessage.type === "kernel_exit") {
      const detail = bridgeMessage.stderr ? `: ${bridgeMessage.stderr}` : "";
      failBridge(proc, `kernel process exited with code ${bridgeMessage.code}${detail}`);
    }
  });
  proc.stdout.on("error", (error) => failBridge(proc, `kernel bridge stdout failed: ${error}`));
  readLines(proc.stderr, (line) => {
    console.error("[kernel-bridge stderr]", line);
  });
  proc.stderr.on("error", () => {
  });
  proc.on("error", (error) => failBridge(proc, `failed to start kernel bridge: ${error.message}`));
  proc.on("exit", (code, signal) => {
    failBridge(proc, `kernel bridge exited (${signal ?? code ?? "unknown"})`);
  });
  writeToBridge({ cmd: "start", kernel_name: kernelName, cwd: notebookDir });
}
async function ensureKernelStarted(kernelName) {
  if (!bridgeProc) startBridge(kernelName);
  const ready = kernelReadyPromise;
  if (!ready) throw new Error("kernel bridge failed to initialize");
  await ready;
}
function cleanupBridge() {
  const proc = bridgeProc;
  kernelReadyReject?.(new Error("kernel stopped"));
  kernelReadyResolve = null;
  kernelReadyReject = null;
  bridgeProc = null;
  kernelReadyPromise = null;
  try {
    proc?.kill();
  } catch {
  }
  pendingExecs.clear();
  pendingInputRequest = null;
}
process.on("exit", cleanupBridge);
process.on("SIGINT", () => {
  cleanupBridge();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanupBridge();
  process.exit(0);
});
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
function serveAsset(res, filename, contentType) {
  res.writeHead(200, { "content-type": contentType });
  res.end(readFileSync(new URL(`./${filename}`, import.meta.url)));
}
var themeCss = buildThemeCss(process.env.IPYNB_PEEK_THEME);
function serveIndexHtml(res) {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const injected = html.replace("__IPYNB_PEEK_TOKEN__", authToken ?? "");
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
async function handleRequest(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!hasLoopbackHost(req)) return sendJson(res, 403, { ok: false, error: "invalid host header" });
  if (url.pathname === "/") return serveIndexHtml(res);
  if (url.pathname === "/style.css") return serveAsset(res, "style.css", "text/css; charset=utf-8");
  if (url.pathname === "/theme.css") {
    res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
    return res.end(themeCss);
  }
  if (url.pathname === "/katex.min.css")
    return serveAsset(res, "katex.min.css", "text/css; charset=utf-8");
  if (url.pathname.startsWith("/fonts/") && /^[a-zA-Z0-9_.-]+\.woff2$/.test(url.pathname.slice(7)))
    return serveAsset(res, url.pathname.slice(1), "font/woff2");
  if (url.pathname === "/client.js")
    return serveAsset(res, "client.js", "text/javascript; charset=utf-8");
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("ok");
  }
  if (!isAuthorized(req, url)) return sendJson(res, 401, { ok: false, error: "unauthorized" });
  if (url.pathname === "/notebook-asset" && req.method === "GET") {
    const requested = url.searchParams.get("path");
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
    const contentTypes = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml"
    };
    try {
      const contentType = contentTypes[extname(assetPath).toLowerCase()] ?? "application/octet-stream";
      res.writeHead(200, { "content-type": contentType, "x-content-type-options": "nosniff" });
      return res.end(readFileSync(assetPath));
    } catch {
      return sendJson(res, 404, { ok: false, error: "notebook asset not found" });
    }
  }
  if (url.pathname === "/render" && req.method === "POST") {
    return handleJsonRoute(res, async () => {
      const dirHeader = req.headers["x-notebook-dir"];
      if (typeof dirHeader === "string") notebookDir = dirHeader;
      const pathHeader = req.headers["x-notebook-path"];
      if (typeof pathHeader === "string") notebookPath = pathHeader;
      const raw = await readBody(req);
      const nb = JSON.parse(raw);
      notebookKernelName = nb.metadata?.kernelspec?.name ?? notebookKernelName;
      currentCells = mergeCells(currentCells, renderNotebook(nb));
      reconcileBusyStatus(currentCells, pendingExecs);
      broadcastFull();
      await persistOutputsToDisk();
    });
  }
  if (url.pathname === "/sync" && req.method === "POST") {
    return handleJsonRoute(res, async () => {
      const body = JSON.parse(await readBody(req));
      const previousCells = currentCells;
      currentCells = syncCells(currentCells, body.cells ?? []);
      reconcileBusyStatus(currentCells, pendingExecs);
      broadcastSync(previousCells);
    });
  }
  if (url.pathname === "/execute" && req.method === "POST") {
    return handleJsonRoute(res, async () => {
      const body = JSON.parse(await readBody(req));
      const index = body.index;
      const code = body.code ?? "";
      if (typeof index !== "number" || typeof code !== "string" || currentCells[index]?.cell_type !== "code")
        return { status: 400, body: { ok: false, error: "invalid cell index" } };
      await ensureKernelStarted(notebookKernelName || "python3");
      const msgId = crypto.randomUUID();
      currentCells[index].source = code;
      pendingExecs.set(msgId, { index, id: currentCells[index].id, source: code });
      currentCells[index].outputs = [];
      currentCells[index].nbformat_outputs = [];
      currentCells[index].status = "busy";
      currentCells[index].started_at = void 0;
      currentCells[index].duration_ms = void 0;
      broadcastCell(index);
      try {
        writeToBridge({ cmd: "execute", id: msgId, code, allow_stdin: wsClients.size > 0 });
      } catch (error) {
        pendingExecs.delete(msgId);
        const message = String(error instanceof Error ? error.message : error);
        appendExecutionFailure(currentCells[index], message);
        currentCells[index].status = "idle";
        broadcastCell(index);
        throw error;
      }
    });
  }
  if (url.pathname === "/restart" && req.method === "POST") {
    cleanupBridge();
    for (const cell of currentCells) {
      if (cell.status === "busy") cell.status = "idle";
    }
    broadcastFull();
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === "/input" && req.method === "POST") {
    if (!bridgeProc) return sendJson(res, 409, { ok: false, error: "no running kernel" });
    return handleJsonRoute(res, async () => {
      const body = JSON.parse(await readBody(req));
      writeToBridge({ cmd: "input_reply", value: String(body.value ?? "") });
      pendingInputRequest = null;
    });
  }
  if (url.pathname === "/interrupt" && req.method === "POST") {
    if (!bridgeProc)
      return sendJson(res, 409, { ok: false, error: "no running kernel to interrupt" });
    return handleJsonRoute(res, async () => {
      writeToBridge({ cmd: "interrupt" });
    });
  }
  if (url.pathname === "/events") {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    const send = (chunk) => {
      try {
        res.write(chunk);
      } catch {
      }
    };
    eventSubscribers.add(send);
    req.on("close", () => eventSubscribers.delete(send));
    return;
  }
  if (url.pathname === "/cursor" && req.method === "POST") {
    return handleJsonRoute(res, async () => {
      const body = JSON.parse(await readBody(req));
      broadcast(JSON.stringify({ type: "cursor", index: body.index }));
    });
  }
  res.writeHead(404);
  res.end("not found");
}
function createServer(port = Number(process.env.IPYNB_PEEK_PORT ?? 0), token = process.env.IPYNB_PEEK_TOKEN) {
  wsClients = /* @__PURE__ */ new Set();
  authToken = token;
  const httpServer = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      console.error("[ipynb-peek] unhandled request error:", error);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error?.stack ?? error) });
    });
  });
  httpServer.timeout = 0;
  httpServer.keepAliveTimeout = 0;
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws) => {
    wsClients.add(ws);
    ws.send(renderPayload());
    if (pendingInputRequest) ws.send(inputRequestPayload());
    ws.on("message", (data) => {
      try {
        const parsedMessage = JSON.parse(data.toString());
        if (parsedMessage.type === "insert_cell" && Number.isInteger(parsedMessage.after_index) && parsedMessage.after_index >= -1 && (parsedMessage.cell_type === "code" || parsedMessage.cell_type === "markdown")) {
          emitEvent({
            type: "insert_cell",
            after_index: parsedMessage.after_index,
            cell_type: parsedMessage.cell_type
          });
        } else if (parsedMessage.type === "delete_cell" && Number.isInteger(parsedMessage.index) && parsedMessage.index >= 0 && isCellDeletable(currentCells[parsedMessage.index])) {
          emitEvent({ type: "delete_cell", index: parsedMessage.index });
        }
      } catch (error) {
        console.error("[ipynb-peek] received malformed websocket message from client:", data, error);
      }
    });
    ws.on("close", () => wsClients.delete(ws));
  });
  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!hasLoopbackHost(req) || url.pathname !== "/ws" || !isAuthorized(req, url)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });
  return new Promise((resolve2, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "127.0.0.1", () => {
      httpServer.removeListener("error", reject);
      const address = httpServer.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolve2({
        port: actualPort,
        stop(force = false) {
          cleanupBridge();
          if (force) {
            for (const ws of wsClients) ws.terminate();
            httpServer.closeAllConnections();
          }
          wss.close();
          httpServer.close();
        }
      });
    });
  });
}
if (import.meta.main) {
  const server = await createServer();
  console.log(`IPYNB_PEEK_PORT=${server.port}`);
  console.log(`IPYNB_PEEK_URL=http://127.0.0.1:${server.port}/`);
}
export {
  createServer
};
