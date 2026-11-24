local M = {}

local job_id = nil
local next_request_id = 0
local pending = {}
local stopping = false

M.port = nil
M.url = nil
M.ready = false
M.error = nil
M.token = nil

--- Resolves the Python executable to launch `python/server.py`.
function M.find_python(configured)
  if type(configured) == "string" and configured ~= "" then
    return configured
  end
  if vim.fn.executable("python3") == 1 then
    return "python3"
  end
  if vim.fn.executable("python") == 1 then
    return "python"
  end
  return nil
end

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

--- Starts the Python preview/kernel server (`python/server.py`).
--- opts.server_script: absolute path to `python/server.py`
--- opts.python: optional Python executable path/name
--- opts.on_ready(), opts.on_event(event), opts.on_exit()
function M.start(opts)
  opts = opts or {}
  if job_id then
    return true
  end

  local python = M.find_python(opts.python)
  if not python then
    M.error = "python3 not found on PATH"
    return false
  end

  M.port = nil
  M.url = nil
  M.ready = false
  M.error = nil
  M.token = nil
  stopping = false

  local stdout_partial = ""
  local started_job_id
  started_job_id = vim.fn.jobstart({ python, "-u", opts.server_script }, {
    stdout_buffered = false,
    on_stdout = function(_, data)
      if job_id ~= started_job_id then
        return
      end
      data[1] = stdout_partial .. data[1]
      stdout_partial = table.remove(data)
      for _, line in ipairs(data) do
        handle_line(line, opts)
      end
    end,
    on_stderr = function(_, data)
      if job_id ~= started_job_id then
        return
      end
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
      M.port = nil
      M.token = nil
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
    M.error = "failed to start Python preview server (jobstart returned " .. started_job_id .. ")"
    M.port = nil
    M.token = nil
    return false
  end
  job_id = started_job_id
  return true
end

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
    pcall(vim.fn.chanclose, job_id, "stdin")
    vim.fn.jobstop(job_id)
    job_id = nil
    M.ready = false
    M.url = nil
  end
  M.port = nil
  M.token = nil
  M.error = nil
end

return M
