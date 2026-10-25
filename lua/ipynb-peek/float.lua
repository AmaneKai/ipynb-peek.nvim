--- A centered, read-only floating window over a scratch buffer.
local M = {}

--- opts: title, lines (string[]), max_width, max_height,
---       on_select(line_number) called on <CR> with the window closed first,
---       cursor_line (initial 1-based line)
--- Returns the window id.
function M.open(opts)
  local lines = opts.lines
  local width = 20
  for _, line in ipairs(lines) do
    width = math.max(width, vim.fn.strdisplaywidth(line))
  end
  width = math.min(width + 2, opts.max_width or math.floor(vim.o.columns * 0.8))
  local height = math.max(1, math.min(#lines, opts.max_height or math.floor(vim.o.lines * 0.7)))

  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modifiable = false
  vim.bo[buf].bufhidden = "wipe"

  local win = vim.api.nvim_open_win(buf, true, {
    relative = "editor",
    width = width,
    height = height,
    row = math.floor((vim.o.lines - height) / 2) - 1,
    col = math.floor((vim.o.columns - width) / 2),
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
