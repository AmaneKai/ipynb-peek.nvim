--- Pure Lua `.ipynb` <-> `# %%` buffer reader/writer (BufReadCmd / BufWriteCmd).
local cells = require("ipynb-peek.cells")
local uv = vim.uv or vim.loop

local M = {}

local format_aug = vim.api.nvim_create_augroup("IpynbPeekFormat", { clear = true })
local EMPTY_DICT_MT = getmetatable(vim.empty_dict())
local id_counter = 0

local function is_empty_table(t)
  return type(t) == "table" and next(t) == nil
end

local function is_empty_dict(val)
  return type(val) == "table" and getmetatable(val) == EMPTY_DICT_MT and next(val) == nil
end

local function as_json_object(t)
  if type(t) ~= "table" or is_empty_table(t) then
    return vim.empty_dict()
  end
  return t
end

local function clone_dict(t)
  if type(t) ~= "table" or is_empty_table(t) then
    return vim.empty_dict()
  end
  return vim.deepcopy(t)
end

local function is_valid_cell_id(id)
  return type(id) == "string" and #id >= 1 and #id <= 64 and id:match("^[a-zA-Z0-9%-_]+$") ~= nil
end

local function generate_cell_id(used_ids)
  while true do
    id_counter = id_counter + 1
    local stamp = (uv.hrtime() % 0xffffffff)
    local candidate = string.format("cell-%x-%x", stamp, id_counter)
    if not used_ids[candidate] then
      used_ids[candidate] = true
      return candidate
    end
  end
end

local function normalize_source_str(raw)
  if type(raw) == "table" then
    local parts = {}
    for i, item in ipairs(raw) do
      parts[i] = tostring(item)
    end
    return table.concat(parts, "")
  end
  return type(raw) == "string" and raw or ""
end

local function source_to_nb_lines(str)
  if type(str) ~= "string" or str == "" then
    return {}
  end
  local parts = vim.split(str, "\n", { plain = true })
  local out = {}
  for i = 1, #parts do
    if i < #parts then
      out[i] = parts[i] .. "\n"
    elseif parts[i] ~= "" then
      out[i] = parts[i]
    end
  end
  return out
end

local function normalize_output(output)
  if type(output) ~= "table" then
    return output
  end
  local copy = vim.deepcopy(output)
  if copy.output_type == "execute_result" or copy.output_type == "display_data" then
    copy.data = as_json_object(copy.data)
    copy.metadata = as_json_object(copy.metadata)
  end
  if copy.output_type == "execute_result" and copy.execution_count == nil then
    copy.execution_count = vim.NIL
  end
  return copy
end

local function normalize_outputs(outputs)
  if type(outputs) ~= "table" then
    return {}
  end
  local out = {}
  for i, item in ipairs(outputs) do
    out[i] = normalize_output(item)
  end
  return out
end

--- Decodes `.ipynb` JSON text into a normalized nbformat v4.5 table.
function M.decode_notebook(raw_json)
  if raw_json == nil or vim.trim(tostring(raw_json)) == "" then
    return {
      nbformat = 4,
      nbformat_minor = 5,
      metadata = vim.empty_dict(),
      cells = {},
    }
  end
  local ok, nb = pcall(vim.json.decode, raw_json)
  if not ok or type(nb) ~= "table" then
    error("invalid .ipynb JSON: " .. tostring(nb))
  end
  nb.nbformat = type(nb.nbformat) == "number" and nb.nbformat or 4
  nb.nbformat_minor = type(nb.nbformat_minor) == "number" and nb.nbformat_minor or 5
  nb.metadata = as_json_object(nb.metadata)
  nb.cells = type(nb.cells) == "table" and nb.cells or {}
  return nb
end

local function format_marker(cell)
  local parts = { "# %%" }
  if cell.cell_type == "markdown" then
    table.insert(parts, "[markdown]")
  elseif cell.cell_type == "raw" then
    table.insert(parts, "[raw]")
  end

  local meta = type(cell.metadata) == "table" and cell.metadata or {}
  if type(meta.tags) == "table" and #meta.tags > 0 then
    local quoted = {}
    for _, tag in ipairs(meta.tags) do
      table.insert(quoted, vim.json.encode(tostring(tag)))
    end
    table.insert(parts, "tags=[" .. table.concat(quoted, ", ") .. "]")
  end
  if meta.editable == false then
    table.insert(parts, "editable=false")
  end
  if meta.deletable == false then
    table.insert(parts, "deletable=false")
  end
  return table.concat(parts, " ")
end

local function append_cell_body_lines(lines, cell_type, source)
  if source == "" then
    return
  end
  local body_lines = vim.split(source, "\n", { plain = true })
  local is_commented = cell_type == "markdown" or cell_type == "raw"
  for _, bl in ipairs(body_lines) do
    if is_commented then
      table.insert(lines, bl == "" and "#" or ("# " .. bl))
    else
      table.insert(lines, bl)
    end
  end
end

function M.to_lines(nb)
  local lines = {}
  local preserved_cells = {}
  local nb_cells = type(nb) == "table" and type(nb.cells) == "table" and nb.cells or {}

  for idx, cell in ipairs(nb_cells) do
    if type(cell) == "table" then
      if idx > 1 then
        table.insert(lines, "")
      end
      local cell_type = type(cell.cell_type) == "string" and cell.cell_type or "code"
      local source = normalize_source_str(cell.source)
      table.insert(lines, format_marker(cell))
      append_cell_body_lines(lines, cell_type, source)

      local ec = cell.execution_count == nil and vim.NIL or cell.execution_count
      table.insert(preserved_cells, {
        id = cell.id,
        cell_type = cell_type,
        metadata = clone_dict(cell.metadata),
        outputs = cell_type == "code" and normalize_outputs(cell.outputs) or nil,
        execution_count = cell_type == "code" and ec or nil,
        source = source,
      })
    end
  end

  local state = {
    nbformat = type(nb) == "table" and nb.nbformat or 4,
    nbformat_minor = type(nb) == "table" and nb.nbformat_minor or 5,
    metadata = clone_dict(type(nb) == "table" and nb.metadata or nil),
    cells = preserved_cells,
  }
  return lines, state
end

local function find_exact_unused(prev_cells, used_prev, cell_type, source)
  for j, prev in ipairs(prev_cells) do
    if not used_prev[j] and prev.cell_type == cell_type and prev.source == source then
      return j, prev
    end
  end
  return nil, nil
end

local function reconcile_cells(parsed, sources, prev_cells)
  local matched, used_prev = {}, {}

  for i, cell in ipairs(parsed) do
    local prev = prev_cells[i]
    if prev and prev.cell_type == cell.cell_type and prev.source == sources[i] then
      matched[i] = prev
      used_prev[i] = true
    end
  end

  for i, cell in ipairs(parsed) do
    if not matched[i] then
      local j, prev = find_exact_unused(prev_cells, used_prev, cell.cell_type, sources[i])
      if prev then
        matched[i] = prev
        used_prev[j] = true
      end
    end
  end

  for i, cell in ipairs(parsed) do
    local prev = prev_cells[i]
    if not matched[i] and prev and not used_prev[i] and prev.cell_type == cell.cell_type then
      matched[i] = prev
      used_prev[i] = true
    end
  end

  return matched
end

local function build_nb_cell(cell, source, prev, used_ids)
  local meta = {}
  if prev and type(prev.metadata) == "table" and not is_empty_table(prev.metadata) then
    meta = vim.deepcopy(prev.metadata)
  end
  meta.tags = #cell.tags > 0 and vim.deepcopy(cell.tags) or nil
  if cell.editable == false then
    meta.editable = false
  else
    meta.editable = nil
  end
  if cell.deletable == false then
    meta.deletable = false
  else
    meta.deletable = nil
  end

  local cell_id = prev and prev.id or nil
  if not is_valid_cell_id(cell_id) or used_ids[cell_id] then
    cell_id = generate_cell_id(used_ids)
  else
    used_ids[cell_id] = true
  end

  local entry = {
    id = cell_id,
    cell_type = cell.cell_type,
    metadata = as_json_object(meta),
    source = source_to_nb_lines(source),
  }
  if cell.cell_type == "code" then
    local ec = prev and prev.execution_count or vim.NIL
    entry.execution_count = ec == nil and vim.NIL or ec
    entry.outputs = prev and normalize_outputs(prev.outputs) or {}
  end
  return entry
end

function M.from_lines(lines, prev_state)
  prev_state = type(prev_state) == "table" and prev_state or {}
  local prev_cells = type(prev_state.cells) == "table" and prev_state.cells or {}
  local parsed = cells.parse_lines(lines)

  local sources = {}
  for i, cell in ipairs(parsed) do
    sources[i] = cells.display_source_from_lines(lines, cell)
  end

  local matched = reconcile_cells(parsed, sources, prev_cells)
  local used_ids = {}
  local nb_cells = {}
  for i, cell in ipairs(parsed) do
    nb_cells[i] = build_nb_cell(cell, sources[i], matched[i], used_ids)
  end

  return {
    nbformat = prev_state.nbformat or 4,
    nbformat_minor = prev_state.nbformat_minor or 5,
    metadata = as_json_object(clone_dict(prev_state.metadata)),
    cells = nb_cells,
  }
end

local function is_json_array(t)
  if is_empty_dict(t) then
    return false
  end
  local n = #t
  local count = 0
  for k in pairs(t) do
    if type(k) ~= "number" or k < 1 or k > n or k ~= math.floor(k) then
      return false
    end
    count = count + 1
  end
  return count == n
end

local function pretty_json(val, level)
  if val == nil or val == vim.NIL then
    return "null"
  end
  local vtype = type(val)
  if vtype ~= "table" then
    return vim.json.encode(val)
  end
  if is_empty_dict(val) then
    return "{}"
  end
  local pad = string.rep("  ", level)
  local child_pad = string.rep("  ", level + 1)

  if is_json_array(val) then
    if #val == 0 then
      return "[]"
    end
    local items = {}
    for i = 1, #val do
      items[i] = child_pad .. pretty_json(val[i], level + 1)
    end
    return "[\n" .. table.concat(items, ",\n") .. "\n" .. pad .. "]"
  end

  local keys = {}
  for k in pairs(val) do
    table.insert(keys, tostring(k))
  end
  table.sort(keys)
  local pairs_out = {}
  for i, k in ipairs(keys) do
    pairs_out[i] = child_pad .. vim.json.encode(k) .. ": " .. pretty_json(val[k], level + 1)
  end
  return "{\n" .. table.concat(pairs_out, ",\n") .. "\n" .. pad .. "}"
end

function M.encode_notebook(nb)
  nb = type(nb) == "table" and nb or {}
  local used_ids = {}
  local normalized = {
    nbformat = nb.nbformat or 4,
    nbformat_minor = nb.nbformat_minor or 5,
    metadata = as_json_object(nb.metadata),
    cells = {},
  }
  for i, cell in ipairs(type(nb.cells) == "table" and nb.cells or {}) do
    if type(cell) == "table" then
      local cid = cell.id
      if not is_valid_cell_id(cid) or used_ids[cid] then
        cid = generate_cell_id(used_ids)
      else
        used_ids[cid] = true
      end
      local c = {
        id = cid,
        cell_type = cell.cell_type or "code",
        metadata = as_json_object(cell.metadata),
        source = cell.source or {},
      }
      if c.cell_type == "code" then
        c.execution_count = cell.execution_count ~= nil and cell.execution_count or vim.NIL
        c.outputs = normalize_outputs(cell.outputs)
      end
      normalized.cells[#normalized.cells + 1] = c
    end
  end
  return pretty_json(normalized, 0) .. "\n"
end

function M.update_cell_outputs(bufnr, index, execution_count, outputs)
  if type(bufnr) ~= "number" or not vim.api.nvim_buf_is_valid(bufnr) then
    return
  end
  if type(index) ~= "number" or index < 0 then
    return
  end
  local state = vim.b[bufnr].ipynb_state
  if type(state) ~= "table" then
    state = { nbformat = 4, nbformat_minor = 5, metadata = vim.empty_dict(), cells = {} }
  end
  state.cells = type(state.cells) == "table" and state.cells or {}

  local parsed, lines = cells.snapshot(bufnr)
  local pos = index + 1
  local cell = parsed[pos]
  local prev = state.cells[pos]
  local new_ec = execution_count ~= nil and execution_count or vim.NIL
  local new_outputs = normalize_outputs(outputs)

  local changed = prev == nil
    or prev.execution_count ~= new_ec
    or not vim.deep_equal(prev.outputs or {}, new_outputs)

  local entry = prev
    or { cell_type = cell and cell.cell_type or "code", metadata = vim.empty_dict() }
  entry.cell_type = cell and cell.cell_type or entry.cell_type or "code"
  if cell then
    entry.source = cells.display_source_from_lines(lines, cell)
  end
  entry.execution_count = new_ec
  entry.outputs = new_outputs
  state.cells[pos] = entry
  vim.b[bufnr].ipynb_state = state
  if changed then
    vim.bo[bufnr].modified = true
  end
end

function M.buffer_to_json(bufnr)
  local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
  local nb = M.from_lines(lines, vim.b[bufnr].ipynb_state)
  return M.encode_notebook(nb)
end

local function atomic_write(path, content)
  local tmp = path .. ".ipynb-peek.tmp." .. tostring(uv.hrtime())
  local fd, open_err = uv.fs_open(tmp, "w", tonumber("644", 8))
  if not fd then
    error("failed to open temp file: " .. tostring(open_err))
  end
  local ok_w, write_err = uv.fs_write(fd, content, 0)
  uv.fs_close(fd)
  if not ok_w then
    pcall(uv.fs_unlink, tmp)
    error("failed to write temp file: " .. tostring(write_err))
  end
  local ok_r, rename_err = uv.fs_rename(tmp, path)
  if not ok_r then
    pcall(uv.fs_unlink, tmp)
    error("failed to rename temp file: " .. tostring(rename_err))
  end
end

function M.read_buffer(bufnr, path)
  local raw = ""
  if type(path) == "string" and path ~= "" and vim.fn.filereadable(path) == 1 then
    local ok, file_lines = pcall(vim.fn.readfile, path)
    if ok and file_lines then
      raw = table.concat(file_lines, "\n")
    end
  end

  local ok, nb = pcall(M.decode_notebook, raw)
  if not ok then
    vim.notify("[ipynb-peek] " .. tostring(nb), vim.log.levels.ERROR)
    return
  end

  local lines, state = M.to_lines(nb)
  if #lines == 0 then
    lines = { "# %%", "" }
  end

  local prev_modifiable = vim.bo[bufnr].modifiable
  local prev_undolevels = vim.bo[bufnr].undolevels
  vim.bo[bufnr].modifiable = true
  vim.bo[bufnr].undolevels = -1
  vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, lines)
  vim.bo[bufnr].undolevels = prev_undolevels
  vim.bo[bufnr].modifiable = prev_modifiable

  vim.b[bufnr].ipynb_state = state
  vim.bo[bufnr].filetype = "python"
  vim.bo[bufnr].modified = false
  cells.invalidate(bufnr)
end

function M.write_buffer(bufnr, path)
  if type(path) ~= "string" or path == "" then
    vim.notify("[ipynb-peek] cannot write unnamed .ipynb buffer", vim.log.levels.ERROR)
    return
  end
  local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
  local nb = M.from_lines(lines, vim.b[bufnr].ipynb_state)
  local json_text = M.encode_notebook(nb)

  local ok, err = pcall(atomic_write, path, json_text)
  if not ok then
    vim.notify("[ipynb-peek] failed to save notebook: " .. tostring(err), vim.log.levels.ERROR)
    return
  end

  local _, fresh_state = M.to_lines(nb)
  vim.b[bufnr].ipynb_state = fresh_state
  vim.bo[bufnr].modified = false
  vim.api.nvim_exec_autocmds("BufWritePost", { buffer = bufnr, modeline = false })
end

function M.setup_autocmds()
  vim.api.nvim_clear_autocmds({ group = format_aug })
  vim.api.nvim_create_autocmd("BufReadCmd", {
    group = format_aug,
    pattern = "*.ipynb",
    callback = function(args)
      M.read_buffer(args.buf, args.match)
    end,
  })
  vim.api.nvim_create_autocmd("BufNewFile", {
    group = format_aug,
    pattern = "*.ipynb",
    callback = function(args)
      M.read_buffer(args.buf, "")
    end,
  })
  vim.api.nvim_create_autocmd("BufWriteCmd", {
    group = format_aug,
    pattern = "*.ipynb",
    callback = function(args)
      M.write_buffer(args.buf, args.match)
    end,
  })
end

return M
