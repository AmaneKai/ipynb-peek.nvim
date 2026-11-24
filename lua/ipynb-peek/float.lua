--- A centered, read-only floating window over a scratch buffer.
local M = {}

--- Pure geometry calculation, safely clamped for narrow/short terminals.
function M.geometry(lines, opts, columns, total_lines)
  opts = opts or {}
  columns = columns or vim.o.columns
  total_lines = total_lines or vim.o.lines

  local max_avail_w = math.max(10, columns - 4)
  local max_avail_h = math.max(1, total_lines - 4)

  local desired_w = 20
  for _, line in ipairs(lines) do
    desired_w = math.max(desired_w, vim.fn.strdisplaywidth(line))
  end
  local cap_w = math.min(opts.max_width or math.floor(columns * 0.8), max_avail_w)
  local width = math.max(1, math.min(desired_w + 2, math.max(1, cap_w)))
  -- Never exceed available editor width when terminal is ultra-narrow
  width = math.min(width, math.max(1, columns - 2))

  local cap_h = math.min(opts.max_height or math.floor(total_lines * 0.7), max_avail_h)
  local height = math.max(1, math.min(#lines, math.max(1, cap_h)))

  local row = math.max(0, math.floor((total_lines - height) / 2) - 1)
  local col = math.max(0, math.floor((columns - width) / 2))
  return { width = width, height = height, row = row, col = col }
end

function M.open(opts)
  if type(opts) ~= "table" or type(opts.lines) ~= "table" or #opts.lines == 0 then
    return nil
  end
  local lines = opts.lines
  local geom = M.geometry(lines, opts)

  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modifiable = false
  vim.bo[buf].bufhidden = "wipe"

  local win = vim.api.nvim_open_win(buf, true, {
    relative = "editor",
    width = geom.width,
    height = geom.height,
    row = geom.row,
    col = geom.col,
    style = "minimal",
    border = "rounded",
    title = opts.title and (" " .. opts.title .. " ") or nil,
    title_pos = "center",
  })
  vim.wo[win].cursorline = true

  local function close()
    if vim.api.nvim_win_is_valid(win) then
      vim.api.nvim_win_close(win, true)
    end
  end
  for _, key in ipairs({ "q", "<Esc>" }) do
    vim.keymap.set("n", key, close, { buffer = buf, nowait = true })
  end
  if opts.on_select then
    vim.keymap.set("n", "<CR>", function()
      local line = vim.api.nvim_win_get_cursor(win)[1]
      close()
      opts.on_select(line)
    end, { buffer = buf, nowait = true })
  end
  if opts.cursor_line then
    pcall(vim.api.nvim_win_set_cursor, win, { math.min(opts.cursor_line, #lines), 0 })
  end
  return win
end

return M
