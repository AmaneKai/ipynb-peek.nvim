--- What the server last told us about execution state, kept apart from the
--- session lifecycle (session.lua) and the buffer so the text-objects,
--- outline, and statusline can all read it without touching init.lua's
--- internals. Pure data: no buffers, processes, or timers.
local M = {}

local uv = vim.uv or vim.loop

--- 0-based cell index -> { status, execution_count, duration_ms, has_error }
M.cells = {}
--- 0-based cell index -> uv.now() when it was last seen turning busy
M.busy_since = {}
--- { name = string|nil, running = boolean }
M.kernel = { name = nil, running = false }

function M.reset()
  M.cells = {}
  M.busy_since = {}
  M.kernel = { name = nil, running = false }
end

function M.set_cell(info)
  local previous = M.cells[info.index]
  M.cells[info.index] = info
  if info.status == "busy" then
    if not previous or previous.status ~= "busy" then
      M.busy_since[info.index] = uv.now()
    end
  else
    M.busy_since[info.index] = nil
  end
end

--- Replaces every cell's status (a full render/sync/restart snapshot).
function M.set_all(list)
  local busy_since = M.busy_since
  M.cells = {}
  M.busy_since = {}
  for _, info in ipairs(list) do
    M.cells[info.index] = info
    if info.status == "busy" then
      M.busy_since[info.index] = busy_since[info.index] or uv.now()
    end
  end
end

function M.set_kernel(info)
  M.kernel = { name = info.name, running = info.running == true }
end

--- 0-based index of the busy cell that has been busy longest, plus how long.
function M.busy()
  local oldest_index, oldest_since
  for index, since in pairs(M.busy_since) do
    if not oldest_since or since < oldest_since then
      oldest_index, oldest_since = index, since
    end
  end
  if oldest_index == nil then
    return nil
  end
  return oldest_index, uv.now() - oldest_since
end

function M.has_error(index)
  local info = M.cells[index]
  return info ~= nil and info.has_error == true
end

return M
