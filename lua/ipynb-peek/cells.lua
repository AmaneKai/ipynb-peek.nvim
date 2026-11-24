local M = {}

local cached_bufnr = nil
local cached_changedtick = nil
local cached_cells = nil
local cached_lines = nil

--- Scans one quoted token starting at `start_idx` in `list`.
--- Returns (token_or_nil, next_index).
local function scan_quoted_token(list, start_idx)
  local quote = list:sub(start_idx, start_idx)
  local j, len = start_idx + 1, #list
  local buf = {}
  while j <= len do
    local ch = list:sub(j, j)
    if ch == "\\" and j < len then
      table.insert(buf, list:sub(j + 1, j + 1))
      j = j + 2
    elseif ch == quote then
      return table.concat(buf), j + 1
    else
      table.insert(buf, ch)
      j = j + 1
    end
  end
  return nil, len + 1
end

--- Scans quoted tag strings inside `tags=[...]` in a single pass so mixed
--- quotes and embedded apostrophes/quotes preserve exact order and values.
local function parse_tags(line)
  local tags = {}
  local list = line:match("tags%s*=%s*%[(.-)%]")
  if not list then
    return tags
  end
  local i, len = 1, #list
  while i <= len do
    local ch = list:sub(i, i)
    if ch == '"' or ch == "'" then
      local tok, next_i = scan_quoted_token(list, i)
      if tok ~= nil then
        table.insert(tags, tok)
      end
      i = next_i
    else
      i = i + 1
    end
  end
  return tags
end

--- Extracts a marker-line boolean attribute (`editable=false` / `deletable=false`)
--- with strict word boundaries so `uneditable=false` does not match `editable=false`.
local function parse_bool_attr(line, name)
  return line:match("%f[%w_]" .. name .. "%s*=%s*false%f[^%w_]") == nil
end

--- Matches `# %%` or `#%%` only when followed by end-of-line or whitespace,
--- so IPython cell magics like `# %%timeit` or `# %%bash` do NOT split cells.
local function match_marker(line)
  if line:match("^# ?%%%%$") then
    return ""
  end
  return line:match("^# ?%%%%(%s.*)$")
end

--- Pure line-array parser (no buffer required). Returns an array of
--- { start_line, end_line, cell_type, tags, editable, deletable } (1-based inclusive).
function M.parse_lines(lines)
  local parsed = {}
  local current = nil
  if type(lines) ~= "table" then
    return parsed
  end

  for line_number, line in ipairs(lines) do
    local rest = type(line) == "string" and match_marker(line) or nil
    if rest ~= nil then
      if current then
        current.end_line = line_number - 1
        table.insert(parsed, current)
      end
      local is_md = rest:match("^%s*%[markdown%]") ~= nil
      local is_raw = rest:match("^%s*%[raw%]") ~= nil
      current = {
        start_line = line_number,
        cell_type = is_md and "markdown" or (is_raw and "raw" or "code"),
        tags = parse_tags(rest),
        editable = parse_bool_attr(rest, "editable"),
        deletable = parse_bool_attr(rest, "deletable"),
      }
    end
  end

  if current then
    current.end_line = #lines
    table.insert(parsed, current)
  end

  return parsed
end

function M.snapshot(bufnr)
  local changedtick = vim.api.nvim_buf_get_changedtick(bufnr)
  if bufnr == cached_bufnr and changedtick == cached_changedtick then
    return cached_cells, cached_lines
  end

  local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
  local parsed = M.parse_lines(lines)
  cached_bufnr = bufnr
  cached_changedtick = changedtick
  cached_cells = parsed
  cached_lines = lines
  return parsed, lines
end

function M.invalidate(bufnr)
  if bufnr ~= nil and bufnr ~= cached_bufnr then
    return
  end
  cached_bufnr = nil
  cached_changedtick = nil
  cached_cells = nil
  cached_lines = nil
end

function M.parse(bufnr)
  local parsed = M.snapshot(bufnr)
  return parsed
end

function M.cell_index_at(parsed, line)
  for position, cell in ipairs(parsed) do
    if line >= cell.start_line and line <= cell.end_line then
      return position - 1, cell
    end
  end
  return nil
end

function M.cell_after(parsed, index)
  return parsed[index + 2]
end

function M.cell_before(parsed, index)
  return parsed[index]
end

--- Shared window/buffer-validated cell jump helper used by init.lua and outline.lua.
--- `cell_index` is 0-based; `line_offset` defaults to 1 (first body line).
function M.jump_to_cell_in_window(origin, bufnr, cell_index, line_offset, center)
  if type(bufnr) ~= "number" or not vim.api.nvim_buf_is_valid(bufnr) then
    return false
  end
  if type(cell_index) ~= "number" then
    return false
  end
  local win = origin or vim.fn.bufwinid(bufnr)
  if win == -1 or not vim.api.nvim_win_is_valid(win) then
    return false
  end
  if vim.api.nvim_win_get_buf(win) ~= bufnr then
    return false
  end
  local parsed = M.parse(bufnr)
  local cell = parsed[cell_index + 1]
  if not cell then
    return false
  end
  local offset = type(line_offset) == "number" and line_offset or 1
  local clamped = math.max(cell.start_line + 1, math.min(cell.start_line + offset, cell.end_line))
  local target = math.min(clamped, vim.api.nvim_buf_line_count(bufnr))
  if center then
    vim.api.nvim_set_current_win(win)
  end
  vim.api.nvim_win_set_cursor(win, { target, 0 })
  if center then
    vim.cmd("normal! zz")
  end
  return true
end

--- Extracts body lines after the marker, trimming a single trailing blank
--- inter-cell separator line when another cell follows.
local function cell_body(lines, cell)
  local body = {}
  for line_number = cell.start_line + 1, cell.end_line do
    table.insert(body, lines[line_number])
  end
  if #body > 0 and body[#body] == "" and cell.end_line < #lines then
    table.remove(body)
  end
  return body
end

function M.source_from_lines(lines, cell)
  return table.concat(cell_body(lines, cell), "\n")
end

function M.source(bufnr, cell)
  local _, lines = M.snapshot(bufnr)
  return M.source_from_lines(lines, cell)
end

function M.display_source_from_lines(lines, cell)
  if cell.cell_type ~= "markdown" and cell.cell_type ~= "raw" then
    return M.source_from_lines(lines, cell)
  end
  local body = cell_body(lines, cell)
  for line_number, line in ipairs(body) do
    body[line_number] = (line:gsub("^# ?", "", 1))
  end
  return table.concat(body, "\n")
end

function M.display_source(bufnr, cell)
  local _, lines = M.snapshot(bufnr)
  return M.display_source_from_lines(lines, cell)
end

return M
