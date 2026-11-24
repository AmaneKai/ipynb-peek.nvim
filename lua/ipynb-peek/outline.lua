--- Notebook outline: markdown headings plus one row per code cell, shown in a
--- floating window. Selecting a row jumps to that cell in the buffer.
local cells = require("ipynb-peek.cells")
local float = require("ipynb-peek.float")
local runtime = require("ipynb-peek.runtime")
local session = require("ipynb-peek.session")

local M = {}

local ICONS = { busy = "●", error = "✗", stale = "~", ok = "✓", idle = "○" }

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

local function truncate_utf8(text, max_chars)
  if vim.fn.strchars(text) <= max_chars then
    return text
  end
  return vim.fn.strcharpart(text, 0, max_chars - 1) .. "…"
end

local function first_line(source)
  for line in (source .. "\n"):gmatch("(.-)\n") do
    local trimmed = vim.trim(line)
    if trimmed ~= "" then
      return truncate_utf8(trimmed, 60)
    end
  end
  return "(empty)"
end

local function code_status(info, stale_info)
  if info and info.status == "busy" then
    return "busy"
  end
  if info and info.has_error then
    return "error"
  end
  if stale_info then
    return "stale"
  end
  if info and info.execution_count ~= nil and info.execution_count ~= vim.NIL then
    return "ok"
  end
  return "idle"
end

--- Rows for the outline. `lines` is the buffer snapshot; `statuses` and
--- `stale_map` map 0-based cell indices to status/staleness (may be empty).
function M.entries(parsed, lines, statuses, stale_map)
  statuses = statuses or {}
  stale_map = stale_map or {}
  local rows = {}
  local depth = 0
  for i, cell in ipairs(parsed) do
    local idx = i - 1
    if cell.cell_type == "markdown" then
      local text = cells.display_source_from_lines(lines, cell)
      for _, heading in ipairs(M.headings(text)) do
        depth = heading.level
        table.insert(rows, {
          line = cell.start_line,
          index = idx,
          text = string.rep("  ", heading.level - 1) .. heading.title,
        })
      end
    elseif cell.cell_type == "code" then
      local info = statuses[idx]
      local stale_info = stale_map[idx]
      local count = info and info.execution_count
      local label = (count ~= nil and count ~= vim.NIL) and tostring(count) or " "
      local is_idle_ok = not (info and info.has_error) and not (info and info.status == "busy")
      local suffix = (stale_info and is_idle_ok) and "  ⚠ stale" or ""
      table.insert(rows, {
        line = cell.start_line,
        index = idx,
        text = string.format(
          "%s%s [%s] %s%s",
          string.rep("  ", math.min(depth, 6)),
          ICONS[code_status(info, stale_info)],
          label,
          first_line(cells.source_from_lines(lines, cell)),
          suffix
        ),
      })
    end
  end
  return rows
end

function M.open(bufnr)
  bufnr = bufnr or vim.api.nvim_get_current_buf()
  local parsed, lines = cells.snapshot(bufnr)
  local same_session = session.is_active() and session.bufnr == bufnr
  local statuses = same_session and runtime.cells or {}
  local stale_map = same_session and runtime.stale or {}
  local rows = M.entries(parsed, lines, statuses, stale_map)
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
      if row then
        cells.jump_to_cell_in_window(origin, bufnr, row.index, 1, true)
      end
    end,
  })
end

return M
