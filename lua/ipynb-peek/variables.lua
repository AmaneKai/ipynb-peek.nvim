--- Formatting for the kernel variable inspector (the data comes from the
--- server; see server/src/kernel/inspect-code.ts).
local float = require("ipynb-peek.float")

local M = {}

function M.format_bytes(bytes)
  if bytes == nil or bytes == vim.NIL then
    return ""
  end
  if bytes < 1024 then
    return bytes .. " B"
  end
  local units = { "KB", "MB", "GB", "TB" }
  local value, unit = bytes, 0
  repeat
    value = value / 1024
    unit = unit + 1
  until value < 1024 or unit == #units
  return string.format(value >= 100 and "%.0f %s" or "%.1f %s", value, units[unit])
end

local function pad(text, width)
  local gap = width - vim.fn.strdisplaywidth(text)
  return text .. string.rep(" ", math.max(0, gap))
end

--- Aligned table lines for `rows` (server shape: name/type/shape/size_bytes/preview).
function M.format_rows(rows)
  local header = { "Name", "Type", "Shape / size", "Memory", "Preview" }
  local body, total = {}, 0
  for _, row in ipairs(rows) do
    if type(row.size_bytes) == "number" then
      total = total + row.size_bytes
    end
    table.insert(body, {
      row.name,
      row.type,
      row.shape or "",
      M.format_bytes(row.size_bytes),
      row.preview or "",
    })
  end

  local widths = {}
  for column, title in ipairs(header) do
    widths[column] = vim.fn.strdisplaywidth(title)
    for _, cells_ in ipairs(body) do
      widths[column] = math.max(widths[column], vim.fn.strdisplaywidth(cells_[column]))
    end
  end
  widths[5] = math.min(widths[5], 60)

  local function line(cells_)
    local parts = {}
    for column = 1, 5 do
      parts[column] = pad(cells_[column], widths[column])
    end
    return (table.concat(parts, "  "):gsub("%s+$", ""))
  end

  local lines = { line(header) }
  table.insert(lines, string.rep("─", vim.fn.strdisplaywidth(lines[1])))
  for _, cells_ in ipairs(body) do
    table.insert(lines, line(cells_))
  end
  table.insert(lines, "")
  table.insert(
    lines,
    string.format(
      "%d variables, ~%s (shallow sizes for plain Python objects)",
      #rows,
      M.format_bytes(total)
    )
  )
  return lines
end

function M.show(rows)
  if #rows == 0 then
    vim.notify("[ipynb-peek] the kernel has no user variables yet", vim.log.levels.INFO)
    return
  end
  float.open({ title = "Kernel variables", lines = M.format_rows(rows), max_width = 140 })
end

return M
