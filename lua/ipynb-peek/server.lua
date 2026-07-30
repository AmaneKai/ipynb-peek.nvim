local M = {}

local uv = vim.loop
local job_id = nil
M.port = nil
M.url = nil
M.ready = false

local function get_free_port()
  local tcp = uv.new_tcp()
  tcp:bind("127.0.0.1", 0)
  local sockname = tcp:getsockname()
  tcp:close()
  return sockname.port
end

--- Starts the render server (a prebuilt dist/index.js, committed to the
--- repo - see server/build.mjs) if not already running.
--- opts.server_dir: absolute path to the `server/` directory (contains package.json).
function M.start(opts)
  if job_id then
    return
  end
  opts = opts or {}
  M.port = get_free_port()
  M.url = nil
  M.ready = false

  local env = { IPYNB_PEEK_PORT = tostring(M.port) }
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
