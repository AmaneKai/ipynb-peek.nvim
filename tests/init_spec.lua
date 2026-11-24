local server_start_calls = 0
local last_start_opts = nil
local requests = {}
local cancelled_keys = {}

local server_stub = {
  port = 1,
  ready = true,
  url = "http://127.0.0.1:1/?token=t",
  start = function(opts)
    server_start_calls = server_start_calls + 1
    last_start_opts = opts
    return true
  end,
  stop = function() end,
}
package.loaded["ipynb-peek.server"] = server_stub
package.loaded["ipynb-peek.browser"] = { open = function() end }
package.loaded["ipynb-peek.client"] = {
  request = function(cmd, fields, cb)
    table.insert(requests, { cmd = cmd, fields = fields, cb = cb })
  end,
  debounce = function(_, _, callback)
    callback()
  end,
  debounced_request = function() end,
  cancel_key = function(key)
    table.insert(cancelled_keys, key)
  end,
  cancel_debounced = function() end,
}

local M = require("ipynb-peek")
local session = require("ipynb-peek.session")

local function make_buffer(lines, name)
  local bufnr = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, lines)
  if name then
    vim.api.nvim_buf_set_name(bufnr, name)
  end
  vim.api.nvim_set_current_buf(bufnr)
  return bufnr
end

describe("M.jump_to_next_cell / M.jump_to_previous_cell", function()
  local lines = { "# %%", "1", "", "# %%", "2", "", "# %%", "3", "", "# %%", "4" }

  before_each(function()
    local esc = vim.api.nvim_replace_termcodes("<Esc>", true, false, true)
    vim.api.nvim_feedkeys(esc, "x", false)
  end)

  it("jumps forward and backward and stops cleanly at ends", function()
    make_buffer(lines)
    vim.api.nvim_win_set_cursor(0, { 2, 0 })
    M.jump_to_next_cell()
    assert.are.equal(5, vim.api.nvim_win_get_cursor(0)[1])
    M.jump_to_previous_cell()
    assert.are.equal(2, vim.api.nvim_win_get_cursor(0)[1])
    M.jump_to_previous_cell()
    assert.are.equal(2, vim.api.nvim_win_get_cursor(0)[1])
    vim.api.nvim_win_set_cursor(0, { 11, 0 })
    M.jump_to_next_cell()
    assert.are.equal(11, vim.api.nvim_win_get_cursor(0)[1])
  end)

  it("honors counts via mapped keys and skips markdown cells", function()
    local mixed = {
      "# %% [markdown]",
      "# Heading 1",
      "# %%",
      "code1",
      "# %% [markdown]",
      "# Heading 2",
      "# %%",
      "code2",
    }
    local bufnr = make_buffer(mixed)
    vim.keymap.set("n", "]j", M.jump_to_next_cell, { buffer = bufnr })
    vim.api.nvim_win_set_cursor(0, { 1, 0 })
    vim.api.nvim_feedkeys("2]j", "x", false)
    assert.are.equal(8, vim.api.nvim_win_get_cursor(0)[1])
  end)
end)

describe("M.jump_to_cell", function()
  local lines = { "# %%", "1", "", "# %%", "2", "", "# %%", "3" }

  before_each(function()
    local esc = vim.api.nvim_replace_termcodes("<Esc>", true, false, true)
    vim.api.nvim_feedkeys(esc, "x", false)
  end)

  it("jumps directly when given a valid target", function()
    make_buffer(lines)
    vim.api.nvim_win_set_cursor(0, { 2, 0 })
    M.jump_to_cell(3)
    assert.are.equal(8, vim.api.nvim_win_get_cursor(0)[1])
  end)

  it("warns instead of prompting on explicit invalid targets (0, -1, 'foo')", function()
    make_buffer(lines)
    vim.api.nvim_win_set_cursor(0, { 2, 0 })
    local prompted = false
    local warnings = {}
    local orig_input = vim.ui.input
    local orig_notify = vim.notify
    vim.ui.input = function()
      prompted = true
    end
    vim.notify = function(msg)
      table.insert(warnings, msg)
    end

    M.jump_to_cell(0)
    M.jump_to_cell(-1)
    M.jump_to_cell("foo")

    vim.ui.input = orig_input
    vim.notify = orig_notify

    assert.is_false(prompted)
    assert.are.equal(3, #warnings)
    assert.are.equal(2, vim.api.nvim_win_get_cursor(0)[1])
  end)
end)

describe("M.open / M.close regressions", function()
  before_each(function()
    M.close()
    requests = {}
    cancelled_keys = {}
    server_start_calls = 0
  end)

  after_each(function()
    M.close()
  end)

  it("clears buffer-local autocmds on M.close() so old buffer delete keeps new session", function()
    local first = make_buffer({ "# %%", "x = 1" }, vim.fn.tempname() .. ".ipynb")
    M.open()
    last_start_opts.on_ready()
    assert.is_true(session.is_active())
    M.close()

    local second = make_buffer({ "# %%", "y = 2" }, vim.fn.tempname() .. ".ipynb")
    M.open()
    last_start_opts.on_ready()
    assert.is_true(session.is_active())
    assert.are.equal(second, session.bufnr)

    vim.api.nvim_buf_delete(first, { force = true })
    assert.is_true(session.is_active())
    assert.are.equal(second, session.bufnr)
  end)

  it("does not trigger render on BufEnter or BufWritePost (uses sync on save)", function()
    local bufnr = make_buffer({ "# %%", "x = 1" }, vim.fn.tempname() .. ".ipynb")
    M.open()
    last_start_opts.on_ready()
    requests = {}

    vim.api.nvim_exec_autocmds("BufEnter", { buffer = bufnr })
    assert.are.equal(0, #requests)

    vim.api.nvim_exec_autocmds("BufWritePost", { buffer = bufnr })
    assert.are.equal(1, #requests)
    assert.are.equal("sync", requests[1].cmd)
  end)

  it("flushes sync_now before dag_query in run_affected, run_slice, deps, audit", function()
    local lines = { "# %%", "a = 1", "# %%", "b = 2", "# %%", "c = a + 3" }
    make_buffer(lines, vim.fn.tempname() .. ".ipynb")
    M.open()
    last_start_opts.on_ready()
    requests = {}
    cancelled_keys = {}

    vim.api.nvim_win_set_cursor(0, { 2, 0 })
    M.run_affected()
    assert.are.equal("sync", cancelled_keys[1])
    assert.are.equal("sync", requests[1].cmd)
    assert.are.equal("dag_query", requests[2].cmd)
    assert.are.equal("affected", requests[2].fields.kind)
    assert.are.equal(0, requests[2].fields.index)

    requests[2].cb({ ok = true, indices = { 0, 2 } })
    assert.are.equal("execute", requests[3].cmd)
    assert.are.equal(0, requests[3].fields.index)

    last_start_opts.on_event({
      type = "cell_status",
      index = 0,
      status = "idle",
      execution_count = 1,
      has_error = false,
    })
    assert.are.equal("execute", requests[4].cmd)
    assert.are.equal(2, requests[4].fields.index)

    -- run_slice
    requests = {}
    vim.api.nvim_win_set_cursor(0, { 6, 0 })
    M.run_slice()
    assert.are.equal("sync", requests[1].cmd)
    assert.are.equal("dag_query", requests[2].cmd)
    assert.are.equal("upstream", requests[2].fields.kind)

    -- deps & audit
    requests = {}
    M.deps()
    assert.are.equal("sync", requests[1].cmd)
    assert.are.equal("dag_query", requests[2].cmd)
    assert.are.equal("deps", requests[2].fields.kind)

    requests = {}
    M.audit()
    assert.are.equal("sync", requests[1].cmd)
    assert.are.equal("dag_query", requests[2].cmd)
    assert.are.equal("audit", requests[2].fields.kind)
  end)

  it("rejects a second notebook while one preview is open", function()
    local first = make_buffer({ "# %%", "1" }, vim.fn.tempname() .. ".ipynb")
    M.open()
    make_buffer({ "# %%", "2" }, vim.fn.tempname() .. ".ipynb")
    local notifications = {}
    local orig_notify = vim.notify
    vim.notify = function(msg)
      table.insert(notifications, msg)
    end
    M.open()
    vim.notify = orig_notify
    assert.are.equal(1, server_start_calls)
    assert.is_truthy(notifications[1]:find("already open for another notebook", 1, true))
    assert.are.equal(first, session.bufnr)
  end)

  it("tears down cleanly on unexpected server exit while active", function()
    make_buffer({ "# %%", "1" }, vim.fn.tempname() .. ".ipynb")
    M.open()
    last_start_opts.on_ready()
    assert.is_true(session.is_active())

    last_start_opts.on_exit()
    assert.are.equal("idle", session.state)
  end)
end)
