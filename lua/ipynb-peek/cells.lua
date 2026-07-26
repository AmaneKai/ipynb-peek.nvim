local M = {}

--- Parses a jupytext "light" format buffer (`# %%`-delimited) into cells.
--- Returns an array of { start_line, end_line, cell_type }, both 1-indexed
--- and inclusive, where start_line is the marker line itself.
function M.parse(bufnr)
  local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
  local parsed = {}
  local current = nil

  for line_number, line in ipairs(lines) do
    local is_markdown = line:match("^# %%%%%s*%[markdown%]") ~= nil
    local is_marker = is_markdown or line:match("^# %%%%") ~= nil

    if is_marker then
      if current then
        current.end_line = line_number - 1
        table.insert(parsed, current)
      end
      current = { start_line = line_number, cell_type = is_markdown and "markdown" or "code" }
    end
  end

  if current then
    current.end_line = #lines
    table.insert(parsed, current)
  end

  return parsed
end

--- Returns the 0-based index (matching ipynb cell order) of the cell
--- containing `line` (1-indexed) plus the cell itself, or nil if the
--- cursor sits before the first `# %%` marker.
function M.cell_index_at(parsed, line)
  for position, cell in ipairs(parsed) do
    if line >= cell.start_line and line <= cell.end_line then
      return position - 1, cell
    end
  end
  return nil
end

--- Extracts a cell's body source, excluding the `# %%` marker line itself.
function M.source(bufnr, cell)
  local lines = vim.api.nvim_buf_get_lines(bufnr, cell.start_line, cell.end_line, false)
  return table.concat(lines, "\n")
end

--- Same as source(), but for markdown cells also strips jupytext's `# `
--- line-comment prefix (jupytext comments out markdown text so the file
--- stays valid Python; it strips this back out when converting to .ipynb
--- JSON on save - live-sync reads the raw buffer before that conversion
--- ever happens, so we have to undo it ourselves here).
function M.display_source(bufnr, cell)
  if cell.cell_type ~= "markdown" then
    return M.source(bufnr, cell)
  end
  local lines = vim.api.nvim_buf_get_lines(bufnr, cell.start_line, cell.end_line, false)
  for line_number, line in ipairs(lines) do
    lines[line_number] = (line:gsub("^# ?", "", 1))
  end
  return table.concat(lines, "\n")
end

return M
