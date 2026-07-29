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
    assert.are.same({ start_line = 1, end_line = 2, cell_type = "code" }, parsed[1])
  end)

  it("splits multiple cells at each `# %%` marker", function()
    local bufnr = make_buffer({ "# %%", "1 + 1", "# %%", "2 + 2" })
    local parsed = cells.parse(bufnr)
    assert.are.equal(2, #parsed)
    assert.are.same({ start_line = 1, end_line = 2, cell_type = "code" }, parsed[1])
    assert.are.same({ start_line = 3, end_line = 4, cell_type = "code" }, parsed[2])
  end)

  it("detects a `# %% [markdown]` marker as a markdown cell", function()
    local bufnr = make_buffer({ "# %% [markdown]", "# hello" })
    local parsed = cells.parse(bufnr)
    assert.are.equal(1, #parsed)
    assert.are.equal("markdown", parsed[1].cell_type)
  end)

  it("ignores buffer content before the first marker", function()
    local bufnr = make_buffer({ "# a leading comment", "# %%", "code" })
    local parsed = cells.parse(bufnr)
    assert.are.equal(1, #parsed)
    assert.are.equal(2, parsed[1].start_line)
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

describe("cells.source", function()
  it("excludes the `# %%` marker line itself", function()
    local bufnr = make_buffer({ "# %%", "1 + 1", "2 + 2" })
    local parsed = cells.parse(bufnr)

    assert.are.equal("1 + 1\n2 + 2", cells.source(bufnr, parsed[1]))
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
end)
