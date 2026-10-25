local M = {}

local job_id = nil
local next_request_id = 0
--- Callbacks for commands sent with M.send that are still waiting for the
--- server's { type = "response", id } line, keyed by that id.
local pending = {}
--- Partial trailing stdout line carried over between on_stdout callbacks
--- (see :h channel-lines - a line can be split across callbacks).
local stdout_partial = ""
M.port = nil
M.url = nil
M.ready = false
M.error = nil
--- Per-session shared secret the server requires on every state-changing
--- HTTP request and the /ws upgrade (see server/src/index.ts's isAuthorized) -
--- without it, any other page open in the user's browser could drive the
--- kernel just by knowing/scanning the port. The server generates it inside
--- its existing Node process and reports it in its ready event, avoiding a
--- second blocking Node cold start. Neovim itself talks to the server over
--- stdio and never needs to present it.
M.token = nil
--- The opts.theme actually used to spawn the currently-running server -
--- kept around purely so a second M.start() while one is already running
--- can tell whether the caller's theme differs from what's live, to warn
--- about it (see M.start below).
local active_theme = nil
local stopping = false

--- Handles one NDJSON line from the server's stdout: the ready handshake,
--- responses to commands sent with M.send, or a pushed event.
local function handle_line(line, opts)
  if line == "" then
    return
  end
  local ok, msg = pcall(vim.json.decode, line)
  if not ok or type(msg) ~= "table" then
    vim.schedule(function()
      vim.notify("[ipynb-peek] received malformed server output: " .. line, vim.log.levels.WARN)
    end)
    return
  end
  if msg.type == "ready" then
    M.token = msg.token
    M.url = msg.url
    M.port = msg.port
    M.ready = M.token ~= nil and M.url ~= nil and M.port ~= nil
    if M.ready and opts.on_ready then
      vim.schedule(opts.on_ready)
    end
  elseif msg.type == "response" then
    local callback = pending[msg.id]
    pending[msg.id] = nil
    if callback then
      vim.schedule(function()
        callback(msg)
      end)
    end
  elseif opts.on_event then
    vim.schedule(function()
      opts.on_event(msg)
    end)
  end
end

--- Starts the render server (a prebuilt dist/index.js, committed to the
--- repo - see server/build.mjs) if not already running. The server/kernel
--- are both global singletons (see [[README]] "How it works"), so a second
--- call while one is already running reuses it rather than spawning
--- another - if that second call's opts.theme differs from what's actually
--- live, warn rather than silently ignoring it: theme only takes effect at
--- spawn time, so there'd otherwise be no indication the requested
--- colors/fonts never applied.
--- opts.server_dir: absolute path to the `server/` directory (contains package.json).
--- opts.on_ready(): called once, the moment the server's ready event arrives.
--- opts.on_event(event): called (scheduled) for every server-pushed event.
--- opts.on_exit(): called (scheduled) if the server dies without M.stop().
function M.start(opts)
  opts = opts or {}
  if job_id then
    if opts.theme ~= nil and not vim.deep_equal(opts.theme, active_theme) then
      vim.notify(
        "[ipynb-peek] server already running for another notebook - this notebook's theme "
          .. "config is ignored until you :IpynbPeekClose and reopen",
        vim.log.levels.WARN
      )
    end
    return
  end
  M.port = nil
  M.url = nil
  M.ready = false
  M.error = nil
  M.token = nil
  stdout_partial = ""
  active_theme = opts.theme

  local env = { IPYNB_PEEK_PORT = "0" }
  if opts.theme ~= nil then
    env.IPYNB_PEEK_THEME = vim.json.encode(opts.theme)
  end

  stopping = false
  local started_job_id
  started_job_id = vim.fn.jobstart({ "node", "dist/index.js" }, {
    cwd = opts.server_dir,
    env = env,
    stdout_buffered = false,
    on_stdout = function(_, data)
      -- Per :h channel-lines the first element continues the previous
      -- callback's last (unterminated) line.
      data[1] = stdout_partial .. data[1]
      stdout_partial = table.remove(data)
      for _, line in ipairs(data) do
        handle_line(line, opts)
      end
    end,
    on_stderr = function(_, data)
      for _, line in ipairs(data) do
        if line ~= "" then
          vim.schedule(function()
            vim.notify("[ipynb-peek] " .. line, vim.log.levels.WARN)
          end)
        end
      end
    end,
    on_exit = function(_, exit_code)
      if job_id ~= started_job_id then
        return
      end
      local was_ready = M.ready
      job_id = nil
      M.fail_pending("preview server exited")
      M.ready = false
      M.url = nil
      if not stopping then
        M.error = "preview server exited unexpectedly (exit " .. exit_code .. ")"
        if was_ready then
          vim.schedule(function()
            vim.notify("[ipynb-peek] " .. M.error, vim.log.levels.ERROR)
          end)
        end
        if opts.on_exit then
          vim.schedule(opts.on_exit)
        end
      end
    end,
  })
  if started_job_id <= 0 then
    M.error = "failed to start Node preview server (jobstart returned " .. started_job_id .. ")"
    M.token = nil
    return false
  end
  job_id = started_job_id
  return true
end

--- Sends one command to the server over stdin as an NDJSON line. `fields`
--- is merged with the command `type`; `on_result` (optional) receives the
--- server's { ok, error? } response, scheduled onto the main loop. Returns
--- false (after warning) if no server is running.
function M.send(command_type, fields, on_result)
  if not job_id or not M.ready then
    vim.notify("[ipynb-peek] server not running", vim.log.levels.WARN)
    return false
  end
  local msg = vim.tbl_extend("force", fields or {}, { type = command_type })
  if on_result then
    next_request_id = next_request_id + 1
    msg.id = next_request_id
    pending[msg.id] = on_result
  end
  local ok = pcall(vim.fn.chansend, job_id, vim.json.encode(msg) .. "\n")
  if not ok then
    if msg.id then
      pending[msg.id] = nil
    end
    vim.notify("[ipynb-peek] failed to write to the preview server", vim.log.levels.WARN)
    return false
  end
  return true
end

--- Resolves every outstanding M.send callback with a failure, so callers
--- waiting on a response (e.g. run-all) don't hang on a dead server.
function M.fail_pending(reason)
  local callbacks = pending
  pending = {}
  for _, callback in pairs(callbacks) do
    vim.schedule(function()
      callback({ ok = false, error = reason })
    end)
  end
end

function M.stop()
  stopping = true
  M.fail_pending("preview server stopped")
  if job_id then
    vim.fn.jobstop(job_id)
    job_id = nil
    M.ready = false
    M.url = nil
  end
  M.port = nil
  M.token = nil
  M.error = nil
  active_theme = nil
end

return M
