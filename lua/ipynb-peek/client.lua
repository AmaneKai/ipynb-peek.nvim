local M = {}
local uv = vim.loop
local server = require("ipynb-peek.server")

local timers = {}

--- Fires a single POST request immediately. `headers` is an optional list
--- of raw "Name: value" strings.
--- The server pushes rendered/execution state to connected browser clients
--- over its websocket; the HTTP response here only carries { ok, error }.
--- Always authenticates with server.token (see server.lua) - every state-
--- changing route requires it, so call sites here don't each need to
--- remember to attach it themselves.
function M.request(port, path, body, headers, on_result)
  local url = string.format("http://127.0.0.1:%d%s", port, path)
  local args = { "curl", "-s", "-X", "POST" }
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
  vim.system(
    args,
    { stdin = body },
    function(result)
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
    end
  )
end

--- Debounces requests so rapid-fire triggers (fast saves, fast cursor
--- movement) don't hammer the server. `key` identifies an independent
--- debounce stream (e.g. "render" vs "cursor") so they don't cancel
--- each other's pending timers.
function M.debounced_request(key, port, path, body, headers, delay, on_result)
  local existing = timers[key]
  if existing then
    existing:stop()
    existing:close()
  end
  local timer = uv.new_timer()
  timers[key] = timer
  timer:start(delay, 0, function()
    timer:stop()
    timer:close()
    timers[key] = nil
    M.request(port, path, body, headers, on_result)
  end)
end

return M
