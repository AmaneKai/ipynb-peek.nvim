local M = {}
local uv = vim.uv or vim.loop
local server = require("ipynb-peek.server")

local timers = {}
local key_generations = {}
local cancel_generation = 0

--- Fires a single POST request immediately. `headers` is an optional list
--- of raw "Name: value" strings.
--- The server pushes rendered/execution state to connected browser clients
--- over its websocket; the HTTP response here only carries { ok, error }.
--- Always authenticates with server.token (see server.lua) - every state-
--- changing route requires it, so call sites here don't each need to
--- remember to attach it themselves.
function M.request(port, path, body, headers, on_result)
  local url = string.format("http://127.0.0.1:%d%s", port, path)
  local args = {
    "curl",
    "-sS",
    "--connect-timeout",
    "2",
    "--max-time",
    "45",
    "-X",
    "POST",
  }
  if server.token then
    table.insert(args, "-H")
    table.insert(args, "X-Ipynb-Peek-Token: " .. server.token)
  end
  for _, header in ipairs(headers or {}) do
    table.insert(args, "-H")
    table.insert(args, header)
  end
  table.insert(args, "--data-binary")
  table.insert(args, "@-")
  table.insert(args, url)
  vim.system(args, { stdin = body }, function(result)
    if result.code ~= 0 then
      vim.schedule(function()
        vim.notify(
          "[ipynb-peek] request to "
            .. path
            .. " failed (curl exit "
            .. result.code
            .. ") - is the server still running?",
          vim.log.levels.WARN
        )
      end)
      return
    end
    if not result.stdout or result.stdout == "" then
      return
    end
    local ok, decoded = pcall(vim.json.decode, result.stdout)
    if ok and decoded then
      vim.schedule(function()
        if on_result then
          on_result(decoded)
        end
      end)
    else
      vim.schedule(function()
        vim.notify("[ipynb-peek] got an unparseable response from " .. path, vim.log.levels.WARN)
      end)
    end
  end)
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
function M.debounced_request(key, port, path, body, headers, delay, on_result)
  M.debounce(key, delay, function()
    M.request(port, path, body, headers, on_result)
  end)
end

--- Cancels requests that are still waiting in their debounce window. Used
--- when a preview closes so an old buffer cannot POST into a later session.
function M.cancel_debounced()
  cancel_generation = cancel_generation + 1
  for key, timer in pairs(timers) do
    timer:stop()
    timer:close()
    timers[key] = nil
  end
end

return M
