#!/usr/bin/env python3
"""Featherweight stdlib ThreadingHTTPServer + SSE + jupyter_client backend."""

from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
import queue
import re
import secrets
import signal
import sys
import threading
import time
from typing import Any
import urllib.parse

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import dag
import render

MAX_POST_BYTES = 1_048_576
_SAFE_FILENAME_RE = re.compile(r"[^A-Za-z0-9._-]")

INSPECT_VARS_CODE = r"""
def __ipynb_peek_inspect():
    import json as _j, sys as _s, types as _t
    rows = []
    skip = ("In", "Out", "get_ipython", "exit", "quit", "open")
    for _k, _v in list(globals().items()):
        if _k.startswith("_") or _k in skip:
            continue
        if isinstance(_v, (_t.ModuleType, _t.FunctionType, _t.BuiltinFunctionType, type)):
            continue
        _shape = ""
        if hasattr(_v, "shape"):
            try:
                _shape = str(getattr(_v, "shape"))
            except Exception:
                pass
        elif isinstance(_v, (list, tuple, dict, set, frozenset, str, bytes)):
            _shape = f"len={len(_v)}"
        _size = None
        try:
            if hasattr(_v, "memory_usage"):
                _m = _v.memory_usage(deep=True)
                _size = int(_m.sum() if hasattr(_m, "sum") else _m)
            elif hasattr(_v, "nbytes"):
                _size = int(_v.nbytes)
            else:
                _size = int(_s.getsizeof(_v))
        except Exception:
            pass
        try:
            _prev = repr(_v).replace("\n", " ")[:120]
        except Exception:
            _prev = "<unprintable>"
        rows.append({
            "name": _k, "type": type(_v).__name__, "shape": _shape,
            "size_bytes": _size, "preview": _prev,
        })
    rows.sort(key=lambda r: r["name"])
    print("__IPYNB_PEEK_VARS__" + _j.dumps(rows))
__ipynb_peek_inspect()
del __ipynb_peek_inspect
"""


def _safe_int(val: Any, default: int | None = None) -> int | None:
    if isinstance(val, bool) or val is None:
        return default
    try:
        return int(val)
    except (TypeError, ValueError):
        return default


def _normalize_src(raw: Any) -> str:
    if isinstance(raw, list):
        return "".join(str(x) for x in raw)
    return str(raw) if isinstance(raw, str) else ""


def _make_cell(
    index: int,
    cell_type: str = "code",
    source: str = "",
    *,
    execution_count: int | None = None,
    outputs: list[dict[str, Any]] | None = None,
    status: str = "idle",
    duration_ms: int | None = None,
    has_error: bool = False,
) -> dict[str, Any]:
    return {
        "index": index,
        "cell_type": cell_type,
        "source": source,
        "execution_count": execution_count,
        "outputs": list(outputs) if (cell_type == "code" and outputs) else [],
        "status": status,
        "duration_ms": duration_ms,
        "has_error": has_error,
    }


def _reconcile_cells(
    old_cells: list[dict[str, Any]],
    live_cells: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[int, int]]:
    """Two-pass reconciliation matching exact (cell_type, source) then position.

    Returns (new_cells, old_to_new_index_map).
    """
    parsed: list[tuple[str, str]] = [
        (str(c.get("cell_type", "code")), _normalize_src(c.get("source", "")))
        for c in live_cells
    ]
    matched_old: dict[int, int] = {}
    used_old: set[int] = set()

    # Pass 1a: exact (cell_type, source) match at same index
    for new_idx, (ctype, src) in enumerate(parsed):
        if new_idx < len(old_cells):
            prev = old_cells[new_idx]
            if prev["cell_type"] == ctype and prev["source"] == src:
                matched_old[new_idx] = new_idx
                used_old.add(new_idx)

    # Pass 1b: exact (cell_type, source) match at any unused index
    for new_idx, (ctype, src) in enumerate(parsed):
        if new_idx in matched_old:
            continue
        for old_idx, prev in enumerate(old_cells):
            if old_idx not in used_old and prev["cell_type"] == ctype and prev["source"] == src:
                matched_old[new_idx] = old_idx
                used_old.add(old_idx)
                break

    # Pass 2: positional fallback for edited-in-place cells of matching type
    for new_idx, (ctype, _src) in enumerate(parsed):
        if new_idx in matched_old or new_idx >= len(old_cells) or new_idx in used_old:
            continue
        if old_cells[new_idx]["cell_type"] == ctype:
            matched_old[new_idx] = new_idx
            used_old.add(new_idx)

    new_cells: list[dict[str, Any]] = []
    old_to_new: dict[int, int] = {}
    for new_idx, (ctype, src) in enumerate(parsed):
        old_idx = matched_old.get(new_idx)
        if old_idx is not None:
            prev = old_cells[old_idx]
            old_to_new[old_idx] = new_idx
            new_cells.append(
                _make_cell(
                    new_idx,
                    ctype,
                    src,
                    execution_count=prev["execution_count"],
                    outputs=prev["outputs"],
                    status=prev["status"],
                    duration_ms=prev["duration_ms"],
                    has_error=prev["has_error"],
                )
            )
        else:
            new_cells.append(_make_cell(new_idx, ctype, src))

    return new_cells, old_to_new


def sanitize_filename(name: str) -> str:
    cleaned = _SAFE_FILENAME_RE.sub("_", name).strip("._")
    return cleaned or "notebook"


class NotebookSession:
    """Thread-safe state for the single active notebook preview & kernel."""

    def __init__(self, emit_fn=None) -> None:
        self.lock = threading.RLock()
        self._kernel_start_lock = threading.Lock()
        self.token: str = secrets.token_urlsafe(24)
        self.port: int = 0
        self.title: str = "Notebook"
        self.notebook_dir: str = os.getcwd()
        self.notebook_path: str | None = None
        self.kernel_name: str = "python3"
        self.active_index: int | None = None

        self.cells: list[dict[str, Any]] = []
        self.analysis: list[dict[str, Any]] = []
        self.exec_state: dict[int, dict[str, Any]] = {}
        self.stale_map: dict[int, dict[str, Any]] = {}
        self.exec_count_to_cell: dict[int, int] = {}

        self._sse_clients: set[queue.Queue] = set()
        self._sse_lock = threading.Lock()

        self._km: Any = None
        self._kc: Any = None
        self._kernel_stop = threading.Event()
        self._iopub_thread: threading.Thread | None = None
        self._stdin_thread: threading.Thread | None = None
        self._running_msgs: dict[str, dict[str, Any]] = {}
        self._pending_clear: set[int] = set()
        self._inspect_waiters: dict[str, tuple[threading.Event, list[str]]] = {}

        self._emit_fn = emit_fn or self._default_emit
        self._stdout_lock = threading.Lock()
        self.shutdown_event = threading.Event()

    def _default_emit(self, obj: dict[str, Any]) -> None:
        line = json.dumps(obj, ensure_ascii=False)
        with self._stdout_lock:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    def emit(self, obj: dict[str, Any]) -> None:
        self._emit_fn(obj)

    # --- SSE pub/sub ---

    def add_sse_client(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=256)
        with self._sse_lock:
            self._sse_clients.add(q)
        return q

    def remove_sse_client(self, q: queue.Queue) -> None:
        with self._sse_lock:
            self._sse_clients.discard(q)

    def broadcast_sse(self, event: str, data: str) -> None:
        with self._sse_lock:
            clients = list(self._sse_clients)
        for q in clients:
            try:
                q.put_nowait((event, data))
            except queue.Full:
                pass

    def render_notebook_html(self) -> str:
        with self.lock:
            frags = [
                render.render_cell_html(
                    {**cell, "index": idx},
                    self.stale_map.get(idx),
                    token=self.token,
                    active=(self.active_index == idx),
                )
                for idx, cell in enumerate(self.cells)
            ]
            return "\n".join(frags)

    def render_page(self, *, report: bool = False, export: bool = False) -> str:
        with self.lock:
            return render.render_document(
                self.cells,
                self.stale_map,
                self.title,
                report=report,
                export=export,
                token=self.token,
                active_index=self.active_index,
            )

    def _broadcast_cell(self, idx: int) -> None:
        with self.lock:
            if not (0 <= idx < len(self.cells)):
                return
            frag = render.render_cell_html(
                {**self.cells[idx], "index": idx},
                self.stale_map.get(idx),
                token=self.token,
                active=(self.active_index == idx),
            )
        self.broadcast_sse("cell", json.dumps({"index": idx, "html": frag}))

    def _recompute_dag(self) -> set[int]:
        old_stale = dict(self.stale_map)
        self.analysis = dag.analyze(self.cells)
        self.stale_map = dag.compute_stale(self.analysis, self.exec_state)
        all_keys = set(old_stale.keys()) | set(self.stale_map.keys())
        return {k for k in all_keys if old_stale.get(k) != self.stale_map.get(k)}

    def _emit_dag_status(self) -> None:
        with self.lock:
            stale_payload = {str(k): v for k, v in self.stale_map.items()}
        self.emit({"type": "dag_status", "stale": stale_payload})

    def _cell_status_payload(self, idx: int) -> dict[str, Any]:
        c = self.cells[idx]
        return {
            "index": idx,
            "status": c.get("status", "idle"),
            "execution_count": c.get("execution_count"),
            "duration_ms": c.get("duration_ms"),
            "has_error": bool(c.get("has_error", False)),
        }

    def _emit_all_statuses(self) -> None:
        with self.lock:
            items = [self._cell_status_payload(i) for i in range(len(self.cells))]
        self.emit({"type": "cells_status", "cells": items})

    def _emit_kernel_status(self) -> None:
        with self.lock:
            running = self._km is not None and self._km.is_alive()
            name = self.kernel_name
        self.emit({"type": "kernel", "name": name, "running": running})

    # --- Notebook commands ---

    def _load_render_cells(self, raw_cells: list[Any]) -> None:
        new_cells: list[dict[str, Any]] = []
        new_exec: dict[int, dict[str, Any]] = {}
        self.exec_count_to_cell.clear()

        for idx, raw in enumerate(raw_cells):
            if not isinstance(raw, dict):
                continue
            src = _normalize_src(raw.get("source", ""))
            ctype = str(raw.get("cell_type", "code"))
            outputs = raw.get("outputs") if isinstance(raw.get("outputs"), list) else []
            ec = _safe_int(raw.get("execution_count"))
            has_err = any(
                isinstance(o, dict) and o.get("output_type") == "error" for o in outputs
            )
            new_cells.append(
                _make_cell(idx, ctype, src, execution_count=ec, outputs=outputs, has_error=has_err)
            )
            if ctype == "code" and ec is not None:
                self.exec_count_to_cell[ec] = idx
                prev = self.exec_state.get(idx)
                same_ec = prev is not None and prev.get("execution_count") == ec
                ex_hash = prev.get("executed_hash") if same_ec else dag.hash_source(src)
                new_exec[idx] = {
                    "executed_hash": ex_hash or dag.hash_source(src),
                    "execution_count": ec,
                    "has_error": has_err,
                }

        self.cells = new_cells
        self.exec_state = new_exec
        self._recompute_dag()

    def cmd_render(self, msg: dict[str, Any]) -> dict[str, Any]:
        raw_nb = msg.get("notebook")
        nb_cells = msg.get("cells")
        if raw_nb is not None:
            nb = json.loads(raw_nb) if isinstance(raw_nb, str) else raw_nb
            if not isinstance(nb, dict):
                return {"ok": False, "error": "notebook must be a JSON object"}
            nb_cells = nb.get("cells", [])
            meta = nb.get("metadata") if isinstance(nb.get("metadata"), dict) else {}
            ks = meta.get("kernelspec") if isinstance(meta.get("kernelspec"), dict) else {}
            if isinstance(ks.get("name"), str) and ks["name"]:
                self.kernel_name = ks["name"]
        if isinstance(msg.get("kernel_name"), str) and msg["kernel_name"]:
            self.kernel_name = msg["kernel_name"]
        if not isinstance(nb_cells, list):
            return {"ok": False, "error": "cells must be a list"}

        path = msg.get("path")
        nb_dir = msg.get("dir")
        with self.lock:
            if isinstance(path, str) and path:
                self.notebook_path = path
                self.title = os.path.basename(path)
                nb_dir = nb_dir or os.path.dirname(path)
            if isinstance(nb_dir, str) and nb_dir:
                self.notebook_dir = os.path.abspath(nb_dir)
            self._load_render_cells(nb_cells)

        self._emit_kernel_status()
        self._emit_all_statuses()
        self._emit_dag_status()
        self.broadcast_sse("full", self.render_notebook_html())
        return {"ok": True}

    def cmd_sync(self, msg: dict[str, Any]) -> dict[str, Any]:
        live_cells = msg.get("cells")
        if not isinstance(live_cells, list):
            return {"ok": False, "error": "cells must be a list"}
        valid_cells = [c for c in live_cells if isinstance(c, dict)]

        with self.lock:
            new_cells, old_to_new = _reconcile_cells(self.cells, valid_cells)
            new_exec = {
                old_to_new[old_idx]: state
                for old_idx, state in self.exec_state.items()
                if old_idx in old_to_new
            }
            self.cells = new_cells
            self.exec_state = new_exec
            self.exec_count_to_cell = {
                int(c["execution_count"]): idx
                for idx, c in enumerate(new_cells)
                if c.get("execution_count") is not None
            }
            self._remap_running_indices(old_to_new)
            self._recompute_dag()

        self._emit_dag_status()
        self._emit_all_statuses()
        self.broadcast_sse("full", self.render_notebook_html())
        return {"ok": True}

    def _remap_running_indices(self, old_to_new: dict[int, int]) -> None:
        remapped_msgs: dict[str, dict[str, Any]] = {}
        for mid, info in self._running_msgs.items():
            old_idx = info["index"]
            if old_idx in old_to_new:
                info["index"] = old_to_new[old_idx]
                remapped_msgs[mid] = info
        self._running_msgs = remapped_msgs
        self._pending_clear = {old_to_new[i] for i in self._pending_clear if i in old_to_new}

    def cmd_cursor(self, msg: dict[str, Any]) -> dict[str, Any]:
        idx = _safe_int(msg.get("index"))
        if idx is not None:
            with self.lock:
                self.active_index = idx
            self.broadcast_sse("cursor", json.dumps({"index": idx}))
        return {"ok": True}

    def cmd_dag_query(self, msg: dict[str, Any]) -> dict[str, Any]:
        kind = msg.get("kind")
        idx = _safe_int(msg.get("index"))
        with self.lock:
            if kind == "affected":
                if idx is None:
                    return {"ok": False, "error": "index required"}
                return {"ok": True, "indices": dag.affected_slice(self.analysis, idx)}
            if kind == "upstream":
                if idx is None:
                    return {"ok": False, "error": "index required"}
                return {"ok": True, "indices": dag.upstream_slice(self.analysis, idx)}
            if kind == "deps":
                if idx is None or not (0 <= idx < len(self.analysis)):
                    return {"ok": False, "error": "invalid cell index"}
                entry = self.analysis[idx]
                return {
                    "ok": True,
                    "index": idx,
                    "defs": entry["defs"],
                    "reads": entry["reads"],
                    "mutations": entry["mutations"],
                    "upstream": {str(k): v for k, v in entry["upstream"].items()},
                    "downstream": {str(k): v for k, v in entry["downstream"].items()},
                    "late_defs": entry["late_defs"],
                    "redefinitions": entry["redefinitions"],
                    "stale": self.stale_map.get(idx),
                }
            if kind == "audit":
                return {"ok": True, "issues": dag.audit(self.analysis, self.exec_state)}
        return {"ok": False, "error": f"unknown dag_query kind: {kind}"}

    def cmd_export(self, msg: dict[str, Any]) -> dict[str, Any]:
        report = msg.get("mode", "html") == "report"
        out_path = msg.get("path")
        if not isinstance(out_path, str) or not out_path:
            if self.notebook_path:
                stem, _ = os.path.splitext(self.notebook_path)
                out_path = stem + (".report.html" if report else ".html")
            else:
                out_path = os.path.join(self.notebook_dir, "notebook.html")
        html_doc = self.render_page(report=report, export=True)
        with open(out_path, "w", encoding="utf-8") as fh:
            fh.write(html_doc)
        return {"ok": True, "path": out_path}

    def cmd_print(self, _msg: dict[str, Any]) -> dict[str, Any]:
        self.broadcast_sse("print", "{}")
        return {"ok": True}

    # --- Kernel lifecycle ---

    def _ensure_kernel(self) -> None:
        with self.lock:
            if self._km is not None and self._km.is_alive() and self._kc is not None:
                return

        with self._kernel_start_lock:
            with self.lock:
                if self._km is not None and self._km.is_alive() and self._kc is not None:
                    return
                kernel_name = self.kernel_name
                notebook_dir = self.notebook_dir

            try:
                from jupyter_client import KernelManager
            except ImportError as exc:
                raise RuntimeError(
                    "jupyter_client is not installed in this Python environment"
                ) from exc

            km = KernelManager(kernel_name=kernel_name)
            km.start_kernel(cwd=notebook_dir)
            kc = km.client()
            kc.start_channels()
            kc.wait_for_ready(timeout=30)

            with self.lock:
                self._km = km
                self._kc = kc
                self._kernel_stop.clear()
                self._iopub_thread = threading.Thread(
                    target=self._iopub_loop, name="ipynb-iopub", daemon=True
                )
                self._stdin_thread = threading.Thread(
                    target=self._stdin_loop, name="ipynb-stdin", daemon=True
                )
                self._iopub_thread.start()
                self._stdin_thread.start()
        self._emit_kernel_status()

    def _stop_kernel(self) -> None:
        self._kernel_stop.set()
        with self.lock:
            kc, km = self._kc, self._km
            self._kc = self._km = None
            self._running_msgs.clear()
            self._pending_clear.clear()
            waiters = list(self._inspect_waiters.values())
            self._inspect_waiters.clear()
        for evt, _chunks in waiters:
            evt.set()
        if kc is not None:
            try:
                kc.stop_channels()
            except Exception:
                pass
        if km is not None:
            try:
                km.shutdown_kernel(now=True)
            except Exception:
                pass
        self._emit_kernel_status()

    def _handle_kernel_death(self) -> None:
        """Fail all in-flight executions if the kernel crashes/OOMs mid-run."""
        with self.lock:
            running = list(self._running_msgs.values())
            self._running_msgs.clear()
            self._pending_clear.clear()
            waiters = list(self._inspect_waiters.values())
            self._inspect_waiters.clear()
            kc = self._kc
            self._kc = self._km = None
            errored_indices: list[int] = []
            for info in running:
                idx = info["index"]
                if not (0 <= idx < len(self.cells)):
                    continue
                cell = self.cells[idx]
                cell["status"] = "idle"
                cell["has_error"] = True
                cell["outputs"].append(
                    {
                        "output_type": "error",
                        "ename": "KernelDied",
                        "evalue": "Jupyter kernel exited unexpectedly",
                        "traceback": ["KernelDied: Jupyter kernel exited unexpectedly"],
                    }
                )
                errored_indices.append(idx)

        for evt, _chunks in waiters:
            evt.set()
        if kc is not None:
            try:
                kc.stop_channels()
            except Exception:
                pass

        for idx in errored_indices:
            with self.lock:
                cell = self.cells[idx]
                outputs_copy = list(cell["outputs"])
                ec = cell.get("execution_count")
                status_payload = self._cell_status_payload(idx)
            self.emit(
                {
                    "type": "cell_outputs",
                    "index": idx,
                    "execution_count": ec,
                    "outputs": outputs_copy,
                }
            )
            self.emit({"type": "cell_status", **status_payload})
            self._broadcast_cell(idx)
        self._emit_kernel_status()

    def _iopub_loop(self) -> None:
        while not self._kernel_stop.is_set():
            kc, km = self._kc, self._km
            if kc is None:
                break
            try:
                msg = kc.get_iopub_msg(timeout=0.25)
            except queue.Empty:
                if km is not None and not km.is_alive():
                    self._handle_kernel_death()
                    break
                continue
            except Exception:
                if self._kernel_stop.is_set():
                    break
                if km is not None and not km.is_alive():
                    self._handle_kernel_death()
                    break
                time.sleep(0.05)
                continue
            self._handle_iopub_msg(msg)

    def _stdin_loop(self) -> None:
        while not self._kernel_stop.is_set():
            kc = self._kc
            if kc is None:
                break
            try:
                msg = kc.get_stdin_msg(timeout=0.25)
            except queue.Empty:
                continue
            except Exception:
                if self._kernel_stop.is_set():
                    break
                time.sleep(0.05)
                continue
            if msg.get("msg_type") == "input_request":
                content = msg.get("content") or {}
                self.broadcast_sse(
                    "stdin",
                    json.dumps(
                        {
                            "prompt": str(content.get("prompt", "")),
                            "password": bool(content.get("password", False)),
                        }
                    ),
                )

    def _flush_pending_clear(self, idx: int) -> None:
        if idx in self._pending_clear:
            self.cells[idx]["outputs"] = []
            self._pending_clear.discard(idx)

    def _on_iopub_status(
        self, parent_id: str, run_info: dict[str, Any], content: dict[str, Any]
    ) -> None:
        idx = run_info["index"]
        cell = self.cells[idx]
        state = content.get("execution_state")
        if state == "busy":
            cell["status"] = "busy"
            cell["has_error"] = False
            cell["outputs"] = []
            cell["duration_ms"] = None
            self.emit({"type": "cell_status", **self._cell_status_payload(idx)})
            self._broadcast_cell(idx)
            return
        if state != "idle":
            return

        cell["status"] = "idle"
        cell["duration_ms"] = int((time.monotonic() - run_info["start_time"]) * 1000)
        self._running_msgs.pop(parent_id, None)
        self._pending_clear.discard(idx)
        ec = cell.get("execution_count")
        if ec is not None:
            self.exec_count_to_cell[int(ec)] = idx
        self.exec_state[idx] = {
            "executed_hash": run_info["code_hash"],
            "execution_count": ec,
            "has_error": bool(cell.get("has_error", False)),
        }
        changed_stale = self._recompute_dag()
        outputs_copy = list(cell["outputs"])
        status_payload = self._cell_status_payload(idx)
        self.emit(
            {"type": "cell_outputs", "index": idx, "execution_count": ec, "outputs": outputs_copy}
        )
        self.emit({"type": "cell_status", **status_payload})
        self._emit_dag_status()
        for cidx in changed_stale | {idx}:
            self._broadcast_cell(cidx)

    def _on_iopub_stream(self, idx: int, content: dict[str, Any]) -> None:
        self._flush_pending_clear(idx)
        name = content.get("name", "stdout")
        text = str(content.get("text", ""))
        outputs = self.cells[idx]["outputs"]
        same_stream = (
            bool(outputs)
            and outputs[-1].get("output_type") == "stream"
            and outputs[-1].get("name") == name
        )
        if same_stream:
            outputs[-1]["text"] += text
        else:
            outputs.append({"output_type": "stream", "name": name, "text": text})
        self._broadcast_cell(idx)

    def _on_iopub_rich(self, idx: int, msg_type: str, content: dict[str, Any]) -> None:
        self._flush_pending_clear(idx)
        entry: dict[str, Any] = {
            "output_type": msg_type,
            "data": content.get("data") or {},
            "metadata": content.get("metadata") or {},
        }
        if msg_type == "execute_result":
            entry["execution_count"] = content.get("execution_count")
        self.cells[idx]["outputs"].append(entry)
        self._broadcast_cell(idx)

    def _on_iopub_error(self, idx: int, content: dict[str, Any]) -> None:
        self._flush_pending_clear(idx)
        self.cells[idx]["has_error"] = True
        self.cells[idx]["outputs"].append(
            {
                "output_type": "error",
                "ename": content.get("ename", "Error"),
                "evalue": content.get("evalue", ""),
                "traceback": content.get("traceback") or [],
            }
        )
        self._broadcast_cell(idx)

    def _handle_iopub_msg(self, msg: dict[str, Any]) -> None:
        parent_id = (msg.get("parent_header") or {}).get("msg_id")
        if not parent_id:
            return
        msg_type = msg.get("msg_type", "")
        content = msg.get("content") or {}

        with self.lock:
            inspect_entry = self._inspect_waiters.get(parent_id)
        if inspect_entry is not None:
            evt, chunks = inspect_entry
            if msg_type == "stream" and content.get("name") == "stdout":
                chunks.append(str(content.get("text", "")))
            elif msg_type == "status" and content.get("execution_state") == "idle":
                evt.set()
            return

        with self.lock:
            run_info = self._running_msgs.get(parent_id)
            if run_info is None:
                return
            idx = run_info["index"]
            if not (0 <= idx < len(self.cells)):
                return
            if msg_type == "status":
                self._on_iopub_status(parent_id, run_info, content)
            elif msg_type == "execute_input":
                ec = _safe_int(content.get("execution_count"))
                if ec is not None:
                    self.cells[idx]["execution_count"] = ec
                    self.exec_count_to_cell[ec] = idx
                self._broadcast_cell(idx)
            elif msg_type == "clear_output":
                if content.get("wait"):
                    self._pending_clear.add(idx)
                else:
                    self.cells[idx]["outputs"] = []
                    self._broadcast_cell(idx)
            elif msg_type == "stream":
                self._on_iopub_stream(idx, content)
            elif msg_type in ("execute_result", "display_data"):
                self._on_iopub_rich(idx, msg_type, content)
            elif msg_type == "error":
                self._on_iopub_error(idx, content)

    def cmd_execute(self, msg: dict[str, Any]) -> dict[str, Any]:
        idx = _safe_int(msg.get("index"))
        if idx is None or idx < 0:
            return {"ok": False, "error": "index must be a non-negative integer"}
        code = _normalize_src(msg.get("code", ""))
        try:
            self._ensure_kernel()
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

        with self.lock:
            while len(self.cells) <= idx:
                self.cells.append(_make_cell(len(self.cells)))
            self.cells[idx]["source"] = code
            self.cells[idx]["status"] = "busy"
            self.cells[idx]["has_error"] = False
            self.cells[idx]["outputs"] = []
            msg_id = self._kc.execute(code, allow_stdin=True)
            self._running_msgs[msg_id] = {
                "index": idx,
                "code_hash": dag.hash_source(code),
                "start_time": time.monotonic(),
            }
            status_payload = self._cell_status_payload(idx)
        self.emit({"type": "cell_status", **status_payload})
        self._broadcast_cell(idx)
        return {"ok": True}

    def cmd_interrupt(self, _msg: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            km = self._km
        if km is None or not km.is_alive():
            return {"ok": False, "error": "kernel is not running"}
        try:
            km.interrupt_kernel()
            return {"ok": True}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def cmd_restart(self, _msg: dict[str, Any]) -> dict[str, Any]:
        self._stop_kernel()
        with self.lock:
            self.exec_state.clear()
            self.exec_count_to_cell.clear()
            for cell in self.cells:
                cell["status"] = "idle"
                cell["execution_count"] = None
                cell["duration_ms"] = None
                cell["has_error"] = False
            self._recompute_dag()
        self._emit_all_statuses()
        self._emit_dag_status()
        self.broadcast_sse("full", self.render_notebook_html())
        return {"ok": True}

    def cmd_kernels(self, _msg: dict[str, Any]) -> dict[str, Any]:
        try:
            from jupyter_client.kernelspec import KernelSpecManager

            specs = KernelSpecManager().get_all_specs()
            kernels = [
                {"name": name, "display_name": (info.get("spec") or {}).get("display_name", name)}
                for name, info in sorted(specs.items())
            ]
            return {"ok": True, "current": self.kernel_name, "kernels": kernels}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def cmd_select_kernel(self, msg: dict[str, Any]) -> dict[str, Any]:
        name = msg.get("name")
        if not isinstance(name, str) or not name:
            return {"ok": False, "error": "kernel name required"}
        with self.lock:
            self.kernel_name = name
        self.cmd_restart({})
        return {"ok": True, "name": name}

    def cmd_input(self, msg: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            kc = self._kc
        if kc is None:
            return {"ok": False, "error": "kernel is not running"}
        try:
            kc.input(str(msg.get("value", "")))
            return {"ok": True}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def cmd_variables(self, _msg: dict[str, Any]) -> dict[str, Any]:
        evt = threading.Event()
        chunks: list[str] = []
        with self.lock:
            if self._km is None or not self._km.is_alive() or self._kc is None:
                return {"ok": True, "variables": []}
            # Execute + register waiter atomically under self.lock so _iopub_loop
            # can never miss a fast reply; silent=True avoids bumping In[N].
            msg_id = self._kc.execute(
                INSPECT_VARS_CODE, silent=True, store_history=False, allow_stdin=False
            )
            self._inspect_waiters[msg_id] = (evt, chunks)
        try:
            evt.wait(timeout=10.0)
        finally:
            with self.lock:
                self._inspect_waiters.pop(msg_id, None)

        output = "".join(chunks)
        marker = "__IPYNB_PEEK_VARS__"
        pos = output.rfind(marker)
        if pos == -1:
            return {"ok": True, "variables": []}
        try:
            rows = json.loads(output[pos + len(marker) :].splitlines()[0])
            return {"ok": True, "variables": rows}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def _resolve_jump_cell(self, payload: dict[str, Any]) -> int | None:
        cell_idx = _safe_int(payload.get("cell"))
        if cell_idx is not None:
            return cell_idx
        ec = _safe_int(payload.get("exec_count"))
        with self.lock:
            if ec is not None and ec in self.exec_count_to_cell:
                return self.exec_count_to_cell[ec]
        return _safe_int(payload.get("own_index"))

    def handle_browser_action(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(payload, dict):
            return {"ok": False, "error": "payload must be an object"}
        action = payload.get("action")
        if action == "interrupt":
            return self.cmd_interrupt({})
        if action == "stdin":
            return self.cmd_input({"value": payload.get("value", "")})
        if action != "jump":
            return {"ok": False, "error": f"unknown action: {action}"}

        line = max(1, _safe_int(payload.get("line"), 1) or 1)
        kind = payload.get("kind")
        if kind == "file" and isinstance(payload.get("path"), str) and payload["path"]:
            self.emit({"type": "open_file", "path": payload["path"], "line": line})
            return {"ok": True}
        if kind == "cell":
            cell_idx = self._resolve_jump_cell(payload)
            if cell_idx is not None:
                self.emit({"type": "jump_cell_line", "cell_index": cell_idx, "line_offset": line})
            return {"ok": True}
        return {"ok": False, "error": f"invalid jump kind: {kind}"}

    def dispatch(self, msg: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(msg, dict):
            return {"ok": False, "error": "command must be a JSON object"}
        cmd = msg.get("type", "")
        handlers = {
            "render": self.cmd_render,
            "sync": self.cmd_sync,
            "execute": self.cmd_execute,
            "dag_query": self.cmd_dag_query,
            "interrupt": self.cmd_interrupt,
            "restart": self.cmd_restart,
            "kernels": self.cmd_kernels,
            "select_kernel": self.cmd_select_kernel,
            "variables": self.cmd_variables,
            "input": self.cmd_input,
            "cursor": self.cmd_cursor,
            "export": self.cmd_export,
            "print": self.cmd_print,
        }
        fn = handlers.get(cmd)
        if fn is None:
            return {"ok": False, "error": f"unknown command: {cmd}"}
        try:
            return fn(msg)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def close(self) -> None:
        self.shutdown_event.set()
        self.broadcast_sse("shutdown", "{}")
        with self._sse_lock:
            for q in list(self._sse_clients):
                try:
                    q.put_nowait(None)
                except queue.Full:
                    pass
        self._stop_kernel()


def make_handler(session: NotebookSession):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: Any) -> None:
            return

        def _send_bytes(
            self,
            status: int,
            body: bytes,
            content_type: str,
            extra_headers: dict[str, str] | None = None,
        ) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            for k, v in (extra_headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)
            self.close_connection = True

        def _authorize(
            self, *, require_origin: bool = False
        ) -> tuple[urllib.parse.SplitResult, dict[str, list[str]]] | None:
            allowed_hosts = {f"127.0.0.1:{session.port}", f"localhost:{session.port}"}
            if self.headers.get("Host", "") not in allowed_hosts:
                self._send_bytes(403, b"Forbidden host", "text/plain; charset=utf-8")
                return None
            parsed = urllib.parse.urlsplit(self.path)
            query = urllib.parse.parse_qs(parsed.query)
            vals = query.get("token")
            if not vals or not secrets.compare_digest(vals[0], session.token):
                self._send_bytes(403, b"Forbidden token", "text/plain; charset=utf-8")
                return None
            if require_origin:
                allowed_origins = {
                    f"http://127.0.0.1:{session.port}",
                    f"http://localhost:{session.port}",
                }
                if self.headers.get("Origin", "") not in allowed_origins:
                    self._send_bytes(403, b"Forbidden origin", "text/plain; charset=utf-8")
                    return None
            return parsed, query

        def _serve_export(self, query: dict[str, list[str]]) -> None:
            is_report = (query.get("report") or ["0"])[0] in ("1", "true")
            body = session.render_page(report=is_report, export=True).encode("utf-8")
            stem = sanitize_filename(os.path.splitext(session.title)[0])
            fname = f"{stem}{'.report' if is_report else ''}.html"
            self._send_bytes(
                200,
                body,
                "text/html; charset=utf-8",
                {"Content-Disposition": f'attachment; filename="{fname}"'},
            )

        def _serve_asset(self, query: dict[str, list[str]]) -> None:
            rel = (query.get("path") or [""])[0]
            if not rel:
                self._send_bytes(400, b"Missing path", "text/plain; charset=utf-8")
                return
            nb_dir = os.path.realpath(session.notebook_dir)
            candidate = os.path.realpath(os.path.join(nb_dir, rel))
            try:
                common = os.path.commonpath([nb_dir, candidate])
            except ValueError:
                self._send_bytes(403, b"Forbidden path", "text/plain; charset=utf-8")
                return
            if common != nb_dir or candidate == nb_dir:
                self._send_bytes(403, b"Forbidden path", "text/plain; charset=utf-8")
                return
            if not os.path.isfile(candidate):
                self._send_bytes(404, b"Not found", "text/plain; charset=utf-8")
                return
            ctype, _ = mimetypes.guess_type(candidate)
            with open(candidate, "rb") as fh:
                data = fh.read()
            self._send_bytes(200, data, ctype or "application/octet-stream")

        def _write_sse(self, event: str, data: str) -> None:
            lines = [f"event: {event}"] + [f"data: {part}" for part in data.split("\n")]
            self.wfile.write(("\n".join(lines) + "\n\n").encode("utf-8"))
            self.wfile.flush()

        def _serve_events(self) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            q = session.add_sse_client()
            try:
                self._write_sse("full", session.render_notebook_html())
                while not session.shutdown_event.is_set():
                    try:
                        item = q.get(timeout=15.0)
                    except queue.Empty:
                        self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
                        continue
                    if item is None:
                        break
                    self._write_sse(item[0], item[1])
                    if item[0] == "shutdown":
                        break
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                session.remove_sse_client(q)
                self.close_connection = True

        def do_GET(self) -> None:
            auth = self._authorize()
            if auth is None:
                return
            parsed, query = auth
            if parsed.path == "/":
                body = session.render_page().encode("utf-8")
                self._send_bytes(200, body, "text/html; charset=utf-8")
            elif parsed.path == "/export":
                self._serve_export(query)
            elif parsed.path == "/asset":
                self._serve_asset(query)
            elif parsed.path == "/events":
                self._serve_events()
            else:
                self._send_bytes(404, b"Not found", "text/plain; charset=utf-8")

        def do_POST(self) -> None:
            auth = self._authorize(require_origin=True)
            if auth is None:
                return
            parsed, _query = auth
            if parsed.path != "/action":
                self._send_bytes(404, b"Not found", "text/plain; charset=utf-8")
                return
            length = _safe_int(self.headers.get("Content-Length", "0"))
            if length is None or length < 0 or length > MAX_POST_BYTES:
                self._send_bytes(400, b"Invalid Content-Length", "text/plain; charset=utf-8")
                return
            try:
                raw = self.rfile.read(length) if length > 0 else b""
                payload = json.loads(raw.decode("utf-8")) if raw else {}
            except Exception:
                self._send_bytes(400, b"Invalid JSON", "text/plain; charset=utf-8")
                return
            result = session.handle_browser_action(payload)
            self._send_bytes(
                200 if result.get("ok") else 400,
                json.dumps(result).encode("utf-8"),
                "application/json; charset=utf-8",
            )

    return Handler


def start_http_server(session: NotebookSession) -> ThreadingHTTPServer:
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(session))
    httpd.daemon_threads = True
    session.port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, name="ipynb-http", daemon=True)
    thread.start()
    return httpd


def main() -> int:
    session = NotebookSession()
    httpd = start_http_server(session)

    def _handle_sig(_signum: int, _frame: Any) -> None:
        # Never acquire locks inside a signal handler; unwind to finally:.
        session.shutdown_event.set()
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, _handle_sig)
    signal.signal(signal.SIGINT, _handle_sig)

    url = f"http://127.0.0.1:{session.port}/?token={session.token}"
    session.emit({"type": "ready", "port": session.port, "token": session.token, "url": url})

    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception as exc:
                sys.stderr.write(f"malformed stdin JSON: {exc}\n")
                sys.stderr.flush()
                continue
            req_id = msg.get("id") if isinstance(msg, dict) else None
            result = session.dispatch(msg)
            if req_id is not None:
                session.emit({"type": "response", "id": req_id, **result})
    except SystemExit:
        pass
    finally:
        session.close()
        httpd.shutdown()
        httpd.server_close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
