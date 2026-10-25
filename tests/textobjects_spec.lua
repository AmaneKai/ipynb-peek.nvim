local cells = require("ipynb-peek.cells")
local textobjects = require("ipynb-peek.textobjects")
local runtime = require("ipynb-peek.runtime")

local function make_buffer(lines)
  local bufnr = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, lines)
  vim.api.nvim_set_current_buf(bufnr)
  return bufnr
end

local lines = { "# %%", "a = 1", "b = 2", "# %%", "c = 3", "# %%", "# %%", "d = 4" }

describe("textobjects.range", function()
  it("inner excludes the marker, around includes it", function()
    local parsed = cells.parse(make_buffer(lines))
    assert.are.same({ 2, 3 }, { textobjects.range(parsed[1], "inner") })
    assert.are.same({ 1, 3 }, { textobjects.range(parsed[1], "around") })
  end)

  it("has no inner range for a bare marker", function()
    local parsed = cells.parse(make_buffer(lines))
    assert.is_nil(textobjects.range(parsed[3], "inner"))
    assert.are.same({ 6, 6 }, { textobjects.range(parsed[3], "around") })
  end)
end)

describe("textobjects.select", function()
  it("`vic` selects the body linewise", function()
    make_buffer(lines)
    vim.api.nvim_win_set_cursor(0, { 3, 0 })
    textobjects.select("inner")
    assert.are.equal("V", vim.fn.mode())
    assert.are.equal(2, vim.fn.line("v"))
    assert.are.equal(3, vim.fn.line("."))
    vim.cmd("normal! \27")
  end)

  it("`dac` deletes the cell including its marker", function()
    local bufnr = make_buffer(lines)
    vim.api.nvim_win_set_cursor(0, { 5, 0 })
    textobjects.select("around")
    vim.cmd("normal! d")
    assert.are.same(
      { "# %%", "a = 1", "b = 2", "# %%", "# %%", "d = 4" },
      vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
    )
  end)
end)

describe("textobjects boundary motions", function()
  local parsed
  before_each(function()
    parsed = cells.parse(make_buffer(lines))
  end)

  it("finds the next marker, and nothing after the last", function()
    assert.are.equal(4, textobjects.boundary_target(parsed, 2, "next"))
    assert.is_nil(textobjects.boundary_target(parsed, 7, "next"))
  end)

  it("goes to this cell's own marker first, then the previous one", function()
    assert.are.equal(4, textobjects.boundary_target(parsed, 5, "prev"))
    assert.are.equal(1, textobjects.boundary_target(parsed, 4, "prev"))
    assert.is_nil(textobjects.boundary_target(parsed, 1, "prev"))
  end)
end)

describe("textobjects.error_target", function()
  local parsed
  before_each(function()
    parsed = cells.parse(make_buffer(lines))
  end)

  it("walks to the next and previous errored cell", function()
    local errors = { [0] = false, [1] = true, [2] = false, [3] = true }
    local has_error = function(i)
      return errors[i] == true
    end
    assert.are.equal(4, textobjects.error_target(parsed, 1, "next", has_error))
    assert.are.equal(7, textobjects.error_target(parsed, 4, "next", has_error))
    assert.is_nil(textobjects.error_target(parsed, 7, "next", has_error))
    assert.are.equal(4, textobjects.error_target(parsed, 7, "prev", has_error))
  end)
end)

describe("runtime", function()
  before_each(function()
    runtime.reset()
  end)

  it("tracks error cells and busy time", function()
    runtime.set_cell({ index = 2, status = "idle", has_error = true })
    assert.is_true(runtime.has_error(2))
    assert.is_false(runtime.has_error(0))

    runtime.set_cell({ index = 1, status = "busy" })
    local index = runtime.busy()
    assert.are.equal(1, index)
    runtime.set_cell({ index = 1, status = "idle" })
    assert.is_nil(runtime.busy())
  end)

  it("replaces everything on a full snapshot", function()
    runtime.set_cell({ index = 5, status = "idle", has_error = true })
    runtime.set_all({ { index = 0, status = "idle", has_error = false } })
    assert.is_false(runtime.has_error(5))
  end)
end)
