local M = {}

local server = require("ipynb-peek.server")
local client = require("ipynb-peek.client")
local cells = require("ipynb-peek.cells")
local browser = require("ipynb-peek.browser")

--- Resolves the plugin's own install root from where this file was loaded,
--- so server_dir needs no configuration regardless of which plugin manager
--- (or manual `dir =` dev checkout) installed the repo, or where. Must stay
--- a top-level local - debug.getinfo(1, ...) is stack-level sensitive and
--- can't be moved into a function called later without adjusting the level.
local function plugin_root()
  local source = debug.getinfo(1, "S").source
  local file = source:match("^@(.*)$") or source
  local lua_ipynb_peek_dir = vim.fn.fnamemodify(file, ":h")
  return vim.fn.fnamemodify(lua_ipynb_peek_dir, ":h:h")
end

M.config = {
  server_dir = plugin_root() .. "/server",
  debounce_ms = 60,
  cursor_debounce_ms = 50,
  sync_debounce_ms = 150,
  window = { width = 900, height = 1000 },
  position = { x = 40, y = 40 },
  keymaps = {
    open = "<leader>jo",
    close = "<leader>jc",
    run_cell = "<leader>jr",
    run_all = "<leader>jR",
    restart_kernel = "<leader>jK",
  },
}

local aug = vim.api.nvim_create_augroup("IpynbPeek", { clear = true })

function M.setup(opts)
  M.config = vim.tbl_deep_extend("force", M.config, opts or {})
end

--- BufDelete/BufWipeout don't fire for :wq/:q/:qa quitting Neovim with the
--- buffer still open - only VimLeavePre reliably catches that. Registered
--- once, globally, rather than per M.open() call, so repeated close+reopen
--- doesn't pile up duplicate handlers; M.close() is safe to call regardless
--- of whether anything is running.
vim.api.nvim_create_autocmd("VimLeavePre", {
  group = aug,
  callback = function()
    M.close()
  end,
})

--- jupytext.vim rewrites the buffer into a `# %%`-delimited Python view on
--- open, which is not valid notebook JSON - reading from disk instead gets
--- the real JSON jupytext writes back on save, at the cost of only updating
--- here on save rather than every keystroke (see schedule_sync for that).
local function current_content(bufnr)
  local path = vim.api.nvim_buf_get_name(bufnr)
  local ok, lines = pcall(vim.fn.readfile, path)
  if not ok then
    return nil
  end
  return table.concat(lines, "\n")
end

--- Authoritative full re-render from disk, on save. Also tells the server
--- the notebook's directory (so the kernel it spawns uses that as its cwd -
--- matches Jupyter/VS Code convention, and is what makes relative paths
--- like "../data/foo.csv" resolve correctly) and the notebook's own full
--- path (so the server can write execution results back into the real
--- .ipynb file - see persistOutputsToDisk on the server side).
local function schedule_render(bufnr)
  if not server.ready then
    return
  end
  local content = current_content(bufnr)
  if not content then
    return
  end
  local path = vim.api.nvim_buf_get_name(bufnr)
  local dir = vim.fn.fnamemodify(path, ":h")
  local headers = { "X-Notebook-Dir: " .. dir, "X-Notebook-Path: " .. path }
  client.debounced_request(
    "render",
    server.port,
    "/render",
    content,
    headers,
    M.config.debounce_ms,
    function(decoded)
      if not decoded.ok then
        vim.notify("[ipynb-peek] render error: " .. tostring(decoded.error), vim.log.levels.ERROR)
      end
    end
  )
end

--- Live-typing sync (peek.nvim-style): the buffer isn't valid notebook JSON
--- while jupytext owns it, so this parses cell source directly out of the
--- `# %%` buffer instead of re-POSTing to /render on every keystroke. The
--- server carries forward outputs/execution state by index regardless of
--- source changes, so this only ever affects rendered source text, never
--- clears a cell's last output mid-edit.
local function schedule_sync(bufnr)
  if not server.ready then
    return
  end
  local parsed = cells.parse(bufnr)
  local live_cells = {}
  for _, cell in ipairs(parsed) do
    table.insert(live_cells, {
      cell_type = cell.cell_type,
      source = cells.display_source(bufnr, cell),
    })
  end
  client.debounced_request(
    "sync",
    server.port,
    "/sync",
    vim.json.encode({ cells = live_cells }),
    nil,
    M.config.sync_debounce_ms,
    function(decoded)
      if not decoded.ok then
        vim.notify("[ipynb-peek] sync error: " .. tostring(decoded.error), vim.log.levels.ERROR)
      end
    end
  )
end

--- True (after warning) if cells.parse() found zero `# %%` markers in what's
--- supposed to be a jupytext-converted buffer - almost always means
--- vim.g.jupytext_fmt isn't set to a percent format, which otherwise fails
--- completely silently: no error, cells just never run.
local function warn_if_unparseable(parsed)
  if #parsed == 0 then
    vim.notify(
      "[ipynb-peek] found no cells in this buffer - is vim.g.jupytext_fmt set to a `# %%`-based "
        .. "(percent) format? Run :checkhealth ipynb-peek to check.",
      vim.log.levels.WARN
    )
    return true
  end
  return false
end

local function require_server_ready()
  if server.ready then
    return true
  end
  vim.notify("[ipynb-peek] server not ready", vim.log.levels.WARN)
  return false
end

--- Runs the code cell under the cursor in the live kernel.
function M.run_cell()
  if not require_server_ready() then
    return
  end
  local bufnr = vim.api.nvim_get_current_buf()
  local line = vim.api.nvim_win_get_cursor(0)[1]
  local parsed = cells.parse(bufnr)
  if warn_if_unparseable(parsed) then
    return
  end
  local index, cell = cells.cell_index_at(parsed, line)
  if index == nil then
    vim.notify("[ipynb-peek] cursor is not inside a cell", vim.log.levels.WARN)
    return
  end
  if cell.cell_type ~= "code" then
    vim.notify("[ipynb-peek] current cell is not a code cell", vim.log.levels.WARN)
    return
  end
  local source = cells.source(bufnr, cell)
  client.request(
    server.port,
    "/execute",
    vim.json.encode({ index = index, code = source }),
    nil,
    function(decoded)
      if not decoded.ok then
        vim.notify(
          "[ipynb-peek] execute error: " .. tostring(decoded.error),
          vim.log.levels.ERROR
        )
      end
    end
  )
end

--- Runs every code cell in the buffer, top to bottom. Requests are chained
--- (each fires only after the previous one's HTTP response comes back), not
--- fired all at once: the kernel processes execute_requests strictly in the
--- order it receives them, but firing all N requests concurrently via
--- separate curl subprocesses gives no guarantee they *arrive* in that
--- order. Chaining on the response - not full cell completion - is enough,
--- since the kernel already serializes actual execution once requests land.
function M.run_all()
  if not require_server_ready() then
    return
  end
  local bufnr = vim.api.nvim_get_current_buf()
  local parsed = cells.parse(bufnr)
  if warn_if_unparseable(parsed) then
    return
  end

  local code_cells = {}
  for position, cell in ipairs(parsed) do
    if cell.cell_type == "code" then
      table.insert(code_cells, { index = position - 1, source = cells.source(bufnr, cell) })
    end
  end

  local function run_next(position)
    local entry = code_cells[position]
    if not entry then
      return
    end
    client.request(
      server.port,
      "/execute",
      vim.json.encode({ index = entry.index, code = entry.source }),
      nil,
      function(decoded)
        if not decoded.ok then
          vim.notify(
            "[ipynb-peek] execute error: " .. tostring(decoded.error),
            vim.log.levels.ERROR
          )
        end
        run_next(position + 1)
      end
    )
  end

  run_next(1)
end

--- Kills the current kernel; the next run request spawns a fresh one.
--- Needed after `pip`/`uv pip install`-ing a new package into the venv -
--- an already-running kernel process won't see newly installed packages
--- until it restarts.
function M.restart_kernel()
  if not require_server_ready() then
    return
  end
  client.request(server.port, "/restart", "{}", nil, function(decoded)
    if decoded.ok then
      vim.notify("[ipynb-peek] kernel restarted", vim.log.levels.INFO)
    else
      vim.notify("[ipynb-peek] restart error: " .. tostring(decoded.error), vim.log.levels.ERROR)
    end
  end)
end

--- Inserts a fresh, empty `# %%` (or `# %% [markdown]`) cell into the buffer
--- right after cell `after_index` (0-based, matching ipynb order; -1 means
--- "insert at the very top"), and puts the cursor on its empty body line -
--- this is what a "+ Code"/"+ Markdown" click in the preview turns into.
--- A cell's 1-indexed inclusive end_line is numerically the same as the
--- 0-indexed position right after it (see cells.lua's source() for the
--- same trick), which is what insert_line below relies on.
local function insert_cell_at(bufnr, after_index, cell_type)
  local parsed = cells.parse(bufnr)
  local insert_line = 0
  if after_index ~= nil and after_index >= 0 and parsed[after_index + 1] then
    insert_line = parsed[after_index + 1].end_line
  end

  local marker = cell_type == "markdown" and "# %% [markdown]" or "# %%"
  local body = cell_type == "markdown" and "# " or ""

  local new_lines, body_offset
  if insert_line == 0 then
    new_lines = { marker, body }
    body_offset = 2
  else
    new_lines = { "", marker, body }
    body_offset = 3
  end

  vim.api.nvim_buf_set_lines(bufnr, insert_line, insert_line, false, new_lines)

  local win = vim.fn.bufwinid(bufnr)
  if win ~= -1 then
    vim.api.nvim_win_set_cursor(win, { insert_line + body_offset, #body })
  end

  schedule_sync(bufnr)
end

--- Deletes cell `index` (0-based) from the buffer - the marker line, its
--- body, and one leading blank separator line if present (so deleting
--- doesn't leave a stray double-blank where the cell used to be). This is
--- what a delete-cell click in the preview turns into. Uses the same
--- 0-indexed/exclusive-end convention as insert_cell_at above.
local function delete_cell_at(bufnr, index)
  local parsed = cells.parse(bufnr)
  local cell = parsed[index + 1]
  if not cell then
    return
  end

  local del_start = cell.start_line - 1
  local del_end = cell.end_line

  if del_start > 0 then
    local prev = vim.api.nvim_buf_get_lines(bufnr, del_start - 1, del_start, false)[1]
    if prev == "" then
      del_start = del_start - 1
    end
  end

  vim.api.nvim_buf_set_lines(bufnr, del_start, del_end, false, {})
  schedule_sync(bufnr)
end

local events_job = nil
local events_should_run = false

--- Applies one line of /events output as a buffer edit. Split out of
--- start_event_listener's on_stdout callback purely to keep nesting shallow -
--- this used to be five levels deep inside that callback.
local function handle_event_line(bufnr, line)
  if line == "" then
    return
  end
  local ok, decoded = pcall(vim.json.decode, line)
  if not ok then
    vim.schedule(function()
      vim.notify(
        "[ipynb-peek] received malformed event data: " .. tostring(decoded),
        vim.log.levels.WARN
      )
    end)
    return
  end
  if not decoded then
    return
  end
  if decoded.type == "insert_cell" then
    vim.schedule(function()
      insert_cell_at(bufnr, decoded.after_index, decoded.cell_type)
    end)
  elseif decoded.type == "delete_cell" then
    vim.schedule(function()
      delete_cell_at(bufnr, decoded.index)
    end)
  end
end

--- Keeps a persistent connection to the server's /events stream so
--- browser-originated actions (currently just "+ Code"/"+ Markdown") can
--- reach Neovim - the reverse of every other request in this plugin, which
--- are all Neovim POSTing out. The server caps its idle-connection timeout
--- at 255s (a hard Bun limit), so for any editing session longer than that
--- this WILL periodically drop - auto-reconnect (matching the browser's own
--- websocket reconnect-with-backoff) rather than silently going dead.
local function start_event_listener(bufnr)
  events_should_run = true
  if events_job then
    return
  end
  local url = string.format("http://127.0.0.1:%d/events", server.port)
  events_job = vim.fn.jobstart({ "curl", "-s", "-N", url }, {
    stdout_buffered = false,
    on_stdout = function(_, data)
      for _, line in ipairs(data) do
        handle_event_line(bufnr, line)
      end
    end,
    on_exit = function()
      events_job = nil
      if events_should_run then
        vim.defer_fn(function()
          start_event_listener(bufnr)
        end, 500)
      end
    end,
  })
end

local function stop_event_listener()
  events_should_run = false
  if events_job then
    vim.fn.jobstop(events_job)
    events_job = nil
  end
end

--- open/close are wrapped in closures rather than referenced directly:
--- M.open and M.close aren't defined yet at this point in the file, and Lua
--- evaluates table literal values immediately - the wrappers just look up
--- M.open/M.close on the shared module table at call time instead, by which
--- point they exist.
local KEYMAP_ACTIONS = {
  open = { fn = function() M.open() end, desc = "ipynb-peek: open preview" },
  close = { fn = function() M.close() end, desc = "ipynb-peek: close preview" },
  run_cell = { fn = M.run_cell, desc = "ipynb-peek: run cell" },
  run_all = { fn = M.run_all, desc = "ipynb-peek: run all cells" },
  restart_kernel = { fn = M.restart_kernel, desc = "ipynb-peek: restart kernel" },
}

--- Sets each default (or user-overridden) keymap from M.config.keymaps,
--- buffer-local. Any entry explicitly set to `false` in setup() is skipped -
--- the corresponding command (:IpynbPeekRunCell etc.) still works regardless.
local function apply_keymaps(bufnr)
  for key, action in pairs(KEYMAP_ACTIONS) do
    local lhs = M.config.keymaps[key]
    if lhs then
      vim.keymap.set("n", lhs, action.fn, { buffer = bufnr, desc = action.desc })
    end
  end
end

--- Keymaps need to work as soon as you're editing a notebook, not just
--- after :IpynbPeekOpen has already run once (M.open() also calls
--- apply_keymaps as a safety net, for the edge case of running
--- :IpynbPeekOpen from some other buffer). Matches on the buffer's file
--- name rather than filetype, since jupytext.vim converts .ipynb buffers
--- to filetype=python.
vim.api.nvim_create_autocmd({ "BufEnter", "BufWinEnter" }, {
  group = aug,
  pattern = "*.ipynb",
  callback = function(args)
    apply_keymaps(args.buf)
  end,
})

function M.open()
  server.start({ server_dir = M.config.server_dir })

  local bufnr = vim.api.nvim_get_current_buf()
  local last_cursor_index = nil

  local function send_cursor_update()
    if not server.ready then
      return
    end
    local line = vim.api.nvim_win_get_cursor(0)[1]
    local parsed = cells.parse(bufnr)
    local index = cells.cell_index_at(parsed, line)
    if index == nil or index == last_cursor_index then
      return
    end
    last_cursor_index = index
    client.debounced_request(
      "cursor",
      server.port,
      "/cursor",
      vim.json.encode({ index = index }),
      nil,
      M.config.cursor_debounce_ms,
      function() end
    )
  end

  vim.api.nvim_create_autocmd({ "BufWritePost", "BufEnter" }, {
    group = aug,
    buffer = bufnr,
    callback = function()
      schedule_render(bufnr)
    end,
  })

  --- CursorMoved (not CursorMovedI) only fires for normal/visual-mode
  --- cursor movement, so this naturally scopes scroll-sync to normal mode.
  vim.api.nvim_create_autocmd("CursorMoved", {
    group = aug,
    buffer = bufnr,
    callback = send_cursor_update,
  })

  vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI" }, {
    group = aug,
    buffer = bufnr,
    callback = function()
      schedule_sync(bufnr)
    end,
  })

  --- Closing the notebook buffer (not just switching away from it) closes
  --- the preview too, rather than leaving a dead server + popup behind.
  vim.api.nvim_create_autocmd({ "BufDelete", "BufWipeout" }, {
    group = aug,
    buffer = bufnr,
    callback = M.close,
  })

  apply_keymaps(bufnr)

  local function wait_ready()
    if server.ready then
      browser.open(server.url, M.config.window, M.config.position)
      start_event_listener(bufnr)
      warn_if_unparseable(cells.parse(bufnr))
      schedule_render(bufnr)
    else
      vim.defer_fn(wait_ready, 50)
    end
  end
  wait_ready()
end

function M.close()
  if server.port then
    browser.close("ipynb-peek:" .. server.port)
  end
  stop_event_listener()
  server.stop()
end

vim.api.nvim_create_user_command("IpynbPeekOpen", M.open, {})
vim.api.nvim_create_user_command("IpynbPeekClose", M.close, {})
vim.api.nvim_create_user_command("IpynbPeekRunCell", M.run_cell, {})
vim.api.nvim_create_user_command("IpynbPeekRunAll", M.run_all, {})
vim.api.nvim_create_user_command("IpynbPeekRestartKernel", M.restart_kernel, {})

return M
