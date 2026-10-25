local M = {}
local uv = vim.uv or vim.loop
local server = require("ipynb-peek.server")

local timers = {}
local key_generations = {}
local cancel_generation = 0

--- Sends a command to the server over its stdio pipe (see server.send).
--- The server pushes rendered/execution state to connected browser clients
--- over its websocket; the response here only carries { ok, error }.
function M.request(command_type, fields, on_result)
  server.send(command_type, fields, on_result)
end

--- Debounces arbitrary work, not just the final HTTP request. This distinction
--- matters for live sync: building its body parses and JSON-encodes the whole
--- notebook, which should happen once after typing settles rather than once per
--- keystroke only to discard all but the last result.
function M.debounce(key, delay, callback)
  local existing = timers[key]
  if existing then
    existing:stop()
    existing:close()
  end
  local generation = (key_generations[key] or 0) + 1
  key_generations[key] = generation
  local scheduled_under_cancel_generation = cancel_generation
  local timer = uv.new_timer()
  timers[key] = timer
  timer:start(delay, 0, function()
    timer:stop()
    timer:close()
    if timers[key] == timer then
      timers[key] = nil
    end
    vim.schedule(function()
      if
        cancel_generation ~= scheduled_under_cancel_generation
        or key_generations[key] ~= generation
      then
        return
      end
      callback()
    end)
  end)
end

--- Debounces requests so rapid-fire triggers (fast saves, fast cursor
--- movement) don't hammer the server. `key` identifies an independent
--- debounce stream (e.g. "render" vs "cursor") so they don't cancel
--- each other's pending timers.
function M.debounced_request(key, delay, command_type, fields, on_result)
  M.debounce(key, delay, function()
    M.request(command_type, fields, on_result)
  end)
end

--- Cancels requests that are still waiting in their debounce window. Used
--- when a preview closes so an old buffer cannot send into a later session.
function M.cancel_debounced()
  cancel_generation = cancel_generation + 1
  for key, timer in pairs(timers) do
    timer:stop()
    timer:close()
    timers[key] = nil
  end
end

return M
