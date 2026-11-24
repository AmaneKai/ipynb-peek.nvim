"""Real ipykernel end-to-end test for python/server.py."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest


def _has_ipykernel() -> bool:
    try:
        import ipykernel  # noqa: F401
        import jupyter_client  # noqa: F401
        return True
    except ImportError:
        return False


@unittest.skipUnless(
    os.environ.get("IPYNB_PEEK_RUN_E2E") == "1",
    "Set IPYNB_PEEK_RUN_E2E=1 (or run `make teste2e`) to run real ipykernel E2E tests",
)
@unittest.skipUnless(_has_ipykernel(), "jupyter_client and ipykernel are required")
class TestRealKernelE2E(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        server_py = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server.py"
        )
        self.proc = subprocess.Popen(
            [sys.executable, "-u", server_py],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.req_id = 0
        self.events: list[dict] = []
        ready = json.loads(self.proc.stdout.readline())
        self.assertEqual(ready["type"], "ready")

    def tearDown(self):
        try:
            if self.proc.stdin and not self.proc.stdin.closed:
                self.proc.stdin.close()
            self.proc.wait(timeout=10)
        finally:
            if self.proc.poll() is None:
                self.proc.kill()
            if self.proc.stdout:
                self.proc.stdout.close()
            if self.proc.stderr:
                self.proc.stderr.close()
            self.tmpdir.cleanup()

    def _send(self, cmd: str, **fields) -> dict:
        self.req_id += 1
        rid = self.req_id
        self.proc.stdin.write(json.dumps({"id": rid, "type": cmd, **fields}) + "\n")
        self.proc.stdin.flush()
        while True:
            line = self.proc.stdout.readline()
            self.assertTrue(line, "unexpected EOF waiting for response")
            msg = json.loads(line)
            if msg.get("type") == "response" and msg.get("id") == rid:
                return msg
            self.events.append(msg)

    def _wait_cell_idle(self, cell_index: int, timeout: float = 20.0) -> tuple[dict, dict | None]:
        deadline = time.monotonic() + timeout
        outputs_ev = None
        while time.monotonic() < deadline:
            line = self.proc.stdout.readline()
            self.assertTrue(line, "unexpected EOF waiting for cell completion")
            msg = json.loads(line)
            self.events.append(msg)
            if msg.get("type") == "cell_outputs" and msg.get("index") == cell_index:
                outputs_ev = msg
            if (
                msg.get("type") == "cell_status"
                and msg.get("index") == cell_index
                and msg.get("status") == "idle"
            ):
                return msg, outputs_ev
        self.fail(f"timed out waiting for cell {cell_index} to finish")

    def test_execute_stale_slices_and_silent_variables(self):
        kernel_name = os.environ.get("IPYNB_PEEK_E2E_KERNEL", "python3")
        nb_path = os.path.join(self.tmpdir.name, "e2e.ipynb")
        nb = {
            "nbformat": 4,
            "nbformat_minor": 5,
            "metadata": {"kernelspec": {"name": kernel_name}},
            "cells": [
                {"cell_type": "code", "source": "x = 10", "execution_count": None, "outputs": []},
                {
                    "cell_type": "code",
                    "source": "unrelated = 5",
                    "execution_count": None,
                    "outputs": [],
                },
                {
                    "cell_type": "code",
                    "source": "y = x * 2\nprint(y)",
                    "execution_count": None,
                    "outputs": [],
                },
            ],
        }
        resp = self._send("render", notebook=json.dumps(nb), dir=self.tmpdir.name, path=nb_path)
        self.assertTrue(resp["ok"])

        self.assertTrue(self._send("execute", index=0, code="x = 10")["ok"])
        st0, out0 = self._wait_cell_idle(0)
        self.assertFalse(st0["has_error"])
        self.assertEqual(st0["execution_count"], 1)
        self.assertIsNotNone(out0)

        self.assertTrue(self._send("execute", index=2, code="y = x * 2\nprint(y)")["ok"])
        st2, out2 = self._wait_cell_idle(2)
        self.assertFalse(st2["has_error"])
        self.assertEqual(st2["execution_count"], 2)
        assert out2 is not None
        self.assertTrue(any("20" in str(o.get("text", "")) for o in out2["outputs"]))

        # Edit cell 0 -> cells 0 and 2 stale, cell 1 fresh
        self.events.clear()
        self.assertTrue(
            self._send(
                "sync",
                cells=[
                    {"cell_type": "code", "source": "x = 99"},
                    {"cell_type": "code", "source": "unrelated = 5"},
                    {"cell_type": "code", "source": "y = x * 2\nprint(y)"},
                ],
            )["ok"]
        )
        dag_ev = [e for e in self.events if e.get("type") == "dag_status"][-1]
        self.assertIn("0", dag_ev["stale"])
        self.assertNotIn("1", dag_ev["stale"])
        self.assertIn("2", dag_ev["stale"])

        self.assertEqual(self._send("dag_query", kind="affected", index=0)["indices"], [0, 2])
        self.assertEqual(self._send("dag_query", kind="upstream", index=2)["indices"], [0, 2])

        # Undo edit -> staleness clears automatically
        self.events.clear()
        self.assertTrue(
            self._send(
                "sync",
                cells=[
                    {"cell_type": "code", "source": "x = 10"},
                    {"cell_type": "code", "source": "unrelated = 5"},
                    {"cell_type": "code", "source": "y = x * 2\nprint(y)"},
                ],
            )["ok"]
        )
        dag_ev2 = [e for e in self.events if e.get("type") == "dag_status"][-1]
        self.assertEqual(dag_ev2["stale"], {})

        # Quiet variable inspection must NOT bump execution_count
        vresp = self._send("variables")
        self.assertTrue(vresp["ok"])
        names = {v["name"] for v in vresp["variables"]}
        self.assertIn("x", names)
        self.assertIn("y", names)

        self.assertTrue(self._send("execute", index=1, code="unrelated = 5")["ok"])
        st1, _ = self._wait_cell_idle(1)
        self.assertEqual(st1["execution_count"], 3)


if __name__ == "__main__":
    unittest.main()
