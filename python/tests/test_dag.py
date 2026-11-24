"""Unit tests for python/dag.py AST dataflow & stale-cell engine."""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import dag


def code_cell(src: str) -> dict:
    return {"cell_type": "code", "source": src}


def md_cell(src: str) -> dict:
    return {"cell_type": "markdown", "source": src}


class TestSymbolExtraction(unittest.TestCase):
    def test_basic_assign_and_reads(self):
        sym = dag.extract_cell_symbols("x = 1\ny = x + z\nprint(len([y]))")
        self.assertFalse(sym["syntax_error"])
        self.assertEqual(sym["defs"], ["x", "y"])
        self.assertEqual(sym["reads"], ["z"])
        self.assertEqual(sym["mutations"], [])

    def test_read_before_assign_same_cell(self):
        sym = dag.extract_cell_symbols("x = x + 1")
        self.assertEqual(sym["defs"], ["x"])
        self.assertEqual(sym["reads"], ["x"])

    def test_augassign_reads_and_defines(self):
        sym = dag.extract_cell_symbols("total += delta")
        self.assertEqual(sym["defs"], ["total"])
        self.assertEqual(sym["reads"], ["delta", "total"])

    def test_annassign_for_with_except_walrus_delete(self):
        src = (
            "a: int = 1\n"
            "for i, (j, *k) in items:\n"
            "    pass\n"
            "with open_ctx() as fh:\n"
            "    pass\n"
            "try:\n"
            "    if (val := fetch()):\n"
            "        pass\n"
            "except CustomErr as err:\n"
            "    pass\n"
            "del old_var\n"
        )
        sym = dag.extract_cell_symbols(src)
        self.assertEqual(
            sym["defs"],
            ["a", "err", "fh", "i", "j", "k", "old_var", "val"],
        )
        self.assertEqual(
            sym["reads"],
            ["CustomErr", "fetch", "items", "old_var", "open_ctx"],
        )

    def test_imports_and_star_import(self):
        src = (
            "import os.path\n"
            "import numpy as np\n"
            "from math import sqrt, pi as PI\n"
            "from typing import *\n"
        )
        sym = dag.extract_cell_symbols(src)
        self.assertEqual(sym["defs"], ["PI", "np", "os", "sqrt"])
        self.assertEqual(sym["reads"], [])

    def test_function_scope_isolation_and_closures(self):
        src = (
            "def compute(a, b=default_b, *args, c=1, **kwargs):\n"
            "    local_var = a + b + outer_free\n"
            "    return local_var + c\n"
        )
        sym = dag.extract_cell_symbols(src)
        self.assertEqual(sym["defs"], ["compute"])
        self.assertEqual(sym["reads"], ["default_b", "outer_free"])

    def test_global_inside_function_counts_as_cell_def(self):
        src = (
            "def update_state():\n"
            "    global counter\n"
            "    counter = counter + 1\n"
        )
        sym = dag.extract_cell_symbols(src)
        self.assertEqual(sym["defs"], ["counter", "update_state"])
        self.assertEqual(sym["reads"], ["counter"])
        sym2 = dag.extract_cell_symbols(
            "def set_flag():\n    global flag\n    flag = True\n"
        )
        self.assertEqual(sym2["defs"], ["flag", "set_flag"])
        self.assertEqual(sym2["reads"], [])

    def test_nested_nonlocal_does_not_leak(self):
        src = (
            "def outer():\n"
            "    x = 1\n"
            "    def inner():\n"
            "        nonlocal x\n"
            "        x += 1\n"
            "    return inner\n"
        )
        sym = dag.extract_cell_symbols(src)
        self.assertEqual(sym["defs"], ["outer"])
        self.assertEqual(sym["reads"], [])

    def test_class_scope_isolation_and_outer_read(self):
        src = (
            "class Model(BaseModel):\n"
            "    x = x + 1\n"
            "    y = x + 2\n"
            "    lr = default_lr\n"
            "    def fit(self, X):\n"
            "        z = X * scale\n"
            "        return z\n"
        )
        sym = dag.extract_cell_symbols(src)
        self.assertEqual(sym["defs"], ["Model"])
        self.assertEqual(sym["reads"], ["BaseModel", "default_lr", "scale", "x"])

    def test_lambda_and_comprehensions_isolation(self):
        src = (
            "f = lambda x, y=init: x + y + bias\n"
            "squares = [n * n + offset for n in nums if n > thresh]\n"
            "mapping = {k: v for k, v in pairs}\n"
            "uniq = {item for item in raw}\n"
            "gen = (el for el in stream)\n"
        )
        sym = dag.extract_cell_symbols(src)
        self.assertEqual(sym["defs"], ["f", "gen", "mapping", "squares", "uniq"])
        self.assertEqual(
            sym["reads"],
            ["bias", "init", "nums", "offset", "pairs", "raw", "stream", "thresh"],
        )

    def test_walrus_inside_comprehension_leaks_to_cell_scope(self):
        sym = dag.extract_cell_symbols("res = [last := x * 2 for x in xs]")
        self.assertEqual(sym["defs"], ["last", "res"])
        self.assertEqual(sym["reads"], ["xs"])

    def test_in_place_mutations_and_nested_subscript_slices(self):
        sym = dag.extract_cell_symbols(
            "cfg.lr = 0.01\n"
            "matrix[i][j] = val\n"
            "groups[k].append(new_item)\n"
            "objs[idx].count += 1\n"
            "del holder[dkey].attr\n"
            "df.dropna(inplace=True)\n"
        )
        self.assertEqual(
            sym["mutations"],
            ["cfg", "df", "groups", "holder", "matrix", "objs"],
        )
        for name in ("i", "j", "k", "idx", "dkey", "val", "new_item"):
            self.assertIn(name, sym["reads"])

    def test_imported_module_calls_do_not_mutate_module(self):
        # Same-cell import + module calls
        sym = dag.extract_cell_symbols(
            "import numpy as np\nimport os\nb = np.append(a, 1)\nos.remove(p)\n"
        )
        self.assertEqual(sym["mutations"], [])
        self.assertEqual(sym["reads"], ["a", "p"])

        # Cross-cell import + module calls
        cells = [
            code_cell("import numpy as np\nimport os"),
            code_cell("b = np.sort(np.insert(a, 0, 1))\nos.remove(p)"),
            code_cell("c = np.zeros(3)"),
        ]
        analysis = dag.analyze(cells)
        self.assertEqual(analysis[1]["mutations"], [])
        self.assertEqual(analysis[1]["upstream"], {0: ["np", "os"]})
        # Cell 2 depends on Cell 0 (import np), NOT Cell 1
        self.assertEqual(analysis[2]["upstream"], {0: ["np"]})

    def test_local_mutation_after_def_in_same_cell_is_not_external_read(self):
        src = "xs = []\nxs.append(1)\ndf = load()\ndf.sort_values('a', inplace=True)"
        sym = dag.extract_cell_symbols(src)
        self.assertEqual(sym["defs"], ["df", "xs"])
        self.assertEqual(sym["mutations"], ["df", "xs"])
        self.assertEqual(sym["reads"], ["load"])

    def test_syntax_error_resilience(self):
        sym = dag.extract_cell_symbols("def broken(:\n    x = ")
        self.assertTrue(sym["syntax_error"])
        self.assertEqual(sym["defs"], [])
        self.assertEqual(sym["reads"], [])
        self.assertEqual(sym["mutations"], [])


class TestDAGAndStaleness(unittest.TestCase):
    def test_edges_mutations_and_redefinition(self):
        cells = [
            md_cell("# Title"),
            code_cell("xs = [1, 2]"),
            code_cell("xs.append(3)"),
            code_cell("total = sum(xs)"),
            code_cell("xs = [10, 20]"),
            code_cell("other = sum(xs)"),
        ]
        analysis = dag.analyze(cells)
        self.assertEqual(analysis[1]["downstream"], {2: ["xs"]})
        self.assertEqual(analysis[2]["upstream"], {1: ["xs"]})
        self.assertEqual(analysis[2]["downstream"], {3: ["xs"]})
        self.assertEqual(analysis[3]["upstream"], {2: ["xs"]})
        self.assertEqual(analysis[4]["redefinitions"], {"xs": 2})
        self.assertEqual(analysis[5]["upstream"], {4: ["xs"]})

    def test_late_definition_detection(self):
        cells = [code_cell("y = x + 1"), code_cell("x = 42")]
        analysis = dag.analyze(cells)
        self.assertEqual(analysis[0]["upstream"], {})
        self.assertEqual(analysis[0]["late_defs"], {"x": [1]})

    def test_transitive_staleness_and_undo_clears(self):
        c0 = code_cell("lr = 0.01")
        c1 = code_cell("model = train(lr)")
        c2 = code_cell("score = eval_model(model)")
        init = dag.analyze([c0, c1, c2])
        exec_state = {
            i: {
                "executed_hash": init[i]["source_hash"],
                "execution_count": i + 1,
                "has_error": False,
            }
            for i in range(3)
        }
        self.assertEqual(dag.compute_stale(init, exec_state), {})

        edited = dag.analyze([code_cell("lr = 0.001"), c1, c2])
        stale = dag.compute_stale(edited, exec_state)
        self.assertEqual(sorted(stale.keys()), [0, 1, 2])
        self.assertTrue(stale[0]["edited"])
        self.assertEqual(stale[1]["reasons"][0]["from"], 0)
        self.assertEqual(stale[1]["reasons"][0]["symbols"], ["lr"])
        self.assertEqual(stale[2]["reasons"][0]["from"], 1)

        undone = dag.analyze([c0, c1, c2])
        self.assertEqual(dag.compute_stale(undone, exec_state), {})

    def test_upstream_unrun_and_rerun_staleness(self):
        cells = [code_cell("a = 1"), code_cell("b = a + 1"), code_cell("c = b + 1")]
        analysis = dag.analyze(cells)

        # Executed cell 1 depends on unrun cell 0 -> upstream_unrun
        exec_unrun = {
            1: {"executed_hash": analysis[1]["source_hash"], "execution_count": 1},
            2: {"executed_hash": analysis[2]["source_hash"], "execution_count": 2},
        }
        stale_u = dag.compute_stale(analysis, exec_unrun)
        self.assertEqual(sorted(stale_u.keys()), [1, 2])
        self.assertEqual(stale_u[1]["reasons"][0]["kind"], "upstream_unrun")
        self.assertEqual(stale_u[2]["reasons"][0]["kind"], "transitive")

        # Cell 0 re-ran at count 5 after cells 1 (2) and 2 (3) -> upstream_rerun
        exec_rerun = {
            0: {"executed_hash": analysis[0]["source_hash"], "execution_count": 5},
            1: {"executed_hash": analysis[1]["source_hash"], "execution_count": 2},
            2: {"executed_hash": analysis[2]["source_hash"], "execution_count": 3},
        }
        stale_r = dag.compute_stale(analysis, exec_rerun)
        self.assertEqual(sorted(stale_r.keys()), [1, 2])
        self.assertEqual(stale_r[1]["reasons"][0]["kind"], "upstream_rerun")

    def test_affected_and_upstream_slices(self):
        cells = [
            code_cell("a = 1"),
            code_cell("unrelated = 9"),
            md_cell("# Section"),
            code_cell("b = a + 2"),
            code_cell("c = 5"),
            code_cell("d = b + c"),
        ]
        analysis = dag.analyze(cells)
        self.assertEqual(dag.affected_slice(analysis, 0), [0, 3, 5])
        self.assertEqual(dag.affected_slice(analysis, 1), [1])
        self.assertEqual(dag.affected_slice(analysis, 2), [])
        self.assertEqual(dag.upstream_slice(analysis, 5), [0, 3, 4, 5])
        self.assertEqual(dag.upstream_slice(analysis, 3), [0, 3])
        self.assertEqual(dag.upstream_slice(analysis, 2), [])

    def test_audit_reports_all_issue_kinds(self):
        cells = [
            code_cell("a = 1"),
            code_cell("b = a + late"),
            code_cell("u = 10"),
            code_cell("v = u + 1"),
            code_cell("late = 99"),
            code_cell("a = 2"),
            code_cell("def oops(:"),
        ]
        analysis = dag.analyze(cells)
        exec_state = {
            0: {"executed_hash": analysis[0]["source_hash"], "execution_count": 4},
            1: {"executed_hash": analysis[1]["source_hash"], "execution_count": 2},
            3: {"executed_hash": analysis[3]["source_hash"], "execution_count": 3},
        }
        issues = dag.audit(analysis, exec_state)
        kinds = {i["kind"] for i in issues}
        for expected in (
            "stale",
            "out_of_order",
            "unrun_dependency",
            "late_definition",
            "redefinition",
            "syntax_error",
        ):
            self.assertIn(expected, kinds)


if __name__ == "__main__":
    unittest.main()
