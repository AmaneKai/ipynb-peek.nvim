--- Stubbed before requiring ipynb-peek itself, so M.jump_to_next_cell/
--- M.jump_to_previous_cell (pure buffer navigation, no server involved) can
--- be exercised without spawning a real server/browser/curl process.
local server_start_calls = 0
local server_stub = {
  port = 1,
  ready = false,
  url = nil,
  start = function()
    server_start_calls = server_start_calls + 1
    return true
  end,
  stop = function() end,
}
package.loaded["ipynb-peek.server"] = server_stub
package.loaded["ipynb-peek.browser"] =
  { find = function() end, open = function() end, close = function() end }
package.loaded["ipynb-peek.client"] = {
  request = function() end,
  debounced_request = function() end,
  cancel_debounced = function() end,
}

local M = require("ipynb-peek")

local function make_buffer(lines)
  local bufnr = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, lines)
  vim.api.nvim_set_current_buf(bufnr)
  return bufnr
end

describe("M.jump_to_next_cell / M.jump_to_previous_cell", function()
  local lines = { "# %%", "1", "", "# %%", "2", "", "# %%", "3", "", "# %%", "4" }

  -- vim.v.count1 only resets once a normal-mode command actually finishes
  -- executing - it does NOT reset just because a test calls
  -- M.jump_to_next_cell() directly (bypassing normal keypress handling).
  -- Without this, a count fed via nvim_feedkeys in one test (e.g. "10]j")
  -- leaks into every later test that calls the function directly, since
  -- nothing else ever resets it back to 1 in between. Confirmed directly:
  -- a test placed after the count-feedkeys tests below saw count1 still
  -- at 10 and silently jumped 10 cells instead of 1.
  before_each(function()
    vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<Esc>", true, false, true), "x", false)
  end)

  it("jumps to the next cell's body", function()
    make_buffer(lines)
    vim.api.nvim_win_set_cursor(0, { 2, 0 })

    M.jump_to_next_cell()

    assert.are.equal(5, vim.api.nvim_win_get_cursor(0)[1])
  end)

  it("jumps to the previous cell's body", function()
    make_buffer(lines)
    vim.api.nvim_win_set_cursor(0, { 8, 0 })

    M.jump_to_previous_cell()

    assert.are.equal(5, vim.api.nvim_win_get_cursor(0)[1])
  end)

  -- Regression test: an `and/or` ternary in jump_cell's loop
  -- (`direction == "next" and cells.cell_after(...) or cells.cell_before(...)`)
  -- silently stepped backward here instead of stopping, since cell_after
  -- returning nil (the last cell has none) made the whole `and` chain nil,
  -- falling through to the `or` side - confirmed by actually running it,
  -- not caught by reading the code.
  it("stays on the last cell rather than stepping backward", function()
    make_buffer(lines)
    vim.api.nvim_win_set_cursor(0, { 11, 0 })

    M.jump_to_next_cell()

    assert.are.equal(11, vim.api.nvim_win_get_cursor(0)[1])
  end)

  it("stays on the first cell rather than stepping forward", function()
    make_buffer(lines)
    vim.api.nvim_win_set_cursor(0, { 2, 0 })

    M.jump_to_previous_cell()

    assert.are.equal(2, vim.api.nvim_win_get_cursor(0)[1])
  end)

  it("jumps into the first cell when the cursor starts above all markers", function()
    make_buffer({ "# leading comment", "# %%", "1" })
    vim.api.nvim_win_set_cursor(0, { 1, 0 })

    M.jump_to_next_cell()

    assert.are.equal(3, vim.api.nvim_win_get_cursor(0)[1])
  end)

  -- vim.v.count1 is read-only from Lua - a real keypress through an actual
  -- mapping is the only way to genuinely exercise it, rather than a direct
  -- M.jump_to_next_cell() call (which always sees count1 == 1).
  it("honors a numeric count typed before the mapped key", function()
    local bufnr = make_buffer(lines)
    vim.keymap.set("n", "]j", M.jump_to_next_cell, { buffer = bufnr })
    vim.api.nvim_win_set_cursor(0, { 2, 0 })

    vim.api.nvim_feedkeys("2]j", "x", false)

    assert.are.equal(8, vim.api.nvim_win_get_cursor(0)[1])
  end)

  it("stops early via a real keypress once a large count runs out of cells", function()
    local bufnr = make_buffer(lines)
    vim.keymap.set("n", "]j", M.jump_to_next_cell, { buffer = bufnr })
    vim.api.nvim_win_set_cursor(0, { 2, 0 })

    vim.api.nvim_feedkeys("10]j", "x", false)

    assert.are.equal(11, vim.api.nvim_win_get_cursor(0)[1])
  end)

  describe("skipping markdown cells", function()
    -- cell0 markdown (lines 1-2), cell1 code (lines 3-4),
    -- cell2 markdown (lines 5-6), cell3 code (lines 7-8)
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

    it("jumps over an intervening markdown cell to land on the next code cell", function()
      make_buffer(mixed)
      vim.api.nvim_win_set_cursor(0, { 4, 0 }) -- inside cell1 (code)

      M.jump_to_next_cell()

      assert.are.equal(8, vim.api.nvim_win_get_cursor(0)[1]) -- cell3, not cell2
    end)

    it("jumps out of a markdown cell to the next code cell without consuming the count", function()
      make_buffer(mixed)
      vim.api.nvim_win_set_cursor(0, { 1, 0 }) -- inside cell0 (markdown)

      M.jump_to_next_cell()

      assert.are.equal(4, vim.api.nvim_win_get_cursor(0)[1]) -- cell1, the first code cell
    end)

    it(
      "jumps into the first code cell when the cursor starts above all markers, skipping a leading markdown cell",
      function()
        make_buffer(vim.list_extend({ "# leading comment" }, mixed))
        vim.api.nvim_win_set_cursor(0, { 1, 0 })

        M.jump_to_next_cell()

        assert.are.equal(5, vim.api.nvim_win_get_cursor(0)[1]) -- cell1 (code), one line later than `mixed` alone
      end
    )

    it("skips a markdown cell going backward too", function()
      make_buffer(mixed)
      vim.api.nvim_win_set_cursor(0, { 8, 0 }) -- inside cell3 (code)

      M.jump_to_previous_cell()

      assert.are.equal(4, vim.api.nvim_win_get_cursor(0)[1]) -- cell1, not cell2
    end)
  end)
end)

describe("M.open notebook isolation", function()
  it("rejects a second notebook instead of sharing singleton server state", function()
    local first = make_buffer({ "# %%", "1" })
    vim.api.nvim_buf_set_name(first, vim.fn.tempname() .. ".ipynb")
    M.open()

    local second = make_buffer({ "# %%", "2" })
    vim.api.nvim_buf_set_name(second, vim.fn.tempname() .. ".ipynb")
    local notifications = {}
    local original_notify = vim.notify
    vim.notify = function(message)
      table.insert(notifications, message)
    end
    M.open()
    vim.notify = original_notify

    assert.are.equal(1, server_start_calls)
    assert.is_true(notifications[1]:find("already open for another notebook", 1, true) ~= nil)
    M.close()
  end)
end)
