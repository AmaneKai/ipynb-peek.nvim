# ipynb-peek.nvim

Zero-bloat, single-plugin Neovim `.ipynb` runner, live SSR preview, and static Python AST dataflow/stale-cell engine — engineered to run smoothly on 15-year-old hardware (2 GB RAM, dual-core CPU, no WebGL, any terminal).

- **Zero Node.js / npm / bundlers** — pure Lua + Python 3 stdlib backend.
- **Zero Neovim runtime dependencies** — native pure-Lua `.ipynb` ↔ `# %%` `BufReadCmd`/`BufWriteCmd` (no `jupytext.vim` or `jupytext` CLI).
- **Zero extra Python packages** — uses Python 3 stdlib + the `jupyter_client`/`ipykernel` you already have (optional `pygments` & `latex2mathml` with clean built-in fallbacks).
- **Featherweight frontend (< 2 KB vanilla JS)** — Server-Sent Events (`EventSource`) + server-side rendered HTML + CSS `prefers-color-scheme` and `@media print`.
- **Static AST stale-cell & DAG engine** — highlights stale cells live as you type, clears staleness automatically on undo, runs minimal upstream/downstream slices, and audits notebooks for out-of-order execution.

## Installation

### lazy.nvim

```lua
{ "AmaneKai/ipynb-peek.nvim", opts = {} }
```

No build step, no external plugin dependencies, no `node_modules`.

## Architecture

```text
  ┌──────────────────────────┐        stdio NDJSON        ┌──────────────────────────────┐
  │         Neovim           │ ◄────────────────────────► │      python/server.py        │
  │                          │                            │  ThreadingHTTPServer + SSE   │
  │  ipynb.lua (BufReadCmd / │  render / sync / execute   │  dag.py   (AST dataflow)     │
  │             BufWriteCmd) │  dag_query / export        │  render.py (SSR HTML/MD)     │
  │  cells.lua / status.lua  │  cell_outputs / dag_status │  jupyter_client (lazy)       │
  └──────────────────────────┘                            └──────────────┬───────────────┘
                                                                         │ SSE + SSR HTML
                                                                         ▼
                                                                Any browser (<2 KB JS)
```

## Configuration

All fields are optional; defaults shown below:

```lua
require("ipynb-peek").setup({
  python = nil,              -- explicit Python binary path (defaults to python3 / python)
  debounce_ms = 60,
  cursor_debounce_ms = 50,
  sync_debounce_ms = 150,
  startup_timeout_ms = 10000,
  inline_status = true,      -- sign-column icons (● ✓ ✗ ~) + virtual text ("[2] 0.4s  ⚠ stale (← #1: lr)")
  browser = "default",       -- "default" (vim.ui.open), { "surf" } (custom command), or false (headless/SSH)
  text_objects = {},         -- false to disable; defaults: ic/ac, ]c/[c, ]e/[e, ]s/[s
  keymaps = {
    open = "<leader>jo",
    close = "<leader>jc",
    run_cell = "<leader>jr",
    run_cell_advance = "<leader>jn",
    run_all = "<leader>jR",
    run_affected = "<leader>ja",
    run_slice = "<leader>js",
    deps = "<leader>jd",
    audit = "<leader>jA",
    restart_kernel = "<leader>jK",
    interrupt_kernel = "<leader>ji",
    next_cell = "<leader>jj",
    prev_cell = "<leader>jk",
    goto_cell = "<leader>jg",
  },
})
```

## Commands & Motions

| Command | Default Keymap | Description |
| --- | --- | --- |
| `:IpynbPeekOpen` | `<leader>jo` | Start the Python preview server and open preview |
| `:IpynbPeekClose` | `<leader>jc` | Stop the preview server and kernel cleanly |
| `:IpynbPeekRunCell` | `<leader>jr` | Execute the code cell under the cursor |
| `:IpynbPeekRunCellAndAdvance` | `<leader>jn` | Execute current cell and advance to next cell |
| `:IpynbPeekRunAll` | `<leader>jR` | Run all code cells top-to-bottom (skips `tags=["skip-run-all"]`) |
| `:IpynbPeekRunAffected` | `<leader>ja` | Run current cell plus all transitive downstream dependents |
| `:IpynbPeekRunSlice` | `<leader>js` | Run the minimal upstream dependency slice for the current cell |
| `:IpynbPeekDeps` | `<leader>jd` | Inspect upstream producers & downstream consumers (`<CR>` jumps) |
| `:IpynbPeekAudit` | `<leader>jA` | Audit reproducibility (stale, out-of-order, unrun deps, late defs) |
| `:IpynbPeekRestartKernel` | `<leader>jK` | Restart the Jupyter kernel |
| `:IpynbPeekInterruptKernel` | `<leader>ji` | Interrupt the running execution |
| `:IpynbPeekNextCodeCell` | `<leader>jj` | Jump to next code cell (accepts count) |
| `:IpynbPeekPreviousCodeCell` | `<leader>jk` | Jump to previous code cell (accepts count) |
| `:IpynbPeekGotoCell [n]` | `<leader>jg` | Jump to 1-based cell number |
| `:IpynbPeekOutline` | — | Floating outline of headings & code cells with status/stale icons |
| `:IpynbPeekVariables` | — | Floating table of kernel variables |
| `:IpynbPeekSelectKernel` | — | Switch Jupyter kernel via `vim.ui.select` |
| `:IpynbPeekExport {html\|report\|pdf} [path]` | — | Export standalone HTML/report directly from Python or open print dialog |

### Cell Text-Objects & Motions

- `ic` / `ac` — inside / around current cell
- `]c` / `[c` — next / previous cell marker
- `]e` / `[e` — next / previous errored cell
- `]s` / `[s` — next / previous stale cell

### Statusline

```lua
require("lualine").setup({
  sections = {
    lualine_x = {
      { require("ipynb-peek.statusline").kernel_status, cond = require("ipynb-peek.statusline").is_active },
    },
  },
})
```

Displays `● python3 (busy: 2.1s)`, `○ python3 (idle)`, `○ python3 (idle, 2 stale)`, or `◌ python3 (not started)`.

## Honest Limitations of Static AST Analysis

`python/dag.py` uses Python's stdlib `ast` module with full lexical scoping (functions, classes, closures, `global`, comprehensions, imports, and common in-place mutations including `inplace=True`). Because analysis is static and zero-overhead:

- Dynamic bindings (`exec`, `eval`, `globals()[k] = v`, `from mod import *`) cannot be resolved statically.
- External side effects (files written to disk, database mutations, RNG state, environment variables) are not tracked as symbol edges.
- Aliased object references (`b = a; b.append(1)`) attribute the mutation to `b`, not `a`.

When you need a guaranteed clean-slate check, run `:IpynbPeekRestartKernel` + `:IpynbPeekRunAll`.

## Development & Tests

```sh
make testlua   # Neovim headless plenary.nvim tests
make testpy    # Python stdlib unit & HTTP/SSE/stdio tests
make teste2e   # Real ipykernel end-to-end execution + DAG tests
```

## License

MIT - see [LICENSE](LICENSE).
