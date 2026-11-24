"""Pure Python stdlib AST dataflow & stale-cell engine (DAG) for notebooks."""

from __future__ import annotations

import ast
import builtins
from collections import deque
import hashlib
from typing import Any

BUILTINS: frozenset[str] = frozenset(dir(builtins))

MUTATING_METHODS: frozenset[str] = frozenset(
    {
        "append",
        "extend",
        "insert",
        "pop",
        "remove",
        "clear",
        "sort",
        "reverse",
        "update",
        "setdefault",
        "add",
        "discard",
    }
)


def hash_source(source: str) -> str:
    """Stable SHA-256 hex digest of a cell's source text."""
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def _normalize_source(raw: Any) -> str:
    if isinstance(raw, list):
        return "".join(str(part) for part in raw)
    if isinstance(raw, str):
        return raw
    return ""


def _root_name(node: ast.AST) -> str | None:
    """Return the root ast.Name.id for attribute/subscript chains, else None."""
    cur = node
    while isinstance(cur, (ast.Attribute, ast.Subscript)):
        cur = cur.value
    return cur.id if isinstance(cur, ast.Name) else None


def _collect_target_names(target: ast.AST, out: set[str]) -> None:
    """Collect plain Name ids bound by an assignment/for/with target."""
    if isinstance(target, ast.Name):
        out.add(target.id)
    elif isinstance(target, (ast.Tuple, ast.List)):
        for elt in target.elts:
            _collect_target_names(elt, out)
    elif isinstance(target, ast.Starred):
        _collect_target_names(target.value, out)


def _collect_pattern_names(pattern: ast.AST, out: set[str]) -> None:
    """Collect variable names bound by a PEP 634 match pattern."""
    if hasattr(ast, "MatchAs") and isinstance(pattern, ast.MatchAs):
        if pattern.name:
            out.add(pattern.name)
        if pattern.pattern is not None:
            _collect_pattern_names(pattern.pattern, out)
        return
    if hasattr(ast, "MatchStar") and isinstance(pattern, ast.MatchStar):
        if pattern.name:
            out.add(pattern.name)
        return
    if hasattr(ast, "MatchMapping") and isinstance(pattern, ast.MatchMapping):
        if pattern.rest:
            out.add(pattern.rest)
        for pat in pattern.patterns:
            _collect_pattern_names(pat, out)
        return
    sub_pats = getattr(pattern, "patterns", None) or ()
    for pat in sub_pats:
        _collect_pattern_names(pat, out)
    for pat in getattr(pattern, "kwd_patterns", None) or ():
        _collect_pattern_names(pat, out)


def _collect_arg_names(args: ast.arguments) -> set[str]:
    names = {arg.arg for arg in (args.posonlyargs + args.args + args.kwonlyargs)}
    if args.vararg:
        names.add(args.vararg.arg)
    if args.kwarg:
        names.add(args.kwarg.arg)
    return names


def _scan_expr_walrus(expr: ast.AST | None, locals_: set[str]) -> None:
    """Scan expression for NamedExpr (:=) bindings without entering lambdas."""
    if expr is None:
        return
    if isinstance(expr, ast.Lambda):
        for default in expr.args.defaults + expr.args.kw_defaults:
            _scan_expr_walrus(default, locals_)
        return
    if isinstance(expr, ast.NamedExpr):
        if isinstance(expr.target, ast.Name):
            locals_.add(expr.target.id)
        _scan_expr_walrus(expr.value, locals_)
        return
    for child in ast.iter_child_nodes(expr):
        _scan_expr_walrus(child, locals_)


def _scan_stmt_decls(
    stmt: ast.stmt,
    locals_: set[str],
    globals_: set[str],
    nonlocals_: set[str],
) -> None:
    """Inspect a single statement for scope declarations and local bindings."""
    if isinstance(stmt, ast.Global):
        globals_.update(stmt.names)
        return
    if isinstance(stmt, ast.Nonlocal):
        nonlocals_.update(stmt.names)
        return
    if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
        locals_.add(stmt.name)
        for expr in stmt.decorator_list + stmt.args.defaults + stmt.args.kw_defaults:
            _scan_expr_walrus(expr, locals_)
        return
    if isinstance(stmt, ast.ClassDef):
        locals_.add(stmt.name)
        for expr in stmt.decorator_list + stmt.bases:
            _scan_expr_walrus(expr, locals_)
        for kw in stmt.keywords:
            _scan_expr_walrus(kw.value, locals_)
        return
    if isinstance(stmt, ast.Assign):
        for target in stmt.targets:
            _collect_target_names(target, locals_)
        _scan_expr_walrus(stmt.value, locals_)
        return
    if isinstance(stmt, ast.AnnAssign):
        if isinstance(stmt.target, ast.Name):
            locals_.add(stmt.target.id)
        _scan_expr_walrus(stmt.annotation, locals_)
        _scan_expr_walrus(stmt.value, locals_)
        return
    if isinstance(stmt, ast.AugAssign):
        if isinstance(stmt.target, ast.Name):
            locals_.add(stmt.target.id)
        _scan_expr_walrus(stmt.value, locals_)
        return
    if isinstance(stmt, (ast.For, ast.AsyncFor)):
        _collect_target_names(stmt.target, locals_)
        _scan_expr_walrus(stmt.iter, locals_)
        _scan_stmts_into(stmt.body + stmt.orelse, locals_, globals_, nonlocals_)
        return
    if isinstance(stmt, (ast.With, ast.AsyncWith)):
        for item in stmt.items:
            _scan_expr_walrus(item.context_expr, locals_)
            if item.optional_vars is not None:
                _collect_target_names(item.optional_vars, locals_)
        _scan_stmts_into(stmt.body, locals_, globals_, nonlocals_)
        return
    if isinstance(stmt, ast.Import):
        for alias in stmt.names:
            locals_.add(alias.asname or alias.name.split(".")[0])
        return
    if isinstance(stmt, ast.ImportFrom):
        for alias in stmt.names:
            if alias.name != "*":
                locals_.add(alias.asname or alias.name)
        return
    if isinstance(stmt, ast.Delete):
        for target in stmt.targets:
            if isinstance(target, ast.Name):
                locals_.add(target.id)
        return
    if isinstance(stmt, (ast.If, ast.While)):
        _scan_expr_walrus(stmt.test, locals_)
        _scan_stmts_into(stmt.body + stmt.orelse, locals_, globals_, nonlocals_)
        return
    if isinstance(stmt, ast.Try) or (
        hasattr(ast, "TryStar") and isinstance(stmt, ast.TryStar)
    ):
        _scan_try_decls(stmt, locals_, globals_, nonlocals_)
        return
    if hasattr(ast, "Match") and isinstance(stmt, ast.Match):
        _scan_match_decls(stmt, locals_, globals_, nonlocals_)
        return
    for child in ast.iter_child_nodes(stmt):
        if isinstance(child, ast.expr):
            _scan_expr_walrus(child, locals_)


def _scan_try_decls(
    stmt: Any,
    locals_: set[str],
    globals_: set[str],
    nonlocals_: set[str],
) -> None:
    _scan_stmts_into(stmt.body, locals_, globals_, nonlocals_)
    for handler in stmt.handlers:
        _scan_expr_walrus(handler.type, locals_)
        if handler.name:
            locals_.add(handler.name)
        _scan_stmts_into(handler.body, locals_, globals_, nonlocals_)
    _scan_stmts_into(stmt.orelse + stmt.finalbody, locals_, globals_, nonlocals_)


def _scan_match_decls(
    stmt: Any,
    locals_: set[str],
    globals_: set[str],
    nonlocals_: set[str],
) -> None:
    _scan_expr_walrus(stmt.subject, locals_)
    for case in stmt.cases:
        _collect_pattern_names(case.pattern, locals_)
        _scan_expr_walrus(case.guard, locals_)
        _scan_stmts_into(case.body, locals_, globals_, nonlocals_)


def _scan_stmts_into(
    stmts: list[ast.stmt],
    locals_: set[str],
    globals_: set[str],
    nonlocals_: set[str],
) -> None:
    for stmt in stmts:
        _scan_stmt_decls(stmt, locals_, globals_, nonlocals_)


def _scan_scope_decls(body: list[ast.stmt]) -> tuple[set[str], set[str], set[str]]:
    """Scan a function/class body for local bindings, global decls, nonlocal decls."""
    locals_: set[str] = set()
    globals_: set[str] = set()
    nonlocals_: set[str] = set()
    _scan_stmts_into(body, locals_, globals_, nonlocals_)
    locals_ -= globals_
    locals_ -= nonlocals_
    return locals_, globals_, nonlocals_


class _Scope:
    def __init__(
        self,
        kind: str,
        locals_: set[str] | None = None,
        globals_: set[str] | None = None,
        nonlocals_: set[str] | None = None,
    ) -> None:
        self.kind = kind
        self.locals: set[str] = set(locals_ or ())
        self.globals: set[str] = set(globals_ or ())
        self.nonlocals: set[str] = set(nonlocals_ or ())
        self.bound: set[str] = set()


class _CellAnalyzer:
    """Single-cell AST symbol extractor respecting Python lexical scoping."""

    def __init__(self, known_modules: set[str] | frozenset[str] = frozenset()) -> None:
        self.defs: set[str] = set()
        self.reads: set[str] = set()
        self.deferred_reads: set[str] = set()
        self.mutations: set[str] = set()
        self.imported_modules: set[str] = set()
        self.known_modules: set[str] = set(known_modules)
        self.scopes: list[_Scope] = [_Scope("module")]

    @property
    def _cur(self) -> _Scope:
        return self.scopes[-1]

    def _in_deferred_scope(self) -> bool:
        return any(s.kind in ("function", "lambda") for s in self.scopes[1:])

    def _is_bound_in_enclosing_local(self, name: str) -> bool:
        """True if `name` resolves to a local in a non-module scope."""
        if name in self._cur.globals:
            return False
        top_idx = len(self.scopes) - 1
        for idx in range(top_idx, 0, -1):
            scope = self.scopes[idx]
            if scope.kind == "class":
                # Inside a class body, only earlier bindings shadow outer names
                # (`class A: x = x + 1` reads outer `x`). Nested scopes skip class.
                if idx == top_idx and name in scope.bound:
                    return True
                continue
            if name in scope.globals:
                return False
            if name in scope.locals or name in scope.bound:
                return True
        return False

    def _record_read(self, name: str) -> None:
        if name in BUILTINS or self._is_bound_in_enclosing_local(name):
            return
        if name in self.scopes[0].bound:
            return
        if self._in_deferred_scope():
            self.deferred_reads.add(name)
        else:
            self.reads.add(name)

    def _record_module_def(self, name: str, *, is_import_module: bool = False) -> None:
        self.defs.add(name)
        if self._in_deferred_scope():
            return
        self.scopes[0].bound.add(name)
        if is_import_module:
            self.imported_modules.add(name)
            self.known_modules.add(name)
        else:
            self.imported_modules.discard(name)
            self.known_modules.discard(name)

    def _record_mutation(self, name: str) -> None:
        if name in BUILTINS or self._is_bound_in_enclosing_local(name):
            return
        if name not in self.scopes[0].bound:
            target_set = self.deferred_reads if self._in_deferred_scope() else self.reads
            target_set.add(name)
        self.mutations.add(name)

    def _visit_chain_slices(self, node: ast.AST) -> None:
        """Visit every Subscript.slice along an Attribute/Subscript chain."""
        cur = node
        while isinstance(cur, (ast.Attribute, ast.Subscript)):
            if isinstance(cur, ast.Subscript):
                self.visit(cur.slice)
            cur = cur.value

    def _visit_mutating_chain(self, node: ast.Attribute | ast.Subscript) -> None:
        """Visit subscript slices along a mutation target and record root mutation."""
        self._visit_chain_slices(node)
        root = _root_name(node)
        if root is not None:
            self._record_mutation(root)
        else:
            self.visit(node.value)

    def _bind_name(
        self, name: str, *, walrus: bool = False, is_import_module: bool = False
    ) -> None:
        target_idx = len(self.scopes) - 1
        if walrus:
            while target_idx > 0 and self.scopes[target_idx].kind == "comprehension":
                target_idx -= 1
        scope = self.scopes[target_idx]
        if scope.kind == "module" or name in scope.globals:
            self._record_module_def(name, is_import_module=is_import_module)
        elif name not in scope.nonlocals:
            scope.bound.add(name)
            scope.locals.add(name)

    def _visit_target(self, target: ast.AST, *, walrus: bool = False) -> None:
        if isinstance(target, ast.Name):
            self._bind_name(target.id, walrus=walrus)
        elif isinstance(target, (ast.Tuple, ast.List)):
            for elt in target.elts:
                self._visit_target(elt, walrus=walrus)
        elif isinstance(target, ast.Starred):
            self._visit_target(target.value, walrus=walrus)
        elif isinstance(target, (ast.Attribute, ast.Subscript)):
            self._visit_mutating_chain(target)

    def _visit_pattern(self, pattern: ast.AST) -> None:
        if hasattr(ast, "MatchValue") and isinstance(pattern, ast.MatchValue):
            self.visit(pattern.value)
            return
        if hasattr(ast, "MatchAs") and isinstance(pattern, ast.MatchAs):
            self._visit_pattern(pattern.pattern) if pattern.pattern else None
            if pattern.name:
                self._bind_name(pattern.name)
            return
        if hasattr(ast, "MatchStar") and isinstance(pattern, ast.MatchStar):
            if pattern.name:
                self._bind_name(pattern.name)
            return
        if hasattr(ast, "MatchMapping") and isinstance(pattern, ast.MatchMapping):
            for key in pattern.keys:
                self.visit(key)
            for pat in pattern.patterns:
                self._visit_pattern(pat)
            if pattern.rest:
                self._bind_name(pattern.rest)
            return
        if hasattr(ast, "MatchClass") and isinstance(pattern, ast.MatchClass):
            self.visit(pattern.cls)
        for pat in getattr(pattern, "patterns", None) or ():
            self._visit_pattern(pat)
        for pat in getattr(pattern, "kwd_patterns", None) or ():
            self._visit_pattern(pat)

    def visit(self, node: ast.AST | None) -> None:
        if node is None:
            return
        method = getattr(self, f"visit_{type(node).__name__}", None)
        if method is not None:
            method(node)
            return
        for child in ast.iter_child_nodes(node):
            self.visit(child)

    def visit_Module(self, node: ast.Module) -> None:
        for stmt in node.body:
            self.visit(stmt)

    def visit_Name(self, node: ast.Name) -> None:
        if isinstance(node.ctx, ast.Load):
            self._record_read(node.id)

    def visit_Assign(self, node: ast.Assign) -> None:
        self.visit(node.value)
        for target in node.targets:
            self._visit_target(target)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        self.visit(node.annotation)
        if node.value is not None:
            self.visit(node.value)
            self._visit_target(node.target)
        elif isinstance(node.target, ast.Name) and self._cur.kind != "module":
            self._bind_name(node.target.id)

    def visit_AugAssign(self, node: ast.AugAssign) -> None:
        self.visit(node.value)
        if isinstance(node.target, ast.Name):
            self._record_read(node.target.id)
            self._bind_name(node.target.id)
        elif isinstance(node.target, (ast.Attribute, ast.Subscript)):
            self._visit_mutating_chain(node.target)

    def visit_NamedExpr(self, node: ast.NamedExpr) -> None:
        self.visit(node.value)
        self._visit_target(node.target, walrus=True)

    def visit_Delete(self, node: ast.Delete) -> None:
        for target in node.targets:
            if isinstance(target, (ast.Attribute, ast.Subscript)):
                self._visit_mutating_chain(target)
                continue
            if not isinstance(target, ast.Name):
                continue
            if self._cur.kind == "module" or target.id in self._cur.globals:
                self._record_read(target.id)
                self.defs.add(target.id)
                self.scopes[0].bound.discard(target.id)
                self.imported_modules.discard(target.id)
                self.known_modules.discard(target.id)

    def visit_For(self, node: ast.For) -> None:
        self.visit(node.iter)
        self._visit_target(node.target)
        for stmt in node.body + node.orelse:
            self.visit(stmt)

    visit_AsyncFor = visit_For

    def visit_With(self, node: ast.With) -> None:
        for item in node.items:
            self.visit(item.context_expr)
            if item.optional_vars is not None:
                self._visit_target(item.optional_vars)
        for stmt in node.body:
            self.visit(stmt)

    visit_AsyncWith = visit_With

    def visit_Try(self, node: ast.Try) -> None:
        for stmt in node.body:
            self.visit(stmt)
        for handler in node.handlers:
            self.visit(handler.type)
            if handler.name:
                self._bind_name(handler.name)
            for stmt in handler.body:
                self.visit(stmt)
        for stmt in node.orelse + node.finalbody:
            self.visit(stmt)

    visit_TryStar = visit_Try

    def visit_Match(self, node: Any) -> None:
        self.visit(node.subject)
        for case in node.cases:
            self._visit_pattern(case.pattern)
            self.visit(case.guard)
            for stmt in case.body:
                self.visit(stmt)

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            name = alias.asname or alias.name.split(".")[0]
            self._bind_name(name, is_import_module=True)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        for alias in node.names:
            if alias.name != "*":
                self._bind_name(alias.asname or alias.name)

    def _visit_func_signature(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        for expr in node.decorator_list + node.args.defaults + node.args.kw_defaults:
            self.visit(expr)
        all_args = list(node.args.posonlyargs + node.args.args + node.args.kwonlyargs)
        if node.args.vararg:
            all_args.append(node.args.vararg)
        if node.args.kwarg:
            all_args.append(node.args.kwarg)
        for arg in all_args:
            self.visit(arg.annotation)
        self.visit(node.returns)

    def visit_FunctionDef(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        self._visit_func_signature(node)
        self._bind_name(node.name)
        arg_names = _collect_arg_names(node.args)
        body_locals, globals_, nonlocals_ = _scan_scope_decls(node.body)
        scope = _Scope(
            "function",
            locals_=arg_names | body_locals,
            globals_=globals_,
            nonlocals_=nonlocals_,
        )
        scope.bound.update(arg_names)
        self.scopes.append(scope)
        try:
            for stmt in node.body:
                self.visit(stmt)
        finally:
            self.scopes.pop()

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        for expr in node.decorator_list + node.bases:
            self.visit(expr)
        for kw in node.keywords:
            self.visit(kw.value)
        self._bind_name(node.name)
        body_locals, globals_, nonlocals_ = _scan_scope_decls(node.body)
        scope = _Scope("class", locals_=body_locals, globals_=globals_, nonlocals_=nonlocals_)
        self.scopes.append(scope)
        try:
            for stmt in node.body:
                self.visit(stmt)
        finally:
            self.scopes.pop()

    def visit_Lambda(self, node: ast.Lambda) -> None:
        for default in node.args.defaults + node.args.kw_defaults:
            self.visit(default)
        arg_names = _collect_arg_names(node.args)
        scope = _Scope("lambda", locals_=arg_names)
        scope.bound.update(arg_names)
        self.scopes.append(scope)
        try:
            self.visit(node.body)
        finally:
            self.scopes.pop()

    def _visit_comprehension(
        self, generators: list[ast.comprehension], body_exprs: list[ast.AST]
    ) -> None:
        if not generators:
            for expr in body_exprs:
                self.visit(expr)
            return
        self.visit(generators[0].iter)
        self.scopes.append(_Scope("comprehension"))
        try:
            for idx, gen in enumerate(generators):
                if idx > 0:
                    self.visit(gen.iter)
                self._visit_target(gen.target)
                for cond in gen.ifs:
                    self.visit(cond)
            for expr in body_exprs:
                self.visit(expr)
        finally:
            self.scopes.pop()

    def visit_ListComp(self, node: ast.ListComp) -> None:
        self._visit_comprehension(node.generators, [node.elt])

    def visit_SetComp(self, node: ast.SetComp) -> None:
        self._visit_comprehension(node.generators, [node.elt])

    def visit_GeneratorExp(self, node: ast.GeneratorExp) -> None:
        self._visit_comprehension(node.generators, [node.elt])

    def visit_DictComp(self, node: ast.DictComp) -> None:
        self._visit_comprehension(node.generators, [node.key, node.value])

    def _is_inplace_call(self, node: ast.Call) -> bool:
        return any(
            kw.arg == "inplace"
            and isinstance(kw.value, ast.Constant)
            and kw.value.value is True
            for kw in node.keywords
        )

    def _is_module_attr_call(self, func: ast.Attribute) -> bool:
        root = _root_name(func.value)
        return (
            isinstance(func.value, ast.Name)
            and root is not None
            and root in self.known_modules
            and not self._is_bound_in_enclosing_local(root)
        )

    def visit_Call(self, node: ast.Call) -> None:
        mutating = isinstance(node.func, ast.Attribute) and (
            node.func.attr in MUTATING_METHODS or self._is_inplace_call(node)
        )
        if mutating and not self._is_module_attr_call(node.func):
            self._visit_mutating_chain(node.func)
        else:
            self.visit(node.func)
        for arg in node.args:
            self.visit(arg)
        for kw in node.keywords:
            self.visit(kw.value)

    def finalize_reads(self) -> set[str]:
        resolved_deferred = self.deferred_reads - self.scopes[0].bound
        return self.reads | resolved_deferred


def extract_cell_symbols(
    source: str,
    *,
    known_modules: set[str] | frozenset[str] = frozenset(),
) -> dict[str, Any]:
    """Parse one code cell and extract defs, reads, mutations, imported_modules."""
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return {
            "defs": [],
            "reads": [],
            "mutations": [],
            "imported_modules": [],
            "syntax_error": True,
        }
    analyzer = _CellAnalyzer(known_modules=known_modules)
    analyzer.visit(tree)
    return {
        "defs": sorted(analyzer.defs),
        "reads": sorted(analyzer.finalize_reads()),
        "mutations": sorted(analyzer.mutations),
        "imported_modules": sorted(analyzer.imported_modules),
        "syntax_error": False,
    }


def _link_cell_edges(
    entry: dict[str, Any],
    entries: list[dict[str, Any]],
    last_def: dict[str, int],
    all_definers: dict[str, list[int]],
) -> None:
    idx = entry["index"]
    for sym in entry["reads"]:
        if sym in last_def:
            src_idx = last_def[sym]
            entry["upstream"].setdefault(src_idx, []).append(sym)
            entries[src_idx]["downstream"].setdefault(idx, []).append(sym)
            continue
        later = [k for k in all_definers.get(sym, ()) if k > idx]
        if later:
            entry["late_defs"][sym] = later

    read_set = set(entry["reads"])
    for sym in entry["defs"]:
        if sym in last_def and sym not in read_set:
            entry["redefinitions"][sym] = last_def[sym]

    for sym in set(entry["defs"]) | set(entry["mutations"]):
        last_def[sym] = idx


def analyze(cells: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Analyze all cells in a notebook and construct the dataflow dependency graph."""
    if not isinstance(cells, list):
        return []
    entries: list[dict[str, Any]] = []
    known_modules: set[str] = set()

    for idx, cell in enumerate(cells):
        c = cell if isinstance(cell, dict) else {}
        cell_type = str(c.get("cell_type", "code"))
        source = _normalize_source(c.get("source", ""))
        if cell_type == "code":
            sym = extract_cell_symbols(source, known_modules=known_modules)
            if not sym["syntax_error"]:
                known_modules.difference_update(sym["defs"])
                known_modules.update(sym["imported_modules"])
        else:
            sym = {"defs": [], "reads": [], "mutations": [], "syntax_error": False}
        entries.append(
            {
                "index": idx,
                "cell_type": cell_type,
                "defs": sym["defs"],
                "reads": sym["reads"],
                "mutations": sym["mutations"],
                "upstream": {},
                "downstream": {},
                "late_defs": {},
                "redefinitions": {},
                "syntax_error": sym["syntax_error"],
                "source_hash": hash_source(source),
            }
        )

    all_definers: dict[str, list[int]] = {}
    for entry in entries:
        for sym in set(entry["defs"]) | set(entry["mutations"]):
            all_definers.setdefault(sym, []).append(entry["index"])

    last_def: dict[str, int] = {}
    for entry in entries:
        if entry["cell_type"] == "code":
            _link_cell_edges(entry, entries, last_def, all_definers)

    for entry in entries:
        entry["upstream"] = {k: sorted(v) for k, v in sorted(entry["upstream"].items())}
        entry["downstream"] = {k: sorted(v) for k, v in sorted(entry["downstream"].items())}

    return entries


def _get_exec_info(exec_state: Any, idx: int) -> dict[str, Any]:
    if isinstance(exec_state, dict):
        val = exec_state.get(idx)
        if val is None:
            val = exec_state.get(str(idx))
        return val if isinstance(val, dict) else {}
    if isinstance(exec_state, list) and 0 <= idx < len(exec_state):
        return exec_state[idx] if isinstance(exec_state[idx], dict) else {}
    return {}


def _upstream_stale_reason(
    u: int,
    symbols: list[str],
    idx: int,
    *,
    edited_stale: set[int],
    tainted: set[int],
    executed: set[int],
    exec_counts: dict[int, int | None],
) -> dict[str, Any] | None:
    u_ec = exec_counts.get(u)
    v_ec = exec_counts.get(idx)
    if u in edited_stale:
        return {"from": u, "symbols": list(symbols), "kind": "upstream_edited"}
    if u in tainted:
        return {"from": u, "symbols": list(symbols), "kind": "transitive"}
    if idx not in executed:
        return None
    if u_ec is None:
        return {"from": u, "symbols": list(symbols), "kind": "upstream_unrun"}
    if v_ec is None or u_ec > v_ec:
        return {"from": u, "symbols": list(symbols), "kind": "upstream_rerun"}
    return None


def compute_stale(
    analysis: list[dict[str, Any]],
    exec_state: dict[int, dict[str, Any]] | list[dict[str, Any]],
) -> dict[int, dict[str, Any]]:
    """Compute stale cells and human-readable staleness reasons."""
    edited_stale: set[int] = set()
    executed: set[int] = set()
    exec_counts: dict[int, int | None] = {}

    for entry in analysis:
        if entry["cell_type"] != "code":
            continue
        idx = entry["index"]
        st = _get_exec_info(exec_state, idx)
        ex_hash = st.get("executed_hash")
        ex_count = st.get("execution_count")
        exec_counts[idx] = ex_count
        if ex_hash is not None or ex_count is not None:
            executed.add(idx)
        if ex_hash is not None and entry["source_hash"] != ex_hash:
            edited_stale.add(idx)

    tainted: set[int] = set()
    stale: dict[int, dict[str, Any]] = {}

    for entry in analysis:
        if entry["cell_type"] != "code":
            continue
        idx = entry["index"]
        is_edited = idx in edited_stale
        reasons: list[dict[str, Any]] = []
        if is_edited:
            reasons.append({"from": idx, "symbols": [], "kind": "edited"})

        upstream_tainted = False
        for u, symbols in entry["upstream"].items():
            reason = _upstream_stale_reason(
                u,
                symbols,
                idx,
                edited_stale=edited_stale,
                tainted=tainted,
                executed=executed,
                exec_counts=exec_counts,
            )
            if reason is not None:
                upstream_tainted = True
                reasons.append(reason)

        if is_edited or upstream_tainted:
            tainted.add(idx)
            if idx in executed:
                stale[idx] = {"edited": is_edited, "reasons": reasons}

    return stale


def format_stale_reasons(stale_info: dict[str, Any]) -> str:
    """Format a stale_info dict into a concise human-readable reason string."""
    reasons = stale_info.get("reasons") or []
    parts: list[str] = []
    for reason in reasons:
        if reason.get("kind") == "edited":
            parts.append("edited")
            continue
        syms = ", ".join(reason.get("symbols") or [])
        src = int(reason.get("from", 0)) + 1
        parts.append(f"← #{src}: {syms}" if syms else f"← #{src}")
    return "; ".join(parts)


def _walk_slice(
    analysis: list[dict[str, Any]], start_index: int, edge_key: str
) -> list[int]:
    if not (0 <= start_index < len(analysis)):
        return []
    if analysis[start_index]["cell_type"] != "code":
        return []
    visited: set[int] = {start_index}
    queue: deque[int] = deque([start_index])
    while queue:
        cur = queue.popleft()
        for nxt in analysis[cur][edge_key]:
            if nxt not in visited and analysis[nxt]["cell_type"] == "code":
                visited.add(nxt)
                queue.append(nxt)
    return sorted(visited)


def affected_slice(analysis: list[dict[str, Any]], start_index: int) -> list[int]:
    """Return [start_index] plus all transitive downstream code cells in order."""
    return _walk_slice(analysis, start_index, "downstream")


def upstream_slice(analysis: list[dict[str, Any]], target_index: int) -> list[int]:
    """Return minimal ordered list of ancestor code cells plus target_index."""
    return _walk_slice(analysis, target_index, "upstream")


def _audit_cell(
    entry: dict[str, Any],
    exec_state: Any,
    stale_map: dict[int, dict[str, Any]],
) -> list[dict[str, Any]]:
    idx = entry["index"]
    if entry["syntax_error"]:
        return [
            {
                "kind": "syntax_error",
                "cell": idx,
                "related": None,
                "symbols": [],
                "message": f"Cell #{idx + 1} has a Python syntax error",
            }
        ]

    issues: list[dict[str, Any]] = []
    v_ec = _get_exec_info(exec_state, idx).get("execution_count")

    if idx in stale_map:
        info = stale_map[idx]
        summary = format_stale_reasons(info) or "stale"
        issues.append(
            {
                "kind": "stale",
                "cell": idx,
                "related": info["reasons"][0]["from"] if info["reasons"] else None,
                "symbols": sorted({s for r in info["reasons"] for s in r["symbols"]}),
                "message": f"Cell #{idx + 1} is stale: {summary}",
            }
        )

    for u, symbols in entry["upstream"].items():
        u_ec = _get_exec_info(exec_state, u).get("execution_count")
        if v_ec is not None and u_ec is not None and u_ec > v_ec:
            issues.append(
                {
                    "kind": "out_of_order",
                    "cell": idx,
                    "related": u,
                    "symbols": list(symbols),
                    "message": (
                        f"Cell #{idx + 1} [{v_ec}] ran before upstream "
                        f"cell #{u + 1} [{u_ec}] ({', '.join(symbols)})"
                    ),
                }
            )
        elif v_ec is not None and u_ec is None:
            issues.append(
                {
                    "kind": "unrun_dependency",
                    "cell": idx,
                    "related": u,
                    "symbols": list(symbols),
                    "message": (
                        f"Cell #{idx + 1} [{v_ec}] depends on unrun "
                        f"cell #{u + 1} ({', '.join(symbols)})"
                    ),
                }
            )

    for sym, later_cells in sorted(entry["late_defs"].items()):
        first_later = later_cells[0]
        issues.append(
            {
                "kind": "late_definition",
                "cell": idx,
                "related": first_later,
                "symbols": [sym],
                "message": (
                    f"Cell #{idx + 1} reads '{sym}' before it is defined "
                    f"in cell #{first_later + 1}"
                ),
            }
        )

    for sym, prev_idx in sorted(entry["redefinitions"].items()):
        issues.append(
            {
                "kind": "redefinition",
                "cell": idx,
                "related": prev_idx,
                "symbols": [sym],
                "message": (
                    f"Cell #{idx + 1} redefines '{sym}' "
                    f"(previously defined in cell #{prev_idx + 1})"
                ),
            }
        )

    return issues


def audit(
    analysis: list[dict[str, Any]],
    exec_state: dict[int, dict[str, Any]] | list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Audit notebook for reproducibility issues."""
    stale_map = compute_stale(analysis, exec_state)
    issues: list[dict[str, Any]] = []
    for entry in analysis:
        if entry["cell_type"] == "code":
            issues.extend(_audit_cell(entry, exec_state, stale_map))
    return issues
