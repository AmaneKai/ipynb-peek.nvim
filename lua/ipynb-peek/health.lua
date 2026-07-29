local M = {}
local health = vim.health

local function exe(name)
  return vim.fn.executable(name) == 1
end

local function check_jupytext_loaded()
  if vim.g.loaded_jupytext == 1 then
    health.ok("jupytext.vim is loaded")
  else
    health.error("jupytext.vim not detected (g:loaded_jupytext unset)", {
      "ipynb-peek requires goerz/jupytext.vim - "
        .. "install it and ensure it loads before opening .ipynb files",
    })
  end
end

--- Without this set to a percent format before jupytext.vim loads, jupytext
--- defaults to Markdown (or another format) instead of `# %%`, and every
--- cell parser in this plugin silently finds zero cells - no error
--- anywhere, things just quietly do nothing.
local function check_jupytext_format()
  local fmt = vim.g.jupytext_fmt
  if type(fmt) == "string" and fmt:find("percent") then
    health.ok("vim.g.jupytext_fmt is set to a percent format (" .. fmt .. ")")
  else
    health.error(
      "vim.g.jupytext_fmt is not set to a percent (`# %%`) format (currently: "
        .. vim.inspect(fmt)
        .. ")",
      {
        "Set `vim.g.jupytext_fmt = \"py:percent\"` before jupytext.vim loads - "
          .. "without this, ipynb-peek will silently find zero cells in every notebook",
      }
    )
  end
end

local function check_external_binaries()
  for _, binary in ipairs({ "node", "curl" }) do
    if exe(binary) then
      health.ok(binary .. " found on PATH")
    else
      health.error(
        binary .. " not found on PATH",
        { "Install " .. binary .. " and ensure it is on your PATH" }
      )
    end
  end
end

local function check_jupyter_kernels()
  if not exe("jupyter") then
    health.error(
      "jupyter not found on PATH",
      { "Install jupyter + ipykernel in the Python environment you intend to use" }
    )
    return
  end

  health.ok("jupyter found on PATH")
  local out = vim.fn.system({ "jupyter", "kernelspec", "list", "--json" })
  if vim.v.shell_error ~= 0 then
    health.warn("`jupyter kernelspec list` failed", { "Check your jupyter/ipykernel installation" })
    return
  end

  local ok, decoded = pcall(vim.json.decode, out)
  local count = ok and decoded.kernelspecs and vim.tbl_count(decoded.kernelspecs) or 0
  if count > 0 then
    health.ok(count .. " Jupyter kernel(s) available")
  else
    health.warn("jupyter is installed but no kernelspecs were found", {
      "Install ipykernel and register a kernel: python -m ipykernel install --user",
    })
  end
end

local function check_browser()
  local browser = require("ipynb-peek.browser").find()
  if browser then
    health.ok(
      "Chromium-based browser found (" .. (browser.name or browser.binary or browser.path) .. ")"
    )
  else
    health.warn("No supported Chromium-based browser found", {
      "ipynb-peek will fall back to opening a normal browser tab instead of an app-mode popup",
    })
  end
end

local function check_linux_popup_close_tools()
  if vim.fn.has("linux") ~= 1 then
    return
  end
  if exe("xdotool") or exe("wmctrl") then
    health.ok("xdotool/wmctrl found - popup auto-close should work")
  else
    health.warn("Neither xdotool nor wmctrl found", {
      "The preview popup won't auto-close when the notebook buffer closes; "
        .. "install xdotool or wmctrl if you want that",
    })
  end
end

local function check_build_step()
  local server_dir = require("ipynb-peek").config.server_dir
  if vim.fn.isdirectory(server_dir .. "/node_modules") == 1 then
    health.ok("server/node_modules present (build step has run)")
  else
    health.error("server/node_modules missing", {
      "Run the plugin's build step (e.g. `:Lazy build ipynb-peek.nvim` for lazy.nvim), "
        .. "or manually: cd "
        .. server_dir
        .. " && npm install",
    })
  end
end

function M.check()
  health.start("ipynb-peek")
  check_jupytext_loaded()
  check_jupytext_format()
  check_external_binaries()
  check_jupyter_kernels()
  check_browser()
  check_linux_popup_close_tools()
  check_build_step()
end

return M
