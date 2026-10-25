--- Statusline component for lualine / heirline / a plain 'statusline':
---
---   require("lualine").setup({
---     sections = { lualine_x = { require("ipynb-peek.statusline").kernel_status } },
---   })
---
--- Returns "" when no preview is open, so it can sit in a section unconditionally.
local session = require("ipynb-peek.session")
local runtime = require("ipynb-peek.runtime")

local M = {}

local uv = vim.uv or vim.loop
local redraw_timer = nil

--- Pure formatting. `state`: { active, name, running, busy_ms (nil = idle) }.
function M.format(state)
  if not state.active then
    return ""
  end
  local name = state.name or "kernel"
  if state.busy_ms ~= nil then
    return string.format("● %s (busy: %.1fs)", name, state.busy_ms / 1000)
  end
  if state.running then
    return string.format("○ %s (idle)", name)
  end
  return string.format("◌ %s (not started)", name)
end

--- While a cell runs, the elapsed time should tick; statuslines only redraw on
--- events, so nudge them once a second until the kernel goes idle.
local function ensure_redraw_timer(busy)
  if busy and not redraw_timer then
    redraw_timer = uv.new_timer()
    redraw_timer:start(1000, 1000, function()
      vim.schedule(function()
        if runtime.busy() == nil then
          redraw_timer:stop()
          redraw_timer:close()
          redraw_timer = nil
        end
        vim.cmd.redrawstatus()
      end)
    end)
  end
end

function M.kernel_status()
  local _, busy_ms = runtime.busy()
  ensure_redraw_timer(busy_ms ~= nil)
  return M.format({
    active = session.is_active(),
    name = runtime.kernel.name,
    running = runtime.kernel.running,
    busy_ms = busy_ms,
  })
end

--- For lualine's `cond`: only show the component while a preview is active.
function M.is_active()
  return session.is_active()
end

return M
