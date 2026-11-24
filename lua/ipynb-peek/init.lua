local M = {}
local uv = vim.uv or vim.loop

local server = require("ipynb-peek.server")
local client = require("ipynb-peek.client")
local cells = require("ipynb-peek.cells")
local ipynb = require("ipynb-peek.ipynb")
local browser = require("ipynb-peek.browser")
local status = require("ipynb-peek.status")
local session = require("ipynb-peek.session")
local runtime = require("ipynb-peek.runtime")
local textobjects = require("ipynb-peek.textobjects")
local float = require("ipynb-peek.float")

local function plugin_root()
  local source = debug.getinfo(1, "S").source
  local file = source:match("^@(.*)$") or source
  local lua_ipynb_peek_dir = vim.fn.fnamemodify(file, ":h")
  return vim.fn.fnamemodify(lua_ipynb_peek_dir, ":h:h")
end

M.config = {
  server_script = plugin_root() .. "/python/server.py",
  --- Optional explicit Python executable path/name (defaults to python3 / python).
  python = nil,
  debounce_ms = 60,
  cursor_debounce_ms = 50,
  sync_debounce_ms = 150,
  startup_timeout_ms = 10000,
  inline_status = true,
  --- "default" (vim.ui.open), command table like { "surf" }, or false (headless/SSH).
  browser = "default",
  keymaps = {
    open = "<leader>jo",
    close = "<leader>jc",
    run_cell = "<leader>jr",
    run_cell_advance = "<leader>jn",
    run_all = "<leader>jR",
    run_affected = "<leader>ja",
    run_slice = "<leader>js",
    deps = "<leader>jd",
    audit = "<leader>jA",
    restart_kernel = "<leader>jK",
    interrupt_kernel = "<leader>ji",
    next_cell = "<leader>jj",
    prev_cell = "<leader>jk",
    goto_cell = "<leader>jg",
  },
  text_objects = {},
}

local aug = vim.api.nvim_create_augroup("IpynbPeek", { clear = true })

ipynb.setup_autocmds()

function M.setup(opts)
  M.config = vim.tbl_deep_extend("force", M.config, opts or {})
  ipynb.setup_autocmds()
end

vim.api.nvim_create_autocmd("VimLeavePre", {
  group = aug,
  callback = function()
    M.close()
  end,
})

local function is_session_buf_live(bufnr)
  return session.is_active() and session.bufnr == bufnr and vim.api.nvim_buf_is_valid(bufnr)
end

local function schedule_render(bufnr, delay)
  client.debounce("render", delay == nil and M.config.debounce_ms or delay, function()
    if not is_session_buf_live(bufnr) then
      return
    end
    local path = vim.api.nvim_buf_get_name(bufnr)
    local dir = vim.fn.fnamemodify(path, ":h")
    local content = ipynb.buffer_to_json(bufnr)
    client.request("render", { notebook = content, dir = dir, path = path }, function(decoded)
      if not decoded.ok then
        vim.notify("[ipynb-peek] render error: " .. tostring(decoded.error), vim.log.levels.ERROR)
      end
    end)
  end)
end

local function send_sync_payload(bufnr)
  if not is_session_buf_live(bufnr) then
    return
  end
  local parsed, lines = cells.snapshot(bufnr)
  local live_cells = {}
  for _, cell in ipairs(parsed) do
    table.insert(live_cells, {
      cell_type = cell.cell_type,
      source = cells.display_source_from_lines(lines, cell),
    })
  end
  client.request("sync", { cells = live_cells }, function(decoded)
    if not decoded.ok then
      vim.notify("[ipynb-peek] sync error: " .. tostring(decoded.error), vim.log.levels.ERROR)
    end
  end)
end

--- Cancels any pending debounced sync and pushes the latest buffer immediately.
local function sync_now(bufnr)
  if client.cancel_key then
    client.cancel_key("sync")
  end
  send_sync_payload(bufnr)
end

local function schedule_sync(bufnr)
  client.debounce("sync", M.config.sync_debounce_ms, function()
    send_sync_payload(bufnr)
  end)
end

local function warn_if_unparseable(parsed)
  if #parsed == 0 then
    vim.notify("[ipynb-peek] found no `# %%` cells in this buffer", vim.log.levels.WARN)
    return true
  end
  return false
end

local function require_server_ready()
  if session.state == "idle" then
    vim.notify("[ipynb-peek] no notebook preview is open", vim.log.levels.WARN)
    return false
  end
  if session.bufnr ~= vim.api.nvim_get_current_buf() then
    vim.notify(
      "[ipynb-peek] this command belongs to the notebook with the active preview",
      vim.log.levels.WARN
    )
    return false
  end
  if not session.is_active() then
    vim.notify("[ipynb-peek] server not ready", vim.log.levels.WARN)
    return false
  end
  return true
end

function M.run_cell(advance)
  if not require_server_ready() then
    return
  end
  local bufnr = vim.api.nvim_get_current_buf()
  local line = vim.api.nvim_win_get_cursor(0)[1]
  local parsed, lines = cells.snapshot(bufnr)
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
  local source = cells.source_from_lines(lines, cell)
  client.request("execute", { index = index, code = source }, function(decoded)
    if not decoded.ok then
      vim.notify("[ipynb-peek] execute error: " .. tostring(decoded.error), vim.log.levels.ERROR)
    end
  end)
  if advance and cells.cell_after(parsed, index) then
    cells.jump_to_cell_in_window(nil, bufnr, index + 1, 1, false)
  end
end

function M.run_cell_and_advance()
  M.run_cell(true)
end

local function first_code_cell_index(parsed)
  for pos, cell in ipairs(parsed) do
    if cell.cell_type == "code" then
      return pos - 1
    end
  end
  return nil
end

local function jump_cell(direction)
  local bufnr = vim.api.nvim_get_current_buf()
  local line = vim.api.nvim_win_get_cursor(0)[1]
  local parsed = cells.parse(bufnr)
  if warn_if_unparseable(parsed) then
    return
  end
  local index = cells.cell_index_at(parsed, line)
  if index == nil then
    local first_idx = direction == "next" and first_code_cell_index(parsed) or nil
    if first_idx ~= nil then
      cells.jump_to_cell_in_window(nil, bufnr, first_idx, 1, false)
    end
    return
  end

  local target_idx = index
  local remaining = vim.v.count1
  local delta = direction == "next" and 1 or -1
  while remaining > 0 do
    local stepped = direction == "next" and cells.cell_after(parsed, index)
      or cells.cell_before(parsed, index)
    if not stepped then
      break
    end
    index = index + delta
    if stepped.cell_type == "code" then
      target_idx = index
      remaining = remaining - 1
    end
  end
  cells.jump_to_cell_in_window(nil, bufnr, target_idx, 1, false)
end

function M.jump_to_next_cell()
  jump_cell("next")
end

function M.jump_to_previous_cell()
  jump_cell("previous")
end

function M.jump_to_cell(target)
  local bufnr = vim.api.nvim_get_current_buf()
  local parsed = cells.parse(bufnr)
  if warn_if_unparseable(parsed) then
    return
  end

  local function land(raw)
    local number = tonumber(raw)
    if not number or number < 1 or number ~= math.floor(number) or not parsed[number] then
      vim.notify(
        "[ipynb-peek] no cell " .. tostring(raw) .. " - this notebook has " .. #parsed .. " cells",
        vim.log.levels.WARN
      )
      return
    end
    cells.jump_to_cell_in_window(nil, bufnr, number - 1, 1, false)
  end

  if target ~= nil then
    land(target)
    return
  end
  if vim.v.count > 0 then
    land(vim.v.count)
    return
  end

  vim.ui.input({ prompt = "ipynb-peek: jump to cell # " }, function(input)
    if input ~= nil and input ~= "" then
      land(input)
    end
  end)
end

local run_all_waiters = {}
local run_all_generation = 0

local function cancel_run_all(message)
  local had_waiters = next(run_all_waiters) ~= nil
  run_all_generation = run_all_generation + 1
  run_all_waiters = {}
  if had_waiters and message then
    vim.schedule(function()
      vim.notify("[ipynb-peek] run cancelled: " .. message, vim.log.levels.WARN)
    end)
  end
end

local function build_exec_queue(bufnr, indices)
  local parsed, lines = cells.snapshot(bufnr)
  local queue = {}
  for _, idx in ipairs(indices) do
    local cell = parsed[idx + 1]
    if cell and cell.cell_type == "code" then
      table.insert(queue, { index = idx, source = cells.source_from_lines(lines, cell) })
    end
  end
  return queue
end

local function step_queue(queue, position, generation, label)
  if generation ~= run_all_generation then
    return
  end
  local entry = queue[position]
  if not entry then
    return
  end

  run_all_waiters[entry.index] = function(status_info)
    if generation ~= run_all_generation then
      return
    end
    if status_info.has_error then
      vim.notify(
        "[ipynb-peek] " .. label .. " stopped: cell " .. (entry.index + 1) .. " errored",
        vim.log.levels.WARN
      )
      return
    end
    step_queue(queue, position + 1, generation, label)
  end

  client.request("execute", { index = entry.index, code = entry.source }, function(decoded)
    if decoded.ok then
      return
    end
    if generation == run_all_generation then
      run_all_waiters[entry.index] = nil
    end
    vim.notify("[ipynb-peek] execute error: " .. tostring(decoded.error), vim.log.levels.ERROR)
  end)
end

local function run_indices(bufnr, indices, label)
  local queue = build_exec_queue(bufnr, indices)
  if #queue == 0 then
    vim.notify("[ipynb-peek] " .. label .. ": no code cells to run", vim.log.levels.INFO)
    return
  end
  run_all_generation = run_all_generation + 1
  run_all_waiters = {}
  step_queue(queue, 1, run_all_generation, label)
end

function M.run_all()
  if not require_server_ready() then
    return
  end
  local bufnr = vim.api.nvim_get_current_buf()
  local parsed = cells.parse(bufnr)
  if warn_if_unparseable(parsed) then
    return
  end
  local indices = {}
  for position, cell in ipairs(parsed) do
    if cell.cell_type == "code" and not vim.tbl_contains(cell.tags or {}, "skip-run-all") then
      table.insert(indices, position - 1)
    end
  end
  run_indices(bufnr, indices, "run all")
end

local function current_code_cell_index(bufnr)
  local line = vim.api.nvim_win_get_cursor(0)[1]
  local parsed = cells.parse(bufnr)
  if warn_if_unparseable(parsed) then
    return nil
  end
  local index, cell = cells.cell_index_at(parsed, line)
  if index == nil then
    vim.notify("[ipynb-peek] cursor is not inside a cell", vim.log.levels.WARN)
    return nil
  end
  if cell.cell_type ~= "code" then
    vim.notify("[ipynb-peek] current cell is not a code cell", vim.log.levels.WARN)
    return nil
  end
  return index
end

local function run_dag_slice(kind, label)
  if not require_server_ready() then
    return
  end
  local bufnr = vim.api.nvim_get_current_buf()
  local index = current_code_cell_index(bufnr)
  if index == nil then
    return
  end
  sync_now(bufnr)
  client.request("dag_query", { kind = kind, index = index }, function(decoded)
    if not decoded.ok then
      vim.notify("[ipynb-peek] " .. label .. ": " .. tostring(decoded.error), vim.log.levels.ERROR)
      return
    end
    run_indices(bufnr, decoded.indices or {}, label)
  end)
end

function M.run_affected()
  run_dag_slice("affected", "run affected")
end

function M.run_slice()
  run_dag_slice("upstream", "run slice")
end

local function sorted_numeric_keys(tbl)
  local keys = {}
  for k in pairs(tbl or {}) do
    local n = tonumber(k)
    if n ~= nil then
      table.insert(keys, { key = k, num = n })
    end
  end
  table.sort(keys, function(a, b)
    return a.num < b.num
  end)
  return keys
end

local function append_dep_section(lines, row_targets, heading, arrow, map)
  table.insert(lines, "")
  table.insert(lines, heading)
  local entries = sorted_numeric_keys(map)
  if #entries == 0 then
    table.insert(lines, "  (none)")
    return
  end
  for _, entry in ipairs(entries) do
    local syms = table.concat(map[entry.key] or {}, ", ")
    table.insert(lines, string.format("  %s #%d  (%s)", arrow, entry.num + 1, syms))
    row_targets[#lines] = entry.num
  end
end

local function format_deps_lines(index, decoded)
  local lines, row_targets = {}, {}
  local defs = decoded.defs or {}
  local reads = decoded.reads or {}
  local muts = decoded.mutations or {}

  table.insert(lines, string.format("Cell #%d dataflow", index + 1))
  row_targets[1] = index
  table.insert(lines, "  Defines  : " .. (#defs > 0 and table.concat(defs, ", ") or "(none)"))
  table.insert(lines, "  Reads    : " .. (#reads > 0 and table.concat(reads, ", ") or "(none)"))
  if #muts > 0 then
    table.insert(lines, "  Mutates  : " .. table.concat(muts, ", "))
  end
  append_dep_section(
    lines,
    row_targets,
    "Upstream producers (<CR> to jump):",
    "←",
    decoded.upstream
  )
  append_dep_section(
    lines,
    row_targets,
    "Downstream consumers (<CR> to jump):",
    "→",
    decoded.downstream
  )
  return lines, row_targets
end

function M.deps()
  if not require_server_ready() then
    return
  end
  local bufnr = vim.api.nvim_get_current_buf()
  local origin = vim.api.nvim_get_current_win()
  local index = current_code_cell_index(bufnr)
  if index == nil then
    return
  end
  sync_now(bufnr)
  client.request("dag_query", { kind = "deps", index = index }, function(decoded)
    if not decoded.ok then
      vim.notify("[ipynb-peek] deps: " .. tostring(decoded.error), vim.log.levels.ERROR)
      return
    end
    local lines, row_targets = format_deps_lines(index, decoded)
    float.open({
      title = string.format("Cell #%d Dependencies", index + 1),
      lines = lines,
      on_select = function(selected)
        local target_idx = row_targets[selected]
        if target_idx ~= nil then
          cells.jump_to_cell_in_window(origin, bufnr, target_idx, 1, true)
        end
      end,
    })
  end)
end

function M.audit()
  if not require_server_ready() then
    return
  end
  local bufnr = vim.api.nvim_get_current_buf()
  local origin = vim.api.nvim_get_current_win()
  sync_now(bufnr)
  client.request("dag_query", { kind = "audit" }, function(decoded)
    if not decoded.ok then
      vim.notify("[ipynb-peek] audit: " .. tostring(decoded.error), vim.log.levels.ERROR)
      return
    end
    local issues = decoded.issues or {}
    if #issues == 0 then
      vim.notify("[ipynb-peek] audit clean: no reproducibility issues found", vim.log.levels.INFO)
      return
    end
    local lines = {}
    for _, issue in ipairs(issues) do
      local kind = tostring(issue.kind or "issue")
      local msg = tostring(issue.message or "")
      table.insert(lines, string.format("[%s] %s", kind, msg))
    end
    float.open({
      title = "Notebook Audit",
      lines = lines,
      on_select = function(selected)
        local issue = issues[selected]
        if issue and type(issue.cell) == "number" then
          cells.jump_to_cell_in_window(origin, bufnr, issue.cell, 1, true)
        end
      end,
    })
  end)
end

function M.outline()
  require("ipynb-peek.outline").open()
end

function M.variables()
  if not require_server_ready() then
    return
  end
  vim.notify("[ipynb-peek] reading kernel variables…", vim.log.levels.INFO)
  client.request("variables", nil, function(decoded)
    if not decoded.ok then
      vim.notify("[ipynb-peek] variables: " .. tostring(decoded.error), vim.log.levels.ERROR)
      return
    end
    require("ipynb-peek.variables").show(decoded.variables or {})
  end)
end

function M.select_kernel()
  if not require_server_ready() then
    return
  end
  client.request("kernels", nil, function(decoded)
    if not decoded.ok then
      vim.notify("[ipynb-peek] kernels: " .. tostring(decoded.error), vim.log.levels.ERROR)
      return
    end
    local kernels = decoded.kernels or {}
    vim.ui.select(kernels, {
      prompt = "Jupyter kernel",
      format_item = function(kernel)
        local cur = kernel.name == decoded.current and "  (current)" or ""
        return string.format("%s  [%s]%s", kernel.display_name, kernel.name, cur)
      end,
    }, function(choice)
      if not choice or choice.name == decoded.current then
        return
      end
      cancel_run_all("kernel was changed")
      client.request("select_kernel", { name = choice.name }, function(result)
        if result.ok then
          vim.notify("[ipynb-peek] kernel set to " .. choice.name, vim.log.levels.INFO)
        else
          vim.notify("[ipynb-peek] " .. tostring(result.error), vim.log.levels.ERROR)
        end
      end)
    end)
  end)
end

function M.export(kind, path)
  if not require_server_ready() then
    return
  end
  if kind == "pdf" then
    client.request("print", nil, function(decoded)
      if not decoded.ok then
        vim.notify("[ipynb-peek] " .. tostring(decoded.error), vim.log.levels.ERROR)
      end
    end)
    return
  end
  if kind ~= "html" and kind ~= "report" then
    vim.notify("[ipynb-peek] export kind must be html, report or pdf", vim.log.levels.ERROR)
    return
  end
  client.request("export", { mode = kind, path = path }, function(decoded)
    if decoded.ok then
      vim.notify("[ipynb-peek] exported " .. decoded.path, vim.log.levels.INFO)
    else
      vim.notify("[ipynb-peek] export failed: " .. tostring(decoded.error), vim.log.levels.ERROR)
    end
  end)
end

function M.restart_kernel()
  if not require_server_ready() then
    return
  end
  cancel_run_all("kernel was restarted")
  client.request("restart", nil, function(decoded)
    if decoded.ok then
      vim.notify("[ipynb-peek] kernel restarted", vim.log.levels.INFO)
    else
      vim.notify("[ipynb-peek] restart error: " .. tostring(decoded.error), vim.log.levels.ERROR)
    end
  end)
end

function M.interrupt_kernel()
  if not require_server_ready() then
    return
  end
  client.request("interrupt", nil, function(decoded)
    if not decoded.ok then
      vim.notify("[ipynb-peek] interrupt error: " .. tostring(decoded.error), vim.log.levels.ERROR)
    end
  end)
end

local status_ns = vim.api.nvim_create_namespace("ipynb-peek-status")

local function apply_cell_status(bufnr, status_info, parsed)
  if not M.config.inline_status or type(status_info) ~= "table" then
    return
  end
  if type(bufnr) ~= "number" or not vim.api.nvim_buf_is_valid(bufnr) then
    return
  end
  local idx = status_info.index
  if type(idx) ~= "number" then
    return
  end
  parsed = parsed or cells.parse(bufnr)
  local cell = parsed[idx + 1]
  if not cell then
    return
  end

  local stale_info = runtime.stale[idx]
  local icon = status.icon_for(status_info, stale_info)
  if not icon then
    vim.api.nvim_buf_del_extmark(bufnr, status_ns, idx + 1)
    return
  end

  local virt = status.virt_text_for(status_info, stale_info)
  local is_stale_hl = stale_info and not status_info.has_error and status_info.status ~= "busy"
  vim.api.nvim_buf_set_extmark(bufnr, status_ns, cell.start_line - 1, 0, {
    id = idx + 1,
    sign_text = icon.sign_text,
    sign_hl_group = icon.hl_group,
    virt_text = virt ~= "" and { { virt, is_stale_hl and "DiagnosticWarn" or "Comment" } } or nil,
  })
end

local function apply_cells_status(bufnr, cells_status)
  if not M.config.inline_status or not vim.api.nvim_buf_is_valid(bufnr) then
    return
  end
  vim.api.nvim_buf_clear_namespace(bufnr, status_ns, 0, -1)
  local parsed = cells.parse(bufnr)
  local seen = {}
  for _, status_info in ipairs(type(cells_status) == "table" and cells_status or {}) do
    if type(status_info) == "table" and type(status_info.index) == "number" then
      seen[status_info.index] = true
      apply_cell_status(bufnr, status_info, parsed)
    end
  end
  for idx in pairs(runtime.stale) do
    if not seen[idx] then
      apply_cell_status(bufnr, runtime.cells[idx] or { index = idx, status = "idle" }, parsed)
    end
  end
end

local function refresh_all_statuses(bufnr)
  local list = {}
  for _, info in pairs(runtime.cells) do
    table.insert(list, info)
  end
  apply_cells_status(bufnr, list)
end

local function open_file_at(path, line)
  if type(path) ~= "string" or vim.fn.filereadable(path) ~= 1 then
    vim.notify("[ipynb-peek] can't open " .. tostring(path), vim.log.levels.WARN)
    return
  end
  vim.cmd("split " .. vim.fn.fnameescape(path))
  if type(line) == "number" then
    pcall(vim.api.nvim_win_set_cursor, 0, { math.max(1, line), 0 })
    vim.cmd("normal! zz")
  end
end

local function handle_event(bufnr, decoded)
  if type(decoded) ~= "table" or not vim.api.nvim_buf_is_valid(bufnr) then
    return
  end
  local etype = decoded.type
  if etype == "jump_cell_line" then
    cells.jump_to_cell_in_window(nil, bufnr, decoded.cell_index, decoded.line_offset, true)
  elseif etype == "goto_cell" then
    cells.jump_to_cell_in_window(nil, bufnr, decoded.index, 1, true)
  elseif etype == "open_file" then
    open_file_at(decoded.path, decoded.line)
  elseif etype == "kernel" then
    runtime.set_kernel(decoded)
  elseif etype == "cell_outputs" then
    ipynb.update_cell_outputs(bufnr, decoded.index, decoded.execution_count, decoded.outputs)
  elseif etype == "dag_status" then
    runtime.set_stale(decoded.stale or {})
    refresh_all_statuses(bufnr)
  elseif etype == "cell_status" and type(decoded.index) == "number" then
    runtime.set_cell(decoded)
    apply_cell_status(bufnr, decoded)
    local waiter = run_all_waiters[decoded.index]
    if waiter and decoded.status == "idle" then
      run_all_waiters[decoded.index] = nil
      waiter(decoded)
    end
  elseif etype == "cells_status" and type(decoded.cells) == "table" then
    runtime.set_all(decoded.cells)
    apply_cells_status(bufnr, decoded.cells)
  end
end

local startup_timer = nil

local function stop_startup_timer()
  local timer = startup_timer
  startup_timer = nil
  if timer and not timer:is_closing() then
    timer:stop()
    timer:close()
  end
end

local KEYMAP_ACTIONS = {
  open = {
    fn = function()
      M.open()
    end,
    desc = "ipynb-peek: open preview",
  },
  close = {
    fn = function()
      M.close()
    end,
    desc = "ipynb-peek: close preview",
  },
  run_cell = { fn = M.run_cell, desc = "ipynb-peek: run cell" },
  run_cell_advance = { fn = M.run_cell_and_advance, desc = "ipynb-peek: run cell and advance" },
  run_all = { fn = M.run_all, desc = "ipynb-peek: run all cells" },
  run_affected = { fn = M.run_affected, desc = "ipynb-peek: run affected downstream cells" },
  run_slice = { fn = M.run_slice, desc = "ipynb-peek: run minimal upstream slice" },
  deps = { fn = M.deps, desc = "ipynb-peek: inspect cell dependencies" },
  audit = { fn = M.audit, desc = "ipynb-peek: audit notebook reproducibility" },
  restart_kernel = { fn = M.restart_kernel, desc = "ipynb-peek: restart kernel" },
  interrupt_kernel = { fn = M.interrupt_kernel, desc = "ipynb-peek: interrupt kernel" },
  next_cell = { fn = M.jump_to_next_cell, desc = "ipynb-peek: jump to next code cell" },
  prev_cell = { fn = M.jump_to_previous_cell, desc = "ipynb-peek: jump to previous code cell" },
  goto_cell = { fn = M.jump_to_cell, desc = "ipynb-peek: jump to cell number" },
}

local function apply_keymaps(bufnr)
  for key, action in pairs(KEYMAP_ACTIONS) do
    local lhs = M.config.keymaps[key]
    if lhs then
      vim.keymap.set("n", lhs, action.fn, { buffer = bufnr, desc = action.desc })
    end
  end
  if M.config.text_objects ~= false then
    textobjects.apply(bufnr, M.config.text_objects)
  end
end

vim.api.nvim_create_autocmd({ "BufEnter", "BufWinEnter" }, {
  group = aug,
  pattern = "*.ipynb",
  callback = function(args)
    apply_keymaps(args.buf)
  end,
})

local function register_session_autocmds(bufnr)
  vim.api.nvim_clear_autocmds({ group = aug, buffer = bufnr })
  local last_cursor_index = nil

  local function send_cursor_update()
    client.debounce("cursor", M.config.cursor_debounce_ms, function()
      if not is_session_buf_live(bufnr) or vim.api.nvim_get_current_buf() ~= bufnr then
        return
      end
      local index = cells.cell_index_at(cells.parse(bufnr), vim.api.nvim_win_get_cursor(0)[1])
      if index == nil or index == last_cursor_index then
        return
      end
      last_cursor_index = index
      client.request("cursor", { index = index })
    end)
  end

  vim.api.nvim_create_autocmd("BufWritePost", {
    group = aug,
    buffer = bufnr,
    callback = function()
      sync_now(bufnr)
    end,
  })
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
  vim.api.nvim_create_autocmd("InsertEnter", {
    group = aug,
    buffer = bufnr,
    callback = function()
      local _, cell = cells.cell_index_at(cells.parse(bufnr), vim.api.nvim_win_get_cursor(0)[1])
      if cell and not cell.editable then
        vim.cmd("stopinsert")
        vim.notify(
          "[ipynb-peek] this cell is marked read-only (editable: false)",
          vim.log.levels.WARN
        )
      end
    end,
  })
  vim.api.nvim_create_autocmd({ "BufDelete", "BufWipeout" }, {
    group = aug,
    buffer = bufnr,
    callback = M.close,
  })
end

function M.open()
  local bufnr = vim.api.nvim_get_current_buf()
  if not vim.api.nvim_buf_get_name(bufnr):match("%.ipynb$") then
    vim.notify("[ipynb-peek] the current buffer is not an .ipynb notebook", vim.log.levels.ERROR)
    return
  end
  local id, reason = session.begin(bufnr)
  if not id then
    if reason == "same-buffer" then
      vim.notify(
        "[ipynb-peek] preview already open for this notebook - :IpynbPeekClose first",
        vim.log.levels.WARN
      )
    else
      vim.notify(
        "[ipynb-peek] a preview is already open for another notebook - :IpynbPeekClose first",
        vim.log.levels.ERROR
      )
    end
    return
  end
  runtime.reset()

  local function stale()
    return not session.is_current(id)
  end

  local function fail_open(message)
    session.fail(id, message)
    M.close()
    vim.notify("[ipynb-peek] " .. message, vim.log.levels.ERROR)
  end

  local function on_ready()
    if stale() or not session.activate(id) then
      return
    end
    stop_startup_timer()
    browser.open(server.url, M.config.browser)
    warn_if_unparseable(cells.parse(bufnr))
    schedule_render(bufnr, 0)
  end

  local started = server.start({
    server_script = M.config.server_script,
    python = M.config.python,
    on_ready = on_ready,
    on_event = function(event)
      if not stale() then
        handle_event(bufnr, event)
      end
    end,
    on_exit = function()
      if stale() then
        return
      end
      if session.is_active() then
        session.fail(id, server.error)
        M.close()
      else
        fail_open(server.error)
      end
    end,
  })
  if started == false then
    fail_open(tostring(server.error))
    return
  end

  stop_startup_timer()
  local timer = uv.new_timer()
  startup_timer = timer
  timer:start(M.config.startup_timeout_ms, 0, function()
    if not timer:is_closing() then
      timer:stop()
      timer:close()
    end
    if startup_timer == timer then
      startup_timer = nil
    end
    vim.schedule(function()
      if not stale() and not session.is_active() then
        fail_open("preview server timed out after " .. M.config.startup_timeout_ms .. "ms")
      end
    end)
  end)

  register_session_autocmds(bufnr)
  apply_keymaps(bufnr)
end

function M.close()
  cancel_run_all()
  stop_startup_timer()
  client.cancel_debounced()
  server.stop()
  local bufnr = session.finish()
  if bufnr and vim.api.nvim_buf_is_valid(bufnr) then
    vim.api.nvim_clear_autocmds({ group = aug, buffer = bufnr })
    vim.api.nvim_buf_clear_namespace(bufnr, status_ns, 0, -1)
  end
  cells.invalidate(bufnr)
  runtime.reset()
end

vim.api.nvim_create_user_command("IpynbPeekOpen", M.open, {})
vim.api.nvim_create_user_command("IpynbPeekClose", M.close, {})
vim.api.nvim_create_user_command("IpynbPeekRunCell", function()
  M.run_cell()
end, {})
vim.api.nvim_create_user_command("IpynbPeekRunCellAndAdvance", M.run_cell_and_advance, {})
vim.api.nvim_create_user_command("IpynbPeekRunAll", M.run_all, {})
vim.api.nvim_create_user_command("IpynbPeekRunAffected", M.run_affected, {})
vim.api.nvim_create_user_command("IpynbPeekRunSlice", M.run_slice, {})
vim.api.nvim_create_user_command("IpynbPeekDeps", M.deps, {})
vim.api.nvim_create_user_command("IpynbPeekAudit", M.audit, {})
vim.api.nvim_create_user_command("IpynbPeekRestartKernel", M.restart_kernel, {})
vim.api.nvim_create_user_command("IpynbPeekInterruptKernel", M.interrupt_kernel, {})
vim.api.nvim_create_user_command("IpynbPeekNextCodeCell", M.jump_to_next_cell, {})
vim.api.nvim_create_user_command("IpynbPeekPreviousCodeCell", M.jump_to_previous_cell, {})
vim.api.nvim_create_user_command("IpynbPeekOutline", M.outline, {})
vim.api.nvim_create_user_command("IpynbPeekVariables", M.variables, {})
vim.api.nvim_create_user_command("IpynbPeekSelectKernel", M.select_kernel, {})
vim.api.nvim_create_user_command("IpynbPeekExport", function(opts)
  local kind, path = opts.fargs[1], opts.fargs[2]
  M.export(kind or "html", path and vim.fn.fnamemodify(path, ":p") or nil)
end, {
  nargs = "*",
  complete = function(_, line)
    return #vim.split(line, "%s+") <= 2 and { "html", "report", "pdf" } or {}
  end,
})
vim.api.nvim_create_user_command("IpynbPeekGotoCell", function(opts)
  M.jump_to_cell(opts.args ~= "" and opts.args or nil)
end, { nargs = "?" })

return M
