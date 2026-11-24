"""Unit & integration tests for python/server.py HTTP security, SSE, and stdio."""

from __future__ import annotations

import http.client
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import server


class TestHTTPAndSecurity(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.events: list[dict] = []
        self.session = server.NotebookSession(emit_fn=self.events.append)
        self.session.notebook_dir = self.tmpdir.name
        self.httpd = server.start_http_server(self.session)
        self.port = self.session.port
        self.token = self.session.token

    def tearDown(self):
        self.session.close()
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmpdir.cleanup()

    def _req(self, method: str, path: str, headers=None, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.request(method, path, body=body, headers=headers or {})
            resp = conn.getresponse()
            data = resp.read()
            return resp.status, data, dict(resp.getheaders())
        finally:
            conn.close()

    def test_rejects_bad_host_and_missing_token(self):
        st, _, _ = self._req("GET", f"/?token={self.token}", headers={"Host": "evil.com:1"})
        self.assertEqual(st, 403)
        st, _, _ = self._req("GET", "/")
        self.assertEqual(st, 403)
        st, _, _ = self._req("GET", "/?token=wrong")
        self.assertEqual(st, 403)
        st, body, _ = self._req("GET", f"/?token={self.token}")
        self.assertEqual(st, 200)
        self.assertIn(b"EventSource", body)

    def test_post_action_checks_origin_and_emits_jump(self):
        payload = json.dumps(
            {"action": "jump", "kind": "file", "path": "/a.py", "line": 7}
        ).encode()
        st, _, _ = self._req("POST", f"/action?token={self.token}", body=payload)
        self.assertEqual(st, 403)

        st, _, _ = self._req(
            "POST",
            f"/action?token={self.token}",
            headers={"Origin": "http://evil.com"},
            body=payload,
        )
        self.assertEqual(st, 403)

        st, _, _ = self._req(
            "POST",
            f"/action?token={self.token}",
            headers={"Origin": f"http://127.0.0.1:{self.port}"},
            body=payload,
        )
        self.assertEqual(st, 200)
        self.assertTrue(
            any(
                e.get("type") == "open_file" and e.get("path") == "/a.py" and e.get("line") == 7
                for e in self.events
            )
        )

    def test_asset_blocks_path_traversal_and_serves_inside_dir(self):
        img_path = os.path.join(self.tmpdir.name, "pic.txt")
        with open(img_path, "wb") as fh:
            fh.write(b"hello-asset")

        st, data, _ = self._req("GET", f"/asset?path=pic.txt&token={self.token}")
        self.assertEqual(st, 200)
        self.assertEqual(data, b"hello-asset")

        st, _, _ = self._req("GET", f"/asset?path=../../etc/passwd&token={self.token}")
        self.assertEqual(st, 403)

        outside = tempfile.NamedTemporaryFile(delete=False)
        outside.write(b"secret")
        outside.close()
        try:
            link_path = os.path.join(self.tmpdir.name, "escape.txt")
            os.symlink(outside.name, link_path)
            st, _, _ = self._req("GET", f"/asset?path=escape.txt&token={self.token}")
            self.assertEqual(st, 403)
        finally:
            os.unlink(outside.name)

    def test_sse_streams_initial_and_cursor_events(self):
        self.session.cmd_render(
            {
                "cells": [{"cell_type": "code", "source": "x = 1"}],
                "dir": self.tmpdir.name,
                "path": os.path.join(self.tmpdir.name, "test.ipynb"),
            }
        )
        received: list[str] = []

        def reader():
            conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
            conn.request("GET", f"/events?token={self.token}")
            resp = conn.getresponse()
            self.assertEqual(resp.status, 200)
            while True:
                line = resp.readline()
                if not line:
                    break
                decoded = line.decode("utf-8", errors="replace")
                received.append(decoded)
                if "event: shutdown" in decoded:
                    break
            conn.close()

        t = threading.Thread(target=reader, daemon=True)
        t.start()
        time.sleep(0.1)
        self.session.cmd_cursor({"index": 0})
        time.sleep(0.05)
        self.session.close()
        t.join(timeout=3)
        joined = "".join(received)
        self.assertIn("event: full", joined)
        self.assertIn("event: cursor", joined)
        self.assertIn("event: shutdown", joined)

    def test_export_sanitizes_content_disposition_and_cmd_export(self):
        nb_path = os.path.join(self.tmpdir.name, 'bad "name" café.ipynb')
        self.session.cmd_render(
            {
                "cells": [
                    {"cell_type": "markdown", "source": "# Hi"},
                    {"cell_type": "code", "source": "a = 1"},
                ],
                "path": nb_path,
            }
        )
        st, body, hdrs = self._req("GET", f"/export?report=1&token={self.token}")
        self.assertEqual(st, 200)
        self.assertIn(b"<h1>Hi</h1>", body)
        self.assertNotIn(b"EventSource", body)
        self.assertNotIn(b'class="cell-input"', body)
        cd = hdrs.get("Content-Disposition", "")
        self.assertIn('filename="bad__name__caf.report.html"', cd)

        res = self.session.cmd_export({"mode": "html"})
        self.assertTrue(res["ok"])
        self.assertTrue(os.path.isfile(res["path"]))

    def test_cmd_sync_reconciles_insert_above_and_remaps_running_msgs(self):
        nb = {
            "cells": [
                {
                    "cell_type": "code",
                    "source": "x = 1",
                    "execution_count": 3,
                    "outputs": [{"output_type": "stream", "name": "stdout", "text": "one\n"}],
                },
                {
                    "cell_type": "code",
                    "source": "y = x + 1",
                    "execution_count": 4,
                    "outputs": [],
                },
            ]
        }
        self.assertTrue(self.session.cmd_render({"notebook": json.dumps(nb)})["ok"])
        self.session._running_msgs["m1"] = {"index": 1, "code_hash": "h", "start_time": 0.0}

        # Insert a brand-new cell at index 0 above existing cells
        res = self.session.cmd_sync(
            {
                "cells": [
                    {"cell_type": "code", "source": "z = 0"},
                    {"cell_type": "code", "source": "x = 1"},
                    {"cell_type": "code", "source": "y = x + 1"},
                ]
            }
        )
        self.assertTrue(res["ok"])
        # Cell 0 is brand-new (no outputs); old cell 0 shifted to 1; old cell 1 shifted to 2
        self.assertIsNone(self.session.cells[0]["execution_count"])
        self.assertEqual(self.session.cells[1]["execution_count"], 3)
        self.assertEqual(len(self.session.cells[1]["outputs"]), 1)
        self.assertEqual(self.session.cells[2]["execution_count"], 4)
        self.assertEqual(self.session.exec_count_to_cell[3], 1)
        self.assertEqual(self.session.exec_count_to_cell[4], 2)
        self.assertEqual(self.session._running_msgs["m1"]["index"], 2)
        self.assertIn(1, self.session.exec_state)
        self.assertIn(2, self.session.exec_state)
        self.assertNotIn(0, self.session.exec_state)

    def test_kernel_death_marks_running_cells_errored_and_idle(self):
        self.session.cmd_render({"cells": [{"cell_type": "code", "source": "1"}]})
        self.session.cells[0]["status"] = "busy"
        self.session._running_msgs["dead1"] = {"index": 0, "code_hash": "h", "start_time": 0.0}
        self.events.clear()

        self.session._handle_kernel_death()

        self.assertEqual(self.session.cells[0]["status"], "idle")
        self.assertTrue(self.session.cells[0]["has_error"])
        self.assertEqual(self.session._running_msgs, {})
        self.assertTrue(
            any(
                e.get("type") == "cell_status"
                and e.get("index") == 0
                and e.get("status") == "idle"
                and e.get("has_error") is True
                for e in self.events
            )
        )
        self.assertTrue(
            any(e.get("type") == "kernel" and e.get("running") is False for e in self.events)
        )

    def test_defensive_validation_rejects_malformed_inputs(self):
        self.assertFalse(self.session.cmd_render({"notebook": "[]"})["ok"])
        self.assertFalse(self.session.cmd_sync({"cells": "not-a-list"})["ok"])
        self.assertFalse(self.session.cmd_execute({"index": -1, "code": "1"})["ok"])


class TestStdioProtocol(unittest.TestCase):
    def _spawn(self):
        server_py = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server.py"
        )
        return subprocess.Popen(
            [sys.executable, "-u", server_py],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

    def test_stdio_ready_sync_dag_query_and_clean_eof_exit(self):
        proc = self._spawn()
        assert proc.stdin and proc.stdout
        ready = json.loads(proc.stdout.readline())
        self.assertEqual(ready["type"], "ready")
        self.assertIsInstance(ready["port"], int)
        self.assertTrue(ready["token"])

        nb = {
            "nbformat": 4,
            "nbformat_minor": 5,
            "metadata": {},
            "cells": [
                {"cell_type": "code", "source": "x = 1", "execution_count": 1, "outputs": []},
                {"cell_type": "code", "source": "y = x + 1", "execution_count": 2, "outputs": []},
            ],
        }
        proc.stdin.write(json.dumps({"id": 1, "type": "render", "notebook": json.dumps(nb)}) + "\n")
        proc.stdin.flush()

        def read_until_response(req_id: int):
            events = []
            while True:
                line = proc.stdout.readline()
                self.assertTrue(line, "unexpected EOF from server")
                msg = json.loads(line)
                if msg.get("type") == "response" and msg.get("id") == req_id:
                    return msg, events
                events.append(msg)

        resp1, ev1 = read_until_response(1)
        self.assertTrue(resp1["ok"])
        self.assertTrue(any(e["type"] == "dag_status" for e in ev1))

        proc.stdin.write(
            json.dumps(
                {
                    "id": 2,
                    "type": "sync",
                    "cells": [
                        {"cell_type": "code", "source": "x = 99"},
                        {"cell_type": "code", "source": "y = x + 1"},
                    ],
                }
            )
            + "\n"
        )
        proc.stdin.flush()
        resp2, ev2 = read_until_response(2)
        self.assertTrue(resp2["ok"])
        dag_ev = [e for e in ev2 if e["type"] == "dag_status"][-1]
        self.assertIn("0", dag_ev["stale"])
        self.assertIn("1", dag_ev["stale"])

        proc.stdin.write(
            json.dumps({"id": 3, "type": "dag_query", "kind": "affected", "index": 0}) + "\n"
        )
        proc.stdin.flush()
        resp3, _ = read_until_response(3)
        self.assertEqual(resp3["indices"], [0, 1])

        proc.stdin.close()
        self.assertEqual(proc.wait(timeout=5), 0)
        proc.stdout.close()
        proc.stderr.close()

    def test_sigterm_exits_cleanly_without_deadlock(self):
        proc = self._spawn()
        assert proc.stdin and proc.stdout
        ready = json.loads(proc.stdout.readline())
        self.assertEqual(ready["type"], "ready")

        proc.send_signal(signal.SIGTERM)
        rc = proc.wait(timeout=5)
        self.assertEqual(rc, 0)
        proc.stdin.close()
        proc.stdout.close()
        proc.stderr.close()


if __name__ == "__main__":
    unittest.main()
