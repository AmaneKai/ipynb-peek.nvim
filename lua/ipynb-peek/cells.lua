local M = {}

--- The same buffer version is commonly inspected several times in one UI
--- event: parse the cell boundaries, then extract every cell's source, then
--- apply a status snapshot. Keep one immutable snapshot for the most recently
--- inspected buffer so those operations share a single nvim_buf_get_lines()
--- call. changedtick invalidates it automatically on the next real edit;
--- extmark/status updates do not change changedtick, so they can safely reuse
--- the parsed boundaries too.
local cached_bufnr = nil
local cached_changedtick = nil
local cached_cells = nil
local cached_lines = nil

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

--- Extracts a jupytext percent-format marker line's `editable=false` (or
--- `deletable=false`) attribute, if present - jupytext round-trips both
--- straight from nbformat's cell.metadata onto the marker line, the same
--- convention as tags=[...] above (verified directly against jupytext's
--- own ipynb->py:percent conversion). Absent entirely means true, matching
--- nbformat's own "unset means editable/deletable" convention.
local function parse_bool_attr(line, name)
  return line:match(name .. "%s*=%s*false") == nil
end

local function parse_lines(lines)
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
      current = {
        start_line = line_number,
        cell_type = cell_type,
        tags = parse_tags(line),
        editable = parse_bool_attr(line, "editable"),
        deletable = parse_bool_attr(line, "deletable"),
      }
    end
  end

  if current then
    current.end_line = #lines
    table.insert(parsed, current)
  end

  return parsed
end

--- Returns both the parsed cells and the exact buffer lines they were parsed
--- from. Callers rebuilding source for several cells should use this once and
--- pass `lines` to source_from_lines/display_source_from_lines instead of
--- crossing the Neovim API once per cell.
function M.snapshot(bufnr)
  local changedtick = vim.api.nvim_buf_get_changedtick(bufnr)
  if bufnr == cached_bufnr and changedtick == cached_changedtick then
    return cached_cells, cached_lines
  end

  local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
  local parsed = parse_lines(lines)
  cached_bufnr = bufnr
  cached_changedtick = changedtick
  cached_cells = parsed
  cached_lines = lines
  return parsed, lines
end

--- Releases the retained source snapshot once its notebook closes. Passing no
--- buffer clears it unconditionally; passing a different buffer is a no-op.
function M.invalidate(bufnr)
  if bufnr ~= nil and bufnr ~= cached_bufnr then
    return
  end
  cached_bufnr = nil
  cached_changedtick = nil
  cached_cells = nil
  cached_lines = nil
end

--- Parses a jupytext "light" format buffer (`# %%`-delimited) into cells.
--- Returns an array of { start_line, end_line, cell_type, tags, editable,
--- deletable }, both 1-indexed and inclusive, where start_line is the
--- marker line itself.
function M.parse(bufnr)
  local parsed = M.snapshot(bufnr)
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

local function cell_body(lines, cell)
  local body = {}
  for line_number = cell.start_line + 1, cell.end_line do
    table.insert(body, lines[line_number])
  end
  return body
end

--- Extracts a cell's body source from an existing snapshot, excluding the
--- `# %%` marker line itself.
function M.source_from_lines(lines, cell)
  local body = cell_body(lines, cell)
  if cell.cell_type == "code" then
    for line_number, line in ipairs(body) do
      body[line_number] = uncomment_magic_line(line)
    end
  end
  return table.concat(body, "\n")
end

--- Extracts a cell's body source, excluding the `# %%` marker line itself.
function M.source(bufnr, cell)
  local _, lines = M.snapshot(bufnr)
  return M.source_from_lines(lines, cell)
end

--- Same as source(), but for markdown and raw cells also strips jupytext's
--- `# ` line-comment prefix (jupytext comments out non-code cell text so the
--- file stays valid Python; it strips this back out when converting to
--- .ipynb JSON on save - live-sync reads the raw buffer before that
--- conversion ever happens, so we have to undo it ourselves here).
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
