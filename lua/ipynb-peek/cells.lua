local M = {}

--- Extracts a jupytext percent-format marker line's `tags=[...]` metadata
--- (e.g. `# %% tags=["skip-run-all"]`), if present. Only `tags` is parsed -
--- jupytext's marker-line metadata syntax supports arbitrary key/value
--- pairs, but tags is the only one anything in this plugin currently acts
--- on (see M.run_all's skip-run-all check).
local function parse_tags(line)
  local tags = {}
  local list = line:match("tags%s*=%s*%[(.-)%]")
  if not list then
    return tags
  end
  for tag in list:gmatch('"([^"]*)"') do
    table.insert(tags, tag)
  end
  for tag in list:gmatch("'([^']*)'") do
    table.insert(tags, tag)
  end
  return tags
end

--- Parses a jupytext "light" format buffer (`# %%`-delimited) into cells.
--- Returns an array of { start_line, end_line, cell_type, tags }, both
--- 1-indexed and inclusive, where start_line is the marker line itself.
function M.parse(bufnr)
  local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
  local parsed = {}
  local current = nil

  for line_number, line in ipairs(lines) do
    local is_markdown = line:match("^# %%%%%s*%[markdown%]") ~= nil
    local is_raw = line:match("^# %%%%%s*%[raw%]") ~= nil
    local is_marker = is_markdown or is_raw or line:match("^# %%%%") ~= nil

    if is_marker then
      if current then
        current.end_line = line_number - 1
        table.insert(parsed, current)
      end
      local cell_type = is_markdown and "markdown" or (is_raw and "raw" or "code")
      current = { start_line = line_number, cell_type = cell_type, tags = parse_tags(line) }
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

--- Returns the cell right after the 0-based `index` (matching cell_index_at's
--- convention), or nil if `index` refers to the last cell. Used to find
--- where to land the cursor after "run cell and advance".
function M.cell_after(parsed, index)
  return parsed[index + 2]
end

--- Symmetric counterpart to cell_after - the cell right before the 0-based
--- `index`, or nil if `index` refers to the first cell.
function M.cell_before(parsed, index)
  return parsed[index]
end

--- Jupytext comments out IPython line magics (`%foo`) and shell/help
--- escapes (`!foo`, `?foo`) with a leading `# ` when it converts a notebook
--- into this `# %%` script view, so the resulting file stays parseable as
--- plain Python (see jupytext's magics.py `_MAGIC_RE`/
--- `_PYTHON_HELP_OR_BASH_CMD`) - it un-escapes them again on its own when
--- writing the buffer back to .ipynb JSON on save. Live execution/sync
--- reads this buffer directly, before any save happens, so without undoing
--- that same escaping here a `%time` or `!command` line would run as a
--- no-op comment instead of what it says. Deliberately does not match `%%`
--- (double-percent): jupytext represents an IPython *cell* magic like
--- `%%bash` completely differently - as a `# %% language="bash"` marker
--- with its whole body commented, not an inline-commented `%%bash` line
--- (which would collide with jupytext's own `# %%` cell-boundary syntax) -
--- reconstructing that is a separate, bigger feature. Also doesn't attempt
--- jupytext's no-prefix bash-command heuristic (`cd`, `ls`, ...) or
--- multi-line continuations, both rare enough not to be worth the extra
--- risk of false positives here.
local function uncomment_magic_line(line)
  local indent, rest = line:match("^(%s*)#%s?(.*)$")
  if not indent then
    return line
  end
  if rest:match("^%%%a") or rest:match("^[!?][%a.~$\\/{}]") then
    return indent .. rest
  end
  return line
end

--- Extracts a cell's body source, excluding the `# %%` marker line itself.
function M.source(bufnr, cell)
  local lines = vim.api.nvim_buf_get_lines(bufnr, cell.start_line, cell.end_line, false)
  if cell.cell_type == "code" then
    for line_number, line in ipairs(lines) do
      lines[line_number] = uncomment_magic_line(line)
    end
  end
  return table.concat(lines, "\n")
end

--- Same as source(), but for markdown and raw cells also strips jupytext's
--- `# ` line-comment prefix (jupytext comments out non-code cell text so the
--- file stays valid Python; it strips this back out when converting to
--- .ipynb JSON on save - live-sync reads the raw buffer before that
--- conversion ever happens, so we have to undo it ourselves here).
function M.display_source(bufnr, cell)
  if cell.cell_type ~= "markdown" and cell.cell_type ~= "raw" then
    return M.source(bufnr, cell)
  end
  local lines = vim.api.nvim_buf_get_lines(bufnr, cell.start_line, cell.end_line, false)
  for line_number, line in ipairs(lines) do
    lines[line_number] = (line:gsub("^# ?", "", 1))
  end
  return table.concat(lines, "\n")
end

return M
