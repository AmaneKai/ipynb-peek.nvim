# ipynb-peek.nvim

Edit `.ipynb` notebooks in Neovim like normal text files, and watch a live, VS Code-Jupyter-style preview update as you type - complete with real code execution against a Jupyter kernel, without ever leaving Neovim.

Neovim isn't a great place to *look at* a notebook - cell outputs, images, rendered markdown, and execution state don't really exist in a text buffer. But it's a great place to *write* one. ipynb-peek keeps you writing in Neovim and hands the "looking at it" part to a small popup browser window that stays in sync with your buffer in real time: type a line of Python, see it highlighted instantly; write a markdown heading, see it rendered instantly; run a cell, watch its output stream in live with a running timer, exactly like VS Code's own Jupyter extension.

## Features

- **Live preview, not render-on-save.** Every keystroke - code or markdown - updates the popup immediately (debounced, not literally per-character), the same live feeling as `peek.nvim` gives you for plain markdown, but for full notebooks.
- **Cursor-following scroll-sync.** Move around your buffer in normal mode and the preview scrolls to keep the matching cell in view.
- **Real code execution.** `:IpynbPeekRunCell` / `:IpynbPeekRunAll` run against an actual `ipykernel` process - the notebook's own kernel, in its own venv, with its own working directory (relative paths like `../data/foo.csv` resolve exactly like they would in Jupyter or VS Code). Output streams in live, cell by cell, with a running execution timer while it's working and a final "ran in 1.2s" once it's done.
- **Run cell and advance.** `:IpynbPeekRunCellAndAdvance` (VS Code's Shift+Enter) runs the current cell and moves your cursor straight to the next one.
- **In-buffer status, not just in the popup.** Every cell's `# %%` marker line gets a sign-column icon (● busy, ✓ success, ✗ error) plus `[n] 1.2s` virtual text - so you know a cell finished or errored without ever looking away from the buffer you're typing in. Toggle with `inline_status`.
- **Interrupt, not just restart.** `:IpynbPeekInterruptKernel` stops whatever's currently running (`SIGINT`, same as Jupyter's own interrupt) without killing the kernel - your variables and imports survive, unlike a full restart.
- **Cell insert/delete from the preview.** Hover between cells for "+ Code" / "+ Markdown" buttons, or hover a cell for a delete button - both land as real edits in your Neovim buffer (a genuine `# %%` block gets inserted or removed), not something trapped in the browser.
- **Click-to-zoom images.** Plot output too small to read? Click it for a full-size overlay.
- **Kernel restart on demand**, for the moment you `pip install`/`uv pip install` something new and the running kernel hasn't picked it up yet.
- **Chromeless popup**, not a browser tab cluttering your normal browsing - a dedicated app-mode window, sized and positioned however you like.

## Prerequisites

- **Neovim 0.10+** (uses `vim.system`)
- **[jupytext.vim](https://github.com/goerz/jupytext.vim)** - hard dependency. This plugin converts `.ipynb` buffers into a `# %%`-delimited Python view; ipynb-peek reads and writes that view directly. Without it, opening a `.ipynb` file just shows raw JSON and nothing here will work. See [Dependency setup](#dependency-setup) below for exact install steps.
- **[bun](https://bun.sh)** - runs the preview server
- **[node](https://nodejs.org)** - runs the kernel bridge (see [How it works](#how-it-works) for why this is separate from bun)
- **curl** - used for the Neovim-server HTTP/event channel
- **jupyter + ipykernel**, with at least one registered kernel
- A Chromium-based browser (Chrome, Brave, Edge, or Chromium) - optional. This is only needed for the chromeless "app mode" popup window; `--app=<url>` is a Chromium-specific flag with no real Firefox/Safari equivalent. Without one, ipynb-peek opens the preview as a normal tab in your default browser instead - everything else (live sync, execution, cell insert/delete, all of it) works identically either way, you just get browser chrome around it instead of a floating window.

Run `:checkhealth ipynb-peek` any time to check all of the above.

## Dependency setup

Pick your OS below. After installing everything here, skip to [Installation](#installation) for the actual plugin.

### macOS

```sh
# Neovim, node, curl (curl ships with macOS already)
brew install neovim node

# bun
curl -fsSL https://bun.sh/install | bash

# jupyter + ipykernel
pip3 install --user jupyter ipykernel

# a Chromium-based browser (skip if you already have one)
brew install --cask google-chrome
```

### Windows

Run in PowerShell:

```powershell
# Neovim, node
winget install Neovim.Neovim
winget install OpenJS.NodeJS.LTS

# bun
powershell -c "irm bun.sh/install.ps1 | iex"

# curl - already included on Windows 10/11; if missing:
winget install cURL.cURL

# jupyter + ipykernel (requires Python; installs it if missing)
winget install Python.Python.3.12
pip install --user jupyter ipykernel

# a Chromium-based browser (skip if you already have one - Edge counts)
winget install Google.Chrome
```

### Linux - Debian / Ubuntu (`apt`)

```sh
# curl, node
sudo apt update
sudo apt install curl nodejs npm

# Neovim - Ubuntu/Debian's apt package is often too old for the 0.10+
# requirement; the PPA (Ubuntu) or a manual AppImage/tarball (Debian) gets
# you a current version
sudo add-apt-repository ppa:neovim-ppa/unstable
sudo apt update
sudo apt install neovim

# bun
curl -fsSL https://bun.sh/install | bash

# jupyter + ipykernel
sudo apt install python3-pip
pip3 install --user jupyter ipykernel

# a Chromium-based browser (skip if you already have one)
sudo apt install chromium
```

### Linux - Fedora (`dnf`)

```sh
# Neovim, curl, node
sudo dnf install neovim curl nodejs

# bun
curl -fsSL https://bun.sh/install | bash

# jupyter + ipykernel
sudo dnf install python3-pip
pip3 install --user jupyter ipykernel

# a Chromium-based browser (skip if you already have one) - Google Chrome
# itself needs Google's repo added first; Chromium is in Fedora's repos
# directly and is the simpler path
sudo dnf install chromium
```

### Linux - Arch (`pacman`)

```sh
# Neovim, curl, node
sudo pacman -S neovim curl nodejs npm

# bun
curl -fsSL https://bun.sh/install | bash

# jupyter + ipykernel
sudo pacman -S python-pip
pip install --user jupyter ipykernel

# a Chromium-based browser (skip if you already have one)
sudo pacman -S chromium
```

### jupytext.vim (all platforms)

This is a Neovim plugin, not a system package - install it the same way regardless of OS, through whatever plugin manager you use. With lazy.nvim:

```lua
{
  "goerz/jupytext.vim",
  init = function()
    vim.g.jupytext_fmt = "py:percent"
  end,
}
```

> [!IMPORTANT]
> That `vim.g.jupytext_fmt = "py:percent"` line is required, not optional - see the callout in [Prerequisites](#prerequisites) above for exactly why.

## Installation

### lazy.nvim

```lua
{
  "AmaneKai/ipynb-peek.nvim",
  build = "cd server && bun install",
  -- event, not just cmd: loads as soon as you open a .ipynb file, so the
  -- default keymaps (<leader>jo etc.) work without typing a command first.
  -- jupytext.vim reads .ipynb via BufReadCmd, which suppresses the normal
  -- BufReadPre/BufReadPost/BufNewFile firing for that read - BufEnter is
  -- what reliably fires instead.
  event = { "BufEnter *.ipynb", "BufWinEnter *.ipynb" },
  cmd = {
    "IpynbPeekOpen",
    "IpynbPeekClose",
    "IpynbPeekRunCell",
    "IpynbPeekRunCellAndAdvance",
    "IpynbPeekRunAll",
    "IpynbPeekRestartKernel",
    "IpynbPeekInterruptKernel",
  },
  config = function()
    require("ipynb-peek").setup({
      -- see Configuration below
    })
  end,
}
```

### packer.nvim

```lua
use({
  "AmaneKai/ipynb-peek.nvim",
  run = "cd server && bun install",
  event = { "BufEnter *.ipynb", "BufWinEnter *.ipynb" },
  cmd = {
    "IpynbPeekOpen",
    "IpynbPeekClose",
    "IpynbPeekRunCell",
    "IpynbPeekRunCellAndAdvance",
    "IpynbPeekRunAll",
    "IpynbPeekRestartKernel",
    "IpynbPeekInterruptKernel",
  },
  config = function()
    require("ipynb-peek").setup()
  end,
})
```

### vim-plug

```vim
Plug 'AmaneKai/ipynb-peek.nvim', { 'do': 'cd server && bun install' }
```

Then in your Lua config:

```lua
require("ipynb-peek").setup()
```

### Manual install

Whatever manager you use, the build step is the same shell command run from wherever the plugin was installed:

```sh
cd <plugin-install-dir>/server && bun install
```

If your plugin manager's automatic build hook doesn't fire (or you deleted `server/node_modules` and need to reinstall), run this manually. `:checkhealth ipynb-peek` will tell you if this step is missing.

## Configuration

All fields are optional; shown values are the defaults.

```lua
require("ipynb-peek").setup({
  -- Absolute path to the server/ directory. Self-discovered from the
  -- plugin's own install location - only override if running the server
  -- from somewhere nonstandard.
  server_dir = nil,

  -- Debounce delays, in milliseconds.
  debounce_ms = 60,         -- full re-render on save (BufWritePost)
  cursor_debounce_ms = 50,  -- cursor-position scroll-sync
  sync_debounce_ms = 150,   -- live-typing sync (TextChanged/TextChangedI)

  -- Popup window size and position (top-left corner).
  window = { width = 900, height = 1000 },
  position = { x = 40, y = 40 },

  -- Sign-column icon + "[n] 1.2s" virtual text on each cell's marker line
  -- showing its execution status. Set to false if you find it noisy.
  inline_status = true,

  -- Keymaps, buffer-local, set as soon as you open a .ipynb file (not just
  -- after the preview is running). Set any entry to `false` to disable it -
  -- the corresponding command keeps working either way.
  keymaps = {
    open = "<leader>jo",
    close = "<leader>jc",
    run_cell = "<leader>jr",
    run_cell_advance = "<leader>jn",
    run_all = "<leader>jR",
    restart_kernel = "<leader>jK",
    interrupt_kernel = "<leader>ji",
  },
})
```

## Commands

| Command | Description |
| --- | --- |
| `:IpynbPeekOpen` | Start the preview server and popup for the current notebook |
| `:IpynbPeekClose` | Stop the server (and best-effort close the popup) |
| `:IpynbPeekRunCell` | Run the code cell under the cursor |
| `:IpynbPeekRunCellAndAdvance` | Run the current cell and move the cursor to the next one |
| `:IpynbPeekRunAll` | Run every code cell, top to bottom, in order |
| `:IpynbPeekRestartKernel` | Kill and restart the kernel (loses all variables/state) |
| `:IpynbPeekInterruptKernel` | Stop whatever's currently running, keeping the kernel's state intact - POSIX only, see [Troubleshooting](#troubleshooting) |

## Default keymaps

Buffer-local, set as soon as you open a `.ipynb` file:

| Keymap | Action |
| --- | --- |
| `<leader>jo` | Open preview |
| `<leader>jc` | Close preview |
| `<leader>jr` | Run cell under cursor |
| `<leader>jn` | Run cell and advance to the next one |
| `<leader>jR` | Run all cells |
| `<leader>jK` | Restart kernel |
| `<leader>ji` | Interrupt kernel |

Override or disable any of these via `setup({ keymaps = { ... } })` - see [Configuration](#configuration).

## How it works

Opening a `.ipynb` file with jupytext.vim active converts the buffer into a `# %%`-delimited Python view, not raw notebook JSON - ipynb-peek's own cell parser reads and writes that view directly for everything except the authoritative full re-render on save (which reads the real `.ipynb` JSON jupytext writes to disk).

A Bun server handles the HTTP/WebSocket connection to the preview page. Actually running code needs to speak the real Jupyter wire protocol over ZeroMQ to an `ipykernel` process - but Bun's runtime currently crashes when the native `zeromq` binding loads ([a known upstream limitation](https://github.com/oven-sh/bun/issues/18546)), so a small Node.js child process owns that connection instead, relaying messages to the Bun server over stdio. This is why both `bun` and `node` are required, not just one.

## Troubleshooting

**Nothing happens when I run a cell / open the preview / do anything at all, with no error.** Almost always `vim.g.jupytext_fmt` isn't set to a percent format - see the callout under [Prerequisites](#prerequisites). Run `:checkhealth ipynb-peek`, which checks this specifically.

**Why is there both a `bun` and a `node` process running?** See [How it works](#how-it-works) above - this is expected, not a bug.

**My kernel isn't seeing a package I just installed (`pip install` / `uv pip install`).** A running kernel process doesn't pick up newly installed packages. Run `:IpynbPeekRestartKernel` after installing something new into the notebook's venv.

**`:IpynbPeekInterruptKernel` says interrupt isn't supported.** Windows has no real POSIX signals - sending one would silently kill the kernel process rather than interrupt it, leaving the plugin unable to recover without a manual restart. Rather than risk that, it refuses on Windows and tells you to use `:IpynbPeekRestartKernel` instead (loses kernel state, unlike a real interrupt). Interrupt works normally on macOS/Linux.

**The preview popup doesn't close when I close the notebook.** This is a best-effort feature and its reliability varies by platform - macOS needs Automation permission granted to your terminal/Neovim; Linux needs `xdotool` or `wmctrl` installed; Windows support is newer and less tested. Run `:checkhealth ipynb-peek` to see what's missing. The server itself always stops correctly regardless.

**Something's not working and I don't know why.** Run `:checkhealth ipynb-peek` first - this plugin has a larger-than-usual set of external dependencies (jupytext.vim, bun, node, jupyter/ipykernel, a browser, curl), and the health check is the fastest way to find out which one is the problem.

**`server/node_modules missing` in `:checkhealth`.** The build step hasn't run. For lazy.nvim, run `:Lazy build ipynb-peek.nvim`; otherwise run the manual install command from [Installation](#installation) above.

## Development

There are two test suites - one for the Lua plugin, one for the Bun server:

```sh
make test        # both
make testlua      # lua/ - plenary.nvim, headless Neovim
make testserver   # server/ - bun test
```

`make testlua` vendors a throwaway `plenary.nvim` clone into `.tests/` (gitignored) if one isn't already on your machine, so it works the same locally and in CI. Both suites run on every push/PR via GitHub Actions (`.github/workflows/ci.yml`).

The Lua tests cover `cells.lua`'s buffer parsing directly against real scratch buffers, plus `status.lua`'s pure icon/virtual-text formatting for the in-buffer status signs. The server tests cover the pure notebook-rendering/merge/sync logic (`notebook.ts`), the Jupyter iopub message handling (`iopub.ts`), the wire-protocol framing (`wire-protocol.mjs`), and the HTTP routing layer against a real server instance on a random port. Deliberately not covered by CI: anything that needs a live Jupyter kernel or a real browser popup - those are exercised by hand against a real kernel before a release, not automated.

## License

MIT - see [LICENSE](LICENSE).
