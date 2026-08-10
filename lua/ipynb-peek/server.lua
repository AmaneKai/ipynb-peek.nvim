local M = {}

local job_id = nil
M.port = nil
M.url = nil
M.ready = false
M.error = nil
--- Per-session shared secret the server requires on every state-changing
--- request and the /ws upgrade (see server/src/index.ts's isAuthorized) -
--- without it, any other page open in the user's browser could drive the
--- kernel just by knowing/scanning the port. The server generates it inside
--- its existing Node process and reports it with its ready lines, avoiding a
--- second blocking Node cold start. client.lua reads it to authenticate its
--- own requests.
M.token = nil
--- The opts.theme actually used to spawn the currently-running server -
--- kept around purely so a second M.start() while one is already running
--- can tell whether the caller's theme differs from what's live, to warn
--- about it (see M.start below).
local active_theme = nil
local stopping = false

--- Starts the render server (a prebuilt dist/index.js, committed to the
--- repo - see server/build.mjs) if not already running. The server/kernel
--- are both global singletons (see [[README]] "How it works"), so a second
--- call while one is already running reuses it rather than spawning
--- another - if that second call's opts.theme differs from what's actually
--- live, warn rather than silently ignoring it: theme only takes effect at
--- spawn time, so there'd otherwise be no indication the requested
--- colors/fonts never applied.
--- opts.server_dir: absolute path to the `server/` directory (contains package.json).
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
      for _, line in ipairs(data) do
        if line:match("^IPYNB_PEEK_TOKEN=") then
          M.token = line:match("^IPYNB_PEEK_TOKEN=([0-9a-f]+)$")
        elseif line:match("^IPYNB_PEEK_URL=") then
          M.url = line:match("^IPYNB_PEEK_URL=(.+)$")
          M.port = tonumber(M.url:match(":(%d+)/?$"))
        end
        M.ready = M.token ~= nil and M.url ~= nil and M.port ~= nil
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
      M.ready = false
      M.url = nil
      if not stopping then
        M.error = "preview server exited unexpectedly (exit " .. exit_code .. ")"
        if was_ready then
          vim.schedule(function()
            vim.notify("[ipynb-peek] " .. M.error, vim.log.levels.ERROR)
          end)
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

function M.stop()
  stopping = true
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
