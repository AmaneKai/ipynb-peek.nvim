local M = {}
local health = vim.health
local server = require("ipynb-peek.server")

local function get_config()
  local ok, plugin = pcall(require, "ipynb-peek")
  return ok and plugin.config or {}
end

local function check_python(cfg)
  local py = server.find_python(cfg.python)
  if not py then
    health.error("python3 not found on PATH", {
      "Install Python 3 or set `python = '/path/to/python3'` in setup()",
    })
    return nil
  end
  local ver = vim.trim(vim.fn.system({ py, "--version" }))
  if vim.v.shell_error ~= 0 then
    health.error("configured Python executable failed: " .. py)
    return nil
  end
  health.ok("Python found: " .. py .. " (" .. ver .. ")")
  return py
end

local function check_python_packages(py)
  local probe = [[
import json
res = {}
for mod in ("jupyter_client", "ipykernel", "pygments", "latex2mathml"):
    try:
        __import__(mod)
        res[mod] = True
    except Exception:
        res[mod] = False
res["kernels"] = []
if res["jupyter_client"]:
    try:
        from jupyter_client.kernelspec import KernelSpecManager
        res["kernels"] = sorted(KernelSpecManager().find_kernel_specs().keys())
    except Exception:
        pass
print(json.dumps(res))
]]
  local out = vim.fn.system({ py, "-c", probe })
  if vim.v.shell_error ~= 0 then
    health.warn("failed to inspect Python environment packages")
    return
  end
  local ok, info = pcall(vim.json.decode, out)
  if not ok or type(info) ~= "table" then
    health.warn("unexpected output probing Python environment")
    return
  end

  if info.jupyter_client then
    health.ok("jupyter_client is installed")
  else
    health.warn("jupyter_client not found in " .. py, {
      "Preview & AST DAG work without it, but code execution requires jupyter_client + ipykernel",
      "Install in your environment: pip install ipykernel",
    })
  end

  if info.ipykernel then
    health.ok("ipykernel is installed")
  else
    health.info(
      "ipykernel not found in " .. py .. " (needed to run Python kernels from this env)"
    )
  end

  if type(info.kernels) == "table" and #info.kernels > 0 then
    health.ok(#info.kernels .. " Jupyter kernel(s) available: " .. table.concat(info.kernels, ", "))
  elseif info.jupyter_client then
    health.warn("no Jupyter kernelspecs found", {
      "Register a kernel: " .. py .. " -m ipykernel install --user",
    })
  end

  if info.pygments then
    health.ok("pygments is installed (syntax highlighting enabled)")
  else
    health.info("pygments not installed (optional; preview falls back to plain-text code blocks)")
  end

  if info.latex2mathml then
    health.ok("latex2mathml is installed (native MathML rendering enabled)")
  else
    health.info("latex2mathml not installed (optional; preview falls back to styled TeX)")
  end
end

local function check_browser(cfg)
  local pref = cfg.browser
  if pref == false then
    health.ok(
      "browser = false (headless / SSH mode: URL is notified instead of opening a browser)"
    )
  elseif pref == nil or pref == "default" then
    health.ok('browser = "default" (opens preview via vim.ui.open)')
  elseif type(pref) == "table" and type(pref[1]) == "string" then
    if vim.fn.executable(pref[1]) == 1 then
      health.ok("custom browser command found: " .. pref[1])
    else
      health.error("configured browser executable not found on PATH: " .. pref[1])
    end
  else
    health.warn("unrecognized `browser` config value: " .. vim.inspect(pref), {
      'Use "default", a command table like { "surf" }, or false for headless mode',
    })
  end
end

function M.check()
  health.start("ipynb-peek")
  local cfg = get_config()
  local py = check_python(cfg)
  if py then
    check_python_packages(py)
  end
  check_browser(cfg)
end

return M
