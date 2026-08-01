// src/index.ts
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { WebSocketServer, WebSocket } from "ws";

// src/notebook.ts
function joinSource(src) {
  if (!src) return "";
  return Array.isArray(src) ? src.join("") : src;
}
function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}
function renderOutput(output) {
  const data = output.data ?? {};
  if (data["image/png"]) return { kind: "image", data: joinSource(data["image/png"]) };
  if (data["text/html"]) return { kind: "html", content: joinSource(data["text/html"]) };
  if (data["text/latex"]) return { kind: "latex", content: joinSource(data["text/latex"]) };
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
    last.content += newOutput.content;
    return;
  }
  outputs.push(newOutput);
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
      cell_type: cell.cell_type,
      source,
      language: cell.cell_type === "code" ? language : void 0,
      execution_count: cell.cell_type === "code" ? cell.execution_count ?? null : void 0,
      outputs
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
  return live.map((liveCell, index) => {
    const prevCell = previous[index];
    if (prevCell) {
      return {
        ...prevCell,
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
      outputs: []
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
    case "image":
      return { output_type: "display_data", data: { "image/png": output.data }, metadata: {} };
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
  for (const cell of currentCells2) {
    if (cell.cell_type !== "code") continue;
    if (cell.status === "busy") continue;
    if (cell.outputs.length === 0 && cell.execution_count == null) continue;
    const nbCell = nbCells.find(
      (candidate) => candidate.cell_type === "code" && joinSource(candidate.source) === cell.source
    );
    if (!nbCell) continue;
    nbCell.outputs = cell.outputs.map(toNbformatOutput);
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
}
function applyResultMessage(cell, content, msgType) {
  const data = content.data ?? {};
  if (data["image/png"]) cell.outputs.push({ kind: "image", data: joinSource(data["image/png"]) });
  else if (data["text/html"])
    cell.outputs.push({ kind: "html", content: joinSource(data["text/html"]) });
  else if (data["text/latex"])
    cell.outputs.push({ kind: "latex", content: joinSource(data["text/latex"]) });
  else if (data["application/json"] !== void 0)
    cell.outputs.push({ kind: "text", content: JSON.stringify(data["application/json"], null, 2) });
  else if (data["text/plain"])
    cell.outputs.push({ kind: "text", content: joinSource(data["text/plain"]) });
  if (msgType === "execute_result" && typeof content.execution_count === "number")
    cell.execution_count = content.execution_count;
}
function applyErrorMessage(cell, content) {
  const traceback = Array.isArray(content.traceback) ? content.traceback.join("\n") : `${content.ename}: ${content.evalue}`;
  cell.outputs.push({ kind: "error", content: stripAnsi(traceback) });
}
function applyClearOutputMessage(cell) {
  cell.outputs = [];
}
function resolveCellIndex(currentCells2, pending) {
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
import { writeFile, rename } from "node:fs/promises";
var writeQueues = /* @__PURE__ */ new Map();
function writeNotebookFile(path, notebookJson) {
  const queued = (writeQueues.get(path) ?? Promise.resolve()).catch(() => {
  }).then(async () => {
    const tmpPath = `${path}.ipynb-peek.tmp`;
    await writeFile(tmpPath, JSON.stringify(notebookJson, null, 1), "utf8");
    await rename(tmpPath, path);
  });
  writeQueues.set(path, queued);
  queued.finally(() => {
    if (writeQueues.get(path) === queued) writeQueues.delete(path);
  });
  return queued;
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

// src/index.ts
var currentCells = [];
var currentNotebookJson = null;
var notebookKernelName;
var notebookDir;
var notebookPath;
var wsClients = /* @__PURE__ */ new Set();
var authToken;
function isAuthorized(req, url) {
  if (!authToken) return true;
  const header = req.headers["x-ipynb-peek-token"];
  if (typeof header === "string" && header === authToken) return true;
  return url.searchParams.get("token") === authToken;
}
function renderPayload() {
  return JSON.stringify({ type: "render", cells: currentCells });
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
  broadcast(JSON.stringify({ type: "cell_update", index, cell: currentCells[index] }));
  emitEvent({ type: "cell_status", ...cellStatusInfo(currentCells[index], index) });
}
async function persistOutputsToDisk() {
  if (!notebookPath || !currentNotebookJson) return;
  try {
    patchNotebookOutputs(currentNotebookJson, currentCells);
    await writeNotebookFile(notebookPath, currentNotebookJson);
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
var pendingExecs = /* @__PURE__ */ new Map();
function readLines(stream, onLine) {
  const rl = readline.createInterface({ input: stream });
  rl.on("line", (line) => {
    if (line.trim()) onLine(line);
  });
}
function writeToBridge(obj) {
  bridgeProc?.stdin?.write(JSON.stringify(obj) + "\n");
}
function startBridge(kernelName) {
  if (bridgeProc) return;
  kernelReadyPromise = new Promise((resolve) => {
    kernelReadyResolve = resolve;
  });
  const bridgePath = fileURLToPath(new URL("./kernel-bridge.mjs", import.meta.url));
  bridgeProc = spawn("node", [bridgePath]);
  readLines(bridgeProc.stdout, (line) => {
    let bridgeMessage;
    try {
      bridgeMessage = JSON.parse(line);
    } catch (error) {
      console.error("[kernel-bridge] received malformed line on stdout:", line, error);
      return;
    }
    if (bridgeMessage.type === "ready") kernelReadyResolve?.();
    else if (bridgeMessage.type === "iopub")
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
    else if (bridgeMessage.type === "error") console.error("[kernel-bridge]", bridgeMessage.message);
    else if (bridgeMessage.type === "kernel_exit")
      console.error("[kernel-bridge] kernel process exited with code", bridgeMessage.code);
  });
  bridgeProc.stdout.on(
    "error",
    (error) => console.error("[kernel-bridge] stdout reader failed:", error)
  );
  readLines(bridgeProc.stderr, (line) => {
    console.error("[kernel-bridge stderr]", line);
  });
  bridgeProc.stderr.on("error", () => {
  });
  writeToBridge({ cmd: "start", kernel_name: kernelName, cwd: notebookDir });
}
async function ensureKernelStarted(kernelName) {
  if (!bridgeProc) startBridge(kernelName);
  await kernelReadyPromise;
}
function cleanupBridge() {
  try {
    bridgeProc?.kill();
  } catch {
  }
  bridgeProc = null;
  kernelReadyPromise = null;
  kernelReadyResolve = null;
  pendingExecs.clear();
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
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => resolve(body));
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
  const injected = html.replace(
    "</head>",
    `<style>${themeCss}</style>
<script>window.__IPYNB_PEEK_TOKEN__=${JSON.stringify(authToken ?? "")}</script>
</head>`
  );
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(injected);
}
async function handleRequest(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/") return serveIndexHtml(res);
  if (url.pathname === "/style.css") return serveAsset(res, "style.css", "text/css; charset=utf-8");
  if (url.pathname === "/client.js")
    return serveAsset(res, "client.js", "text/javascript; charset=utf-8");
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("ok");
  }
  if (!isAuthorized(req, url)) return sendJson(res, 401, { ok: false, error: "unauthorized" });
  if (url.pathname === "/render" && req.method === "POST") {
    return handleJsonRoute(res, async () => {
      const dirHeader = req.headers["x-notebook-dir"];
      if (typeof dirHeader === "string") notebookDir = dirHeader;
      const pathHeader = req.headers["x-notebook-path"];
      if (typeof pathHeader === "string") notebookPath = pathHeader;
      const raw = await readBody(req);
      const nb = JSON.parse(raw);
      notebookKernelName = nb.metadata?.kernelspec?.name ?? notebookKernelName;
      currentNotebookJson = nb;
      currentCells = mergeCells(currentCells, renderNotebook(nb));
      reconcileBusyStatus(currentCells, pendingExecs);
      broadcastFull();
    });
  }
  if (url.pathname === "/sync" && req.method === "POST") {
    return handleJsonRoute(res, async () => {
      const body = JSON.parse(await readBody(req));
      currentCells = syncCells(currentCells, body.cells ?? []);
      reconcileBusyStatus(currentCells, pendingExecs);
      broadcastFull();
    });
  }
  if (url.pathname === "/execute" && req.method === "POST") {
    return handleJsonRoute(res, async () => {
      const body = JSON.parse(await readBody(req));
      const index = body.index;
      const code = body.code ?? "";
      if (typeof index !== "number" || !currentCells[index])
        return { status: 400, body: { ok: false, error: "invalid cell index" } };
      await ensureKernelStarted(notebookKernelName || "python3");
      const msgId = crypto.randomUUID();
      pendingExecs.set(msgId, { index, source: currentCells[index].source });
      currentCells[index].outputs = [];
      currentCells[index].status = "busy";
      currentCells[index].started_at = Date.now();
      currentCells[index].duration_ms = void 0;
      broadcastCell(index);
      writeToBridge({ cmd: "execute", id: msgId, code });
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
  if (url.pathname === "/interrupt" && req.method === "POST") {
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
    ws.on("message", (data) => {
      try {
        const parsedMessage = JSON.parse(data.toString());
        if (parsedMessage.type === "insert_cell") {
          emitEvent({
            type: "insert_cell",
            after_index: parsedMessage.after_index,
            cell_type: parsedMessage.cell_type
          });
        } else if (parsedMessage.type === "delete_cell") {
          emitEvent({ type: "delete_cell", index: parsedMessage.index });
        }
      } catch (error) {
        console.error(
          "[ipynb-peek] received malformed websocket message from client:",
          data,
          error
        );
      }
    });
    ws.on("close", () => wsClients.delete(ws));
  });
  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws" || !isAuthorized(req, url)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });
  return new Promise((resolve) => {
    httpServer.listen(port, "127.0.0.1", () => {
      const address = httpServer.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolve({
        port: actualPort,
        stop(force = false) {
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
