local M = {}

local uv = vim.loop
local job_id = nil
M.port = nil
M.url = nil
M.ready = false
--- Per-session shared secret the server requires on every state-changing
--- request and the /ws upgrade (see server/src/index.ts's isAuthorized) -
--- without it, any other page open in the user's browser could drive the
--- kernel just by knowing/scanning the port. Regenerated on every
--- M.start(). client.lua reads this to authenticate its own requests.
M.token = nil
--- The opts.theme actually used to spawn the currently-running server -
--- kept around purely so a second M.start() while one is already running
--- can tell whether the caller's theme differs from what's live, to warn
--- about it (see M.start below).
local active_theme = nil

local function get_free_port()
  local tcp = uv.new_tcp()
  tcp:bind("127.0.0.1", 0)
  local sockname = tcp:getsockname()
  tcp:close()
  return sockname.port
end

local function generate_token()
  math.randomseed(uv.hrtime())
  local raw = tostring(uv.hrtime()) .. tostring(math.random(1e9)) .. tostring(vim.fn.getpid())
  return vim.fn.sha256(raw)
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
  M.port = get_free_port()
  M.url = nil
  M.ready = false
  M.token = generate_token()
  active_theme = opts.theme

  local env = { IPYNB_PEEK_PORT = tostring(M.port), IPYNB_PEEK_TOKEN = M.token }
  if opts.theme ~= nil then
    env.IPYNB_PEEK_THEME = vim.json.encode(opts.theme)
  end

  job_id = vim.fn.jobstart({ "node", "dist/index.js" }, {
    cwd = opts.server_dir,
    env = env,
    stdout_buffered = false,
    on_stdout = function(_, data)
      for _, line in ipairs(data) do
        if line:match("^IPYNB_PEEK_URL=") then
          M.url = line:match("^IPYNB_PEEK_URL=(.+)$")
          M.ready = true
        end
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
    on_exit = function()
      job_id = nil
      M.ready = false
      M.url = nil
    end,
  })
end

function M.stop()
  if job_id then
    vim.fn.jobstop(job_id)
    job_id = nil
    M.ready = false
    M.url = nil
  end
end

return M
