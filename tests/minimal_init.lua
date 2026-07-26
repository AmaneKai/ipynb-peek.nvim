--- Standalone `nvim -u` entrypoint for running the plenary.nvim test suite,
--- independent of any plugin manager or personal Neovim config. Looks for a
--- CI-vendored plenary.nvim first (see Makefile), falling back to a local
--- lazy.nvim install for convenience when running tests during development.
local function repo_root()
  local source = debug.getinfo(1, "S").source
  local file = source:match("^@(.*)$") or source
  return vim.fn.fnamemodify(file, ":h:h")
end

local root = repo_root()
local vendored_plenary = root .. "/.tests/plenary.nvim"
local plenary_dir = vim.fn.isdirectory(vendored_plenary) == 1 and vendored_plenary
  or vim.fn.expand("~/.local/share/nvim/lazy/plenary.nvim")

if vim.fn.isdirectory(plenary_dir) == 0 then
  error("plenary.nvim not found - run `make testdeps` or install it via your plugin manager")
end

vim.opt.rtp:append(plenary_dir)
vim.opt.rtp:append(root)
vim.cmd("runtime plugin/plenary.vim")
