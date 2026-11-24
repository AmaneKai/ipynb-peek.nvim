local cells = require("ipynb-peek.cells")

local function make_buffer(lines)
  local bufnr = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, lines)
  return bufnr
end

describe("cells.parse", function()
  it("returns an empty table for a buffer with no `# %%` markers", function()
    local bufnr = make_buffer({ "import numpy as np", "np.array([1, 2, 3])" })
    assert.are.same({}, cells.parse(bufnr))
  end)

  it("parses a single code cell running to the end of the buffer", function()
    local bufnr = make_buffer({ "# %%", "1 + 1" })
    local parsed = cells.parse(bufnr)
    assert.are.equal(1, #parsed)
    assert.are.same({
      start_line = 1,
      end_line = 2,
      cell_type = "code",
      tags = {},
      editable = true,
      deletable = true,
    }, parsed[1])
  end)

  it("supports `#%%` without a space", function()
    local bufnr = make_buffer({ "#%%", "x = 1", "#%% [markdown]", "# hi" })
    local parsed = cells.parse(bufnr)
    assert.are.equal(2, #parsed)
    assert.are.equal("code", parsed[1].cell_type)
    assert.are.equal("markdown", parsed[2].cell_type)
  end)

  it("does NOT split cells on `# %%timeit` or `# %%bash`", function()
    local bufnr = make_buffer({ "# %%", "# %%timeit", "x = 1", "# %%bash", "y = 2" })
    local parsed = cells.parse(bufnr)
    assert.are.equal(1, #parsed)
    assert.are.equal(1, parsed[1].start_line)
    assert.are.equal(5, parsed[1].end_line)
  end)

  it("splits multiple cells at each `# %%` marker", function()
    local bufnr = make_buffer({ "# %%", "1 + 1", "# %%", "2 + 2" })
    local parsed = cells.parse(bufnr)
    assert.are.equal(2, #parsed)
    assert.are.equal(1, parsed[1].start_line)
    assert.are.equal(2, parsed[1].end_line)
    assert.are.equal(3, parsed[2].start_line)
    assert.are.equal(4, parsed[2].end_line)
  end)

  it("detects `# %% [markdown]` and `# %% [raw]` markers", function()
    local bufnr = make_buffer({ "# %% [markdown]", "# hello", "# %% [raw]", "# raw" })
    local parsed = cells.parse(bufnr)
    assert.are.equal("markdown", parsed[1].cell_type)
    assert.are.equal("raw", parsed[2].cell_type)
  end)

  it("ignores buffer content before the first marker", function()
    local bufnr = make_buffer({ "# a leading comment", "# %%", "code" })
    local parsed = cells.parse(bufnr)
    assert.are.equal(1, #parsed)
    assert.are.equal(2, parsed[1].start_line)
  end)

  it("parses mixed-quote tags in order without bogus apostrophe splits", function()
    local bufnr = make_buffer({ [=[# %% tags=["a'b", 'second', "third"]]=], "1 + 1" })
    local parsed = cells.parse(bufnr)
    assert.are.same({ "a'b", "second", "third" }, parsed[1].tags)
  end)

  it("enforces word boundaries for editable=false and deletable=false", function()
    local bufnr = make_buffer({
      "# %% uneditable=false undeletable=false",
      "1",
      "# %% deletable=false editable=false",
      "2",
    })
    local parsed = cells.parse(bufnr)
    assert.is_true(parsed[1].editable)
    assert.is_true(parsed[1].deletable)
    assert.is_false(parsed[2].editable)
    assert.is_false(parsed[2].deletable)
  end)

  it("reuses a parsed snapshot until changedtick advances and can invalidate", function()
    local bufnr = make_buffer({ "# %%", "1 + 1" })
    local first = cells.parse(bufnr)
    assert.is_true(rawequal(first, cells.parse(bufnr)))

    vim.api.nvim_buf_set_lines(bufnr, 2, 2, false, { "# %%", "2 + 2" })
    local updated = cells.parse(bufnr)
    assert.is_false(rawequal(first, updated))
    assert.are.equal(2, #updated)

    cells.invalidate(bufnr)
    assert.is_false(rawequal(updated, cells.parse(bufnr)))
  end)
end)

describe("cells navigation helpers", function()
  it("resolves cell_index_at, cell_after, and cell_before", function()
    local bufnr = make_buffer({ "# leading", "# %%", "1", "# %%", "2", "# %%", "3" })
    local parsed = cells.parse(bufnr)

    assert.is_nil(cells.cell_index_at(parsed, 1))
    local idx, cell = cells.cell_index_at(parsed, 5)
    assert.are.equal(1, idx)
    assert.are.equal("code", cell.cell_type)
    assert.are.same(parsed[3], cells.cell_after(parsed, 1))
    assert.is_nil(cells.cell_after(parsed, 2))
    assert.are.same(parsed[1], cells.cell_before(parsed, 1))
    assert.is_nil(cells.cell_before(parsed, 0))
  end)
end)

describe("cells.source and display_source", function()
  it("preserves comments like `# !TODO` and `# ?why` verbatim (no magic mangling)", function()
    local bufnr = make_buffer({
      "# %%",
      "# !TODO: fix this",
      "# ?why does this work",
      "x = 1",
    })
    local parsed = cells.parse(bufnr)
    local expected = "# !TODO: fix this\n# ?why does this work\nx = 1"
    assert.are.equal(expected, cells.source(bufnr, parsed[1]))
  end)

  it("trims a single trailing blank inter-cell separator before another cell", function()
    local bufnr = make_buffer({ "# %%", "a = 1", "", "# %%", "b = 2", "" })
    local parsed = cells.parse(bufnr)
    assert.are.equal("a = 1", cells.source(bufnr, parsed[1]))
    -- Last cell preserves its own trailing blank line
    assert.are.equal("b = 2\n", cells.source(bufnr, parsed[2]))
  end)

  it("strips `# ` comment prefixes in markdown and raw cells", function()
    local bufnr = make_buffer({
      "# %% [markdown]",
      "# # Title",
      "#",
      "# paragraph",
      "",
      "# %% [raw]",
      "# raw text",
    })
    local parsed = cells.parse(bufnr)
    assert.are.equal("# Title\n\nparagraph", cells.display_source(bufnr, parsed[1]))
    assert.are.equal("raw text", cells.display_source(bufnr, parsed[2]))
  end)
end)
