local cells = require("ipynb-peek.cells")
local outline = require("ipynb-peek.outline")
local variables = require("ipynb-peek.variables")
local statusline = require("ipynb-peek.statusline")

local function snapshot(lines)
  local bufnr = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, lines)
  vim.api.nvim_set_current_buf(bufnr)
  return cells.snapshot(bufnr)
end

describe("outline.headings", function()
  it("finds ATX headings and skips fenced code", function()
    local found = outline.headings("# One\ntext\n```\n# not a heading\n```\n## Two ##")
    assert.are.same({ { level = 1, title = "One" }, { level = 2, title = "Two" } }, found)
  end)

  it("ignores hashtags and over-deep markers", function()
    assert.are.same({}, outline.headings("#tag\n####### seven"))
  end)
end)

describe("outline.entries", function()
  local lines = {
    "# %% [markdown]",
    "# # Load data",
    "# %%",
    "df = read()",
    "# %%",
    "df.head()",
    "# %% [markdown]",
    "# some prose",
  }

  it("lists headings and code cells with status icons", function()
    local parsed, buffer_lines = snapshot(lines)
    local rows = outline.entries(parsed, buffer_lines, {
      [1] = { execution_count = 1, has_error = false },
      [2] = { execution_count = 2, has_error = true },
    })
    assert.are.same({
      { line = 1, index = 0, text = "Load data" },
      { line = 3, index = 1, text = "  ✓ [1] df = read()" },
      { line = 5, index = 2, text = "  ✗ [2] df.head()" },
    }, rows)
  end)

  it("marks unrun and busy cells", function()
    local parsed, buffer_lines = snapshot(lines)
    local rows = outline.entries(parsed, buffer_lines, { [2] = { status = "busy" } })
    assert.is_truthy(rows[2].text:find("○ %[ %]", 1))
    assert.is_truthy(rows[3].text:find("●", 1, true))
  end)
end)

describe("variables.format_bytes / format_rows", function()
  it("formats sizes", function()
    assert.are.equal("12 B", variables.format_bytes(12))
    assert.are.equal("2.0 KB", variables.format_bytes(2048))
    assert.are.equal("5.0 MB", variables.format_bytes(5 * 1024 * 1024))
    assert.are.equal("", variables.format_bytes(nil))
  end)

  it("aligns a header, a rule and the rows, with a total", function()
    local lines = variables.format_rows({
      { name = "df", type = "DataFrame", shape = "(10, 3)", size_bytes = 2048, preview = "['a']" },
      { name = "n", type = "int", shape = "", size_bytes = 28, preview = "5" },
    })
    assert.is_truthy(lines[1]:find("^Name%s+Type%s+Shape / size%s+Memory%s+Preview"))
    assert.is_truthy(lines[3]:find("^df%s+DataFrame%s+%(10, 3%)%s+2.0 KB%s+%['a'%]"))
    assert.is_truthy(lines[#lines]:find("2 variables, ~2.0 KB", 1, true))
  end)
end)

describe("statusline.format", function()
  it("is empty without a session", function()
    assert.are.equal("", statusline.format({ active = false }))
  end)

  it("shows busy time, idle, and not-started states", function()
    assert.are.equal(
      "● python3 (busy: 2.1s)",
      statusline.format({ active = true, name = "python3", running = true, busy_ms = 2100 })
    )
    assert.are.equal(
      "○ python3 (idle)",
      statusline.format({ active = true, name = "python3", running = true })
    )
    assert.are.equal(
      "◌ python3 (not started)",
      statusline.format({ active = true, name = "python3", running = false })
    )
  end)
end)
