local M = {}
local uv = vim.uv or vim.loop
local server = require("ipynb-peek.server")

local timers = {}
local key_generations = {}
local cancel_generation = 0

--- Sends a command to the server over its stdio pipe (see server.send).
--- The server pushes rendered/execution state to connected browser clients
--- over SSE; the response here only carries { ok, error }.
function M.request(command_type, fields, on_result)
  server.send(command_type, fields, on_result)
end

local function close_timer(timer)
  if timer and not timer:is_closing() then
    timer:stop()
    timer:close()
  end
end

--- Cancels any pending debounced callback for a single `key`.
function M.cancel_key(key)
  key_generations[key] = (key_generations[key] or 0) + 1
  local existing = timers[key]
  timers[key] = nil
  close_timer(existing)
end

--- Debounces arbitrary work by `key` so rapid bursts coalesce cleanly.
function M.debounce(key, delay, callback)
  M.cancel_key(key)
  local generation = key_generations[key]
  local scheduled_cancel = cancel_generation
  local timer = uv.new_timer()
  timers[key] = timer
  timer:start(delay, 0, function()
    close_timer(timer)
    if timers[key] == timer then
      timers[key] = nil
    end
    vim.schedule(function()
      if cancel_generation ~= scheduled_cancel or key_generations[key] ~= generation then
        return
      end
      callback()
    end)
  end)
end

function M.debounced_request(key, delay, command_type, fields, on_result)
  M.debounce(key, delay, function()
    M.request(command_type, fields, on_result)
  end)
end

function M.cancel_debounced()
  cancel_generation = cancel_generation + 1
  for key, timer in pairs(timers) do
    timers[key] = nil
    close_timer(timer)
  end
end

return M
