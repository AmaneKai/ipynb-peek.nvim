--- Notebook outline: markdown headings plus one row per code cell, shown in a
--- floating window. Selecting a row jumps to that cell in the buffer.
local cells = require("ipynb-peek.cells")
local float = require("ipynb-peek.float")
local runtime = require("ipynb-peek.runtime")

local M = {}

local ICONS = { busy = "●", error = "✗", ok = "✓", idle = "○" }

--- Headings (level, title) of one markdown cell's text, skipping code fences.
function M.headings(text)
  local found = {}
  local fenced = false
  for line in (text .. "\n"):gmatch("(.-)\n") do
    if line:match("^%s*```") or line:match("^%s*~~~") then
      fenced = not fenced
    elseif not fenced then
      local hashes, title = line:match("^(#+)%s+(.-)%s*#*%s*$")
      if hashes and #hashes <= 6 and title ~= "" then
        table.insert(found, { level = #hashes, title = title })
      end
    end
  end
  return found
end

local function first_line(source)
  for line in (source .. "\n"):gmatch("(.-)\n") do
    local trimmed = vim.trim(line)
    if trimmed ~= "" then
      return #trimmed > 60 and (trimmed:sub(1, 59) .. "…") or trimmed
    end
  end
  return "(empty)"
end

local function code_status(info)
  if not info then
    return "idle"
  end
  if info.status == "busy" then
    return "busy"
  end
  if info.has_error then
    return "error"
  end
  if info.execution_count ~= nil and info.execution_count ~= vim.NIL then
    return "ok"
  end
  return "idle"
end

--- Rows for the outline. `lines` is the buffer snapshot; `statuses` maps a
--- 0-based cell index to the server's status info (may be empty).
--- Each row: { line = marker line (1-based), text = display string, index = 0-based cell }.
function M.entries(parsed, lines, statuses)
  local rows = {}
  local depth = 0
  for i, cell in ipairs(parsed) do
    if cell.cell_type == "markdown" then
      local text = cells.display_source_from_lines(lines, cell)
      for _, heading in ipairs(M.headings(text)) do
        depth = heading.level
        table.insert(rows, {
          line = cell.start_line,
          index = i - 1,
          text = string.rep("  ", heading.level - 1) .. heading.title,
        })
      end
    elseif cell.cell_type == "code" then
      local info = statuses[i - 1]
      local count = info and info.execution_count
      local label = (count ~= nil and count ~= vim.NIL) and tostring(count) or " "
      table.insert(rows, {
        line = cell.start_line,
        index = i - 1,
        text = string.format(
          "%s%s [%s] %s",
          string.rep("  ", math.min(depth, 6)),
          ICONS[code_status(info)],
          label,
          first_line(cells.source_from_lines(lines, cell))
        ),
      })
    end
  end
  return rows
end

function M.open(bufnr)
  bufnr = bufnr or vim.api.nvim_get_current_buf()
  local parsed, lines = cells.snapshot(bufnr)
  local rows = M.entries(parsed, lines, runtime.cells)
  if #rows == 0 then
    vim.notify("[ipynb-peek] no cells to show", vim.log.levels.INFO)
    return
  end

  local current = 1
  local cursor_line = vim.api.nvim_win_get_cursor(0)[1]
  local here = cells.cell_index_at(parsed, cursor_line)
  for i, row in ipairs(rows) do
    if here ~= nil and row.index <= here then
      current = i
    end
  end

  local texts = {}
  for i, row in ipairs(rows) do
    texts[i] = row.text
  end
  local origin = vim.api.nvim_get_current_win()
  float.open({
    title = "Notebook outline",
    lines = texts,
    cursor_line = current,
    on_select = function(selected)
      local row = rows[selected]
      if not row then
        return
      end
      if vim.api.nvim_win_is_valid(origin) then
        vim.api.nvim_set_current_win(origin)
      end
      -- First body line (the marker itself when the cell is empty).
      local target = math.min(row.line + 1, vim.api.nvim_buf_line_count(bufnr))
      vim.api.nvim_win_set_cursor(0, { target, 0 })
      vim.cmd("normal! zz")
    end,
  })
end

return M
