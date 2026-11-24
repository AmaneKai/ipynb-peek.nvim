--- Statusline component for lualine / heirline / plain 'statusline'.
local session = require("ipynb-peek.session")
local runtime = require("ipynb-peek.runtime")

local M = {}

local uv = vim.uv or vim.loop
local redraw_timer = nil

--- Pure formatting. `state`: { active, name, running, busy_ms, stale_count }.
function M.format(state)
  if not state.active then
    return ""
  end
  local name = state.name or "kernel"
  if state.busy_ms ~= nil then
    return string.format("● %s (busy: %.1fs)", name, state.busy_ms / 1000)
  end
  local stale = state.stale_count or 0
  local stale_suffix = stale > 0 and string.format(", %d stale", stale) or ""
  if state.running then
    return string.format("○ %s (idle%s)", name, stale_suffix)
  end
  return string.format("◌ %s (not started%s)", name, stale_suffix)
end

local function stop_timer(timer)
  if timer and not timer:is_closing() then
    timer:stop()
    timer:close()
  end
  if redraw_timer == timer then
    redraw_timer = nil
  end
end

local function ensure_redraw_timer(busy)
  if busy and not redraw_timer then
    local timer = uv.new_timer()
    redraw_timer = timer
    timer:start(1000, 1000, function()
      vim.schedule(function()
        if not timer or timer:is_closing() then
          return
        end
        if runtime.busy() == nil or not session.is_active() then
          stop_timer(timer)
        end
        vim.cmd.redrawstatus()
      end)
    end)
  elseif not busy and redraw_timer then
    stop_timer(redraw_timer)
  end
end

function M.kernel_status()
  local active = session.is_active()
  local _, busy_ms = runtime.busy()
  ensure_redraw_timer(active and busy_ms ~= nil)
  return M.format({
    active = active,
    name = runtime.kernel.name,
    running = runtime.kernel.running,
    busy_ms = busy_ms,
    stale_count = runtime.stale_count(),
  })
end

function M.is_active()
  return session.is_active()
end

return M
