--- Execution & DAG staleness state reported by the server, kept apart from
--- session lifecycle (session.lua) and buffer state so text-objects, outline,
--- status signs, and statusline can read it cleanly.
local M = {}

local uv = vim.uv or vim.loop

--- 0-based cell index -> { status, execution_count, duration_ms, has_error }
M.cells = {}
--- 0-based cell index -> uv.now() when it was last seen turning busy
M.busy_since = {}
--- 0-based cell index -> { edited = bool, reasons = [{ from, symbols, kind }] }
M.stale = {}
--- { name = string|nil, running = boolean }
M.kernel = { name = nil, running = false }

function M.reset()
  M.cells = {}
  M.busy_since = {}
  M.stale = {}
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

--- Replaces the stale map (accepts numeric or string keys from JSON).
function M.set_stale(stale_map)
  M.stale = {}
  if type(stale_map) ~= "table" then
    return
  end
  for k, v in pairs(stale_map) do
    local idx = tonumber(k)
    if idx ~= nil and type(v) == "table" then
      M.stale[idx] = v
    end
  end
end

function M.is_stale(index)
  return M.stale[index] ~= nil
end

function M.stale_count()
  local count = 0
  for _ in pairs(M.stale) do
    count = count + 1
  end
  return count
end

function M.set_kernel(info)
  M.kernel = { name = info.name, running = info.running == true }
end

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
