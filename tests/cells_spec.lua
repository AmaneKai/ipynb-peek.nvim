local cells = require("ipynb-peek.cells")

--- Creates a scratch buffer with the given lines, matching how a real
--- jupytext-converted `.ipynb` buffer looks once opened in Neovim.
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
    assert.are.same(
      { start_line = 1, end_line = 2, cell_type = "code", tags = {}, editable = true, deletable = true },
      parsed[1]
    )
  end)

  it("splits multiple cells at each `# %%` marker", function()
    local bufnr = make_buffer({ "# %%", "1 + 1", "# %%", "2 + 2" })
    local parsed = cells.parse(bufnr)
    assert.are.equal(2, #parsed)
    assert.are.same(
      { start_line = 1, end_line = 2, cell_type = "code", tags = {}, editable = true, deletable = true },
      parsed[1]
    )
    assert.are.same(
      { start_line = 3, end_line = 4, cell_type = "code", tags = {}, editable = true, deletable = true },
      parsed[2]
    )
  end)

  it("detects a `# %% [markdown]` marker as a markdown cell", function()
    local bufnr = make_buffer({ "# %% [markdown]", "# hello" })
    local parsed = cells.parse(bufnr)
    assert.are.equal(1, #parsed)
    assert.are.equal("markdown", parsed[1].cell_type)
  end)

  it("detects a `# %% [raw]` marker as a raw cell", function()
    local bufnr = make_buffer({ "# %% [raw]", "some raw text" })
    local parsed = cells.parse(bufnr)
    assert.are.equal(1, #parsed)
    assert.are.equal("raw", parsed[1].cell_type)
  end)

  it("ignores buffer content before the first marker", function()
    local bufnr = make_buffer({ "# a leading comment", "# %%", "code" })
    local parsed = cells.parse(bufnr)
    assert.are.equal(1, #parsed)
    assert.are.equal(2, parsed[1].start_line)
  end)

  it("parses tags off the marker line", function()
    local bufnr = make_buffer({ '# %% tags=["skip-run-all", "slow"]', "1 + 1" })
    local parsed = cells.parse(bufnr)
    assert.are.same({ "skip-run-all", "slow" }, parsed[1].tags)
  end)

  it("defaults tags to an empty table when the marker has none", function()
    local bufnr = make_buffer({ "# %%", "1 + 1" })
    local parsed = cells.parse(bufnr)
    assert.are.same({}, parsed[1].tags)
  end)

  it("parses editable=false and deletable=false off the marker line", function()
    local bufnr = make_buffer({ "# %% deletable=false editable=false", "1 + 1" })
    local parsed = cells.parse(bufnr)
    assert.is_false(parsed[1].editable)
    assert.is_false(parsed[1].deletable)
  end)

  it("defaults editable and deletable to true when the marker has neither", function()
    local bufnr = make_buffer({ "# %%", "1 + 1" })
    local parsed = cells.parse(bufnr)
    assert.is_true(parsed[1].editable)
    assert.is_true(parsed[1].deletable)
  end)
end)

describe("cells.cell_index_at", function()
  it("returns the 0-based index and cell for a line inside it", function()
    local bufnr = make_buffer({ "# %%", "1 + 1", "# %%", "2 + 2" })
    local parsed = cells.parse(bufnr)

    local index, cell = cells.cell_index_at(parsed, 4)

    assert.are.equal(1, index)
    assert.are.equal("code", cell.cell_type)
  end)

  it("returns nil when the line sits before the first marker", function()
    local bufnr = make_buffer({ "# leading comment", "# %%", "code" })
    local parsed = cells.parse(bufnr)

    assert.is_nil(cells.cell_index_at(parsed, 1))
  end)
end)

describe("cells.cell_after", function()
  it("returns the cell right after the given 0-based index", function()
    local bufnr = make_buffer({ "# %%", "1 + 1", "# %%", "2 + 2", "# %%", "3 + 3" })
    local parsed = cells.parse(bufnr)

    local next_cell = cells.cell_after(parsed, 0)

    assert.are.same(parsed[2], next_cell)
  end)

  it("returns nil for the last cell", function()
    local bufnr = make_buffer({ "# %%", "1 + 1", "# %%", "2 + 2" })
    local parsed = cells.parse(bufnr)

    assert.is_nil(cells.cell_after(parsed, 1))
  end)

  it("returns nil for an empty cell list", function()
    assert.is_nil(cells.cell_after({}, 0))
  end)
end)

describe("cells.cell_before", function()
  it("returns the cell right before the given 0-based index", function()
    local bufnr = make_buffer({ "# %%", "1 + 1", "# %%", "2 + 2", "# %%", "3 + 3" })
    local parsed = cells.parse(bufnr)

    local prev_cell = cells.cell_before(parsed, 1)

    assert.are.same(parsed[1], prev_cell)
  end)

  it("returns nil for the first cell", function()
    local bufnr = make_buffer({ "# %%", "1 + 1", "# %%", "2 + 2" })
    local parsed = cells.parse(bufnr)

    assert.is_nil(cells.cell_before(parsed, 0))
  end)

  it("returns nil for an empty cell list", function()
    assert.is_nil(cells.cell_before({}, 0))
  end)
end)

describe("cells.source", function()
  it("excludes the `# %%` marker line itself", function()
    local bufnr = make_buffer({ "# %%", "1 + 1", "2 + 2" })
    local parsed = cells.parse(bufnr)

    assert.are.equal("1 + 1\n2 + 2", cells.source(bufnr, parsed[1]))
  end)

  it("un-escapes a jupytext-commented line magic", function()
    local bufnr = make_buffer({ "# %%", '# %time print("hi")' })
    local parsed = cells.parse(bufnr)

    assert.are.equal('%time print("hi")', cells.source(bufnr, parsed[1]))
  end)

  it("un-escapes a jupytext-commented shell escape", function()
    local bufnr = make_buffer({ "# %%", "# !printf 'hi\\n'" })
    local parsed = cells.parse(bufnr)

    assert.are.equal("!printf 'hi\\n'", cells.source(bufnr, parsed[1]))
  end)


  it("preserves indentation when un-escaping a magic", function()
    local bufnr = make_buffer({ "# %%", "if True:", "    # %time foo()" })
    local parsed = cells.parse(bufnr)

    assert.are.equal("if True:\n    %time foo()", cells.source(bufnr, parsed[1]))
  end)

  it("leaves an ordinary comment starting with `#` untouched", function()
    local bufnr = make_buffer({ "# %%", "# just a regular comment", "1 + 1" })
    local parsed = cells.parse(bufnr)

    assert.are.equal("# just a regular comment\n1 + 1", cells.source(bufnr, parsed[1]))
  end)

  it("does not un-escape non-code cells", function()
    local bufnr = make_buffer({ "# %% [raw]", "# %not-a-magic-in-a-raw-cell" })
    local parsed = cells.parse(bufnr)

    assert.are.equal("# %not-a-magic-in-a-raw-cell", cells.source(bufnr, parsed[1]))
  end)
end)

describe("cells.display_source", function()
  it("leaves code cell source untouched", function()
    local bufnr = make_buffer({ "# %%", "1 + 1" })
    local parsed = cells.parse(bufnr)

    assert.are.equal("1 + 1", cells.display_source(bufnr, parsed[1]))
  end)

  it("strips jupytext's `# ` comment prefix from markdown cell lines", function()
    local bufnr = make_buffer({ "# %% [markdown]", "# # Title", "# some text" })
    local parsed = cells.parse(bufnr)

    assert.are.equal("# Title\nsome text", cells.display_source(bufnr, parsed[1]))
  end)

  it("strips jupytext's `# ` comment prefix from raw cell lines", function()
    local bufnr = make_buffer({ "# %% [raw]", "# some raw text" })
    local parsed = cells.parse(bufnr)

    assert.are.equal("some raw text", cells.display_source(bufnr, parsed[1]))
  end)
end)
