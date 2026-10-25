--- Vim-native cell text-objects and motions over the `# %%` buffer view:
---   ic / ac   inside (body) / around (marker + body) the current cell
---   ]c / [c   next / previous cell marker
---   ]e / [e   next / previous cell whose last run errored
local cells = require("ipynb-peek.cells")
local runtime = require("ipynb-peek.runtime")

local M = {}

M.defaults = {
  inner = "ic",
  around = "ac",
  next_cell = "]c",
  prev_cell = "[c",
  next_error = "]e",
  prev_error = "[e",
}

--- Line range (1-based, inclusive) a text-object covers, or nil if empty.
function M.range(cell, kind)
  if kind == "around" then
    return cell.start_line, cell.end_line
  end
  if cell.end_line <= cell.start_line then
    return nil -- a bare marker line has no body
  end
  return cell.start_line + 1, cell.end_line
end

--- Marker line (1-based) to land on for a `]c`-style motion from `line`, or
--- nil when there is nowhere to go in that direction.
function M.boundary_target(parsed, line, direction)
  if direction == "next" then
    for _, cell in ipairs(parsed) do
      if cell.start_line > line then
        return cell.start_line
      end
    end
    return nil
  end
  -- previous: this cell's own marker first (if we're below it), else the one before
  local target
  for _, cell in ipairs(parsed) do
    if cell.start_line < line then
      target = cell.start_line
    end
  end
  return target
end

--- 1-based marker line of the next/previous cell (relative to the cell
--- containing `line`) whose last run errored, or nil.
function M.error_target(parsed, line, direction, has_error)
  local current = cells.cell_index_at(parsed, line) -- 0-based, or nil outside any cell
  if direction == "next" then
    for index = (current or -1) + 1, #parsed - 1 do
      if has_error(index) then
        return parsed[index + 1].start_line
      end
    end
  else
    for index = (current or #parsed) - 1, 0, -1 do
      if has_error(index) then
        return parsed[index + 1].start_line
      end
    end
  end
  return nil
end

local function leave_visual_if_needed()
  local mode = vim.fn.mode()
  if mode == "v" or mode == "V" or mode == "\22" then
    vim.cmd("normal! \27")
  end
end

function M.select(kind)
  local bufnr = vim.api.nvim_get_current_buf()
  local line = vim.api.nvim_win_get_cursor(0)[1]
  local parsed = cells.parse(bufnr)
  local _, cell = cells.cell_index_at(parsed, line)
  if not cell then
    return
  end
  local first, last = M.range(cell, kind)
  if not first then
    return
  end
  leave_visual_if_needed()
  vim.cmd(string.format("normal! %dGV%dG", first, last))
end

function M.jump(direction)
  local bufnr = vim.api.nvim_get_current_buf()
  local target
  for _ = 1, vim.v.count1 do
    local line = vim.api.nvim_win_get_cursor(0)[1]
    local next_line = M.boundary_target(cells.parse(bufnr), line, direction)
    if not next_line then
      break
    end
    target = next_line
    vim.api.nvim_win_set_cursor(0, { target, 0 })
  end
end

function M.jump_error(direction)
  local bufnr = vim.api.nvim_get_current_buf()
  local line = vim.api.nvim_win_get_cursor(0)[1]
  local target = M.error_target(cells.parse(bufnr), line, direction, runtime.has_error)
  if target then
    vim.api.nvim_win_set_cursor(0, { target, 0 })
  else
    vim.notify("[ipynb-peek] no " .. direction .. " cell with an error", vim.log.levels.INFO)
  end
end

--- Buffer-local mappings. `keys` entries set to false/nil are skipped.
--- ]c / [c fall back to Vim's own diff-mode motions in diff windows.
function M.apply(bufnr, keys)
  keys = vim.tbl_extend("force", M.defaults, keys or {})
  local function map(modes, lhs, fn, desc)
    if lhs then
      vim.keymap.set(modes, lhs, fn, { buffer = bufnr, desc = "ipynb-peek: " .. desc })
    end
  end
  map({ "x", "o" }, keys.inner, function()
    M.select("inner")
  end, "inside cell")
  map({ "x", "o" }, keys.around, function()
    M.select("around")
  end, "around cell")
  for direction, lhs in pairs({ next = keys.next_cell, prev = keys.prev_cell }) do
    map({ "n", "x" }, lhs, function()
      if vim.wo.diff then
        vim.cmd("normal! " .. vim.v.count1 .. lhs)
        return
      end
      M.jump(direction)
    end, direction .. " cell")
  end
  map({ "n", "x" }, keys.next_error, function()
    M.jump_error("next")
  end, "next cell with error")
  map({ "n", "x" }, keys.prev_error, function()
    M.jump_error("prev")
  end, "previous cell with error")
end

return M
