local cells = require("ipynb-peek.cells")
local outline = require("ipynb-peek.outline")
local variables = require("ipynb-peek.variables")
local statusline = require("ipynb-peek.statusline")
local float = require("ipynb-peek.float")

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
    "# %%",
    "x = " .. string.rep("α", 70),
  }

  it("lists headings, code cells, stale indicators, and UTF-8 safe truncation", function()
    local parsed, buffer_lines = snapshot(lines)
    local rows = outline.entries(
      parsed,
      buffer_lines,
      {
        [1] = { execution_count = 1, has_error = false },
        [2] = { execution_count = 2, has_error = true },
        [3] = { execution_count = 3, has_error = false },
      },
      {
        [1] = { edited = true, reasons = {} },
      }
    )
    assert.are.equal("Load data", rows[1].text)
    assert.is_truthy(rows[2].text:find("~ [1] df = read()  ⚠ stale", 1, true))
    assert.is_truthy(rows[3].text:find("✗ [2] df.head()", 1, true))
    assert.is_truthy(rows[4].text:find("…$", 1))
    assert.are.equal(60, vim.fn.strchars(rows[4].text:match("x = .*")))
  end)
end)

describe("variables.format_bytes / format_rows", function()
  it("formats sizes", function()
    assert.are.equal("12 B", variables.format_bytes(12))
    assert.are.equal("2.0 KB", variables.format_bytes(2048))
    assert.are.equal("5.0 MB", variables.format_bytes(5 * 1024 * 1024))
    assert.are.equal("", variables.format_bytes(nil))
  end)

  it("truncates long UTF-8 previews to 60 display cols and sanitizes newlines", function()
    local long_preview = "line1\nline2 " .. string.rep("λ", 80)
    local lines = variables.format_rows({
      { name = "s", type = "str", shape = "len=92", size_bytes = 128, preview = long_preview },
    })
    assert.is_nil(lines[3]:find("\n", 1, true))
    local preview_col = lines[3]:match("128 B%s+(.+)$")
    assert.is_truthy(preview_col)
    assert.is_true(vim.fn.strdisplaywidth(preview_col) <= 60)
    assert.is_truthy(preview_col:find("…$", 1))
  end)
end)

describe("float.geometry and float.open guards", function()
  it("clamps width, height, row, and col safely on narrow/short terminals", function()
    local g = float.geometry({ string.rep("x", 200), "a", "b", "c", "d", "e" }, {}, 20, 6)
    assert.is_true(g.width <= 18 and g.width >= 1)
    assert.is_true(g.height <= 2 and g.height >= 1)
    assert.is_true(g.row >= 0 and g.col >= 0)
  end)

  it("returns nil cleanly on empty or nil opts.lines", function()
    assert.is_nil(float.open(nil))
    assert.is_nil(float.open({ lines = {} }))
  end)
end)

describe("statusline.format", function()
  it("is empty without a session", function()
    assert.are.equal("", statusline.format({ active = false }))
  end)

  it("shows busy time, idle, stale count, and not-started states", function()
    assert.are.equal(
      "● python3 (busy: 2.1s)",
      statusline.format({
        active = true,
        name = "python3",
        running = true,
        busy_ms = 2100,
        stale_count = 2,
      })
    )
    assert.are.equal(
      "○ python3 (idle)",
      statusline.format({ active = true, name = "python3", running = true, stale_count = 0 })
    )
    assert.are.equal(
      "○ python3 (idle, 2 stale)",
      statusline.format({ active = true, name = "python3", running = true, stale_count = 2 })
    )
    assert.are.equal(
      "◌ python3 (not started)",
      statusline.format({ active = true, name = "python3", running = false })
    )
  end)
end)
