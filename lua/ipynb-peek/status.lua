--- Pure formatting for in-buffer cell status sign/virtual text (execution + DAG staleness).
local M = {}

local function has_execution_count(status_info)
  return status_info ~= nil
    and status_info.execution_count ~= nil
    and status_info.execution_count ~= vim.NIL
end

local function format_stale_reasons(stale_info)
  local reasons = stale_info and stale_info.reasons or {}
  local parts = {}
  for _, r in ipairs(reasons) do
    if r.kind == "edited" then
      table.insert(parts, "edited")
    else
      local from_num = (r.from or 0) + 1
      local syms = type(r.symbols) == "table" and table.concat(r.symbols, ", ") or ""
      if syms ~= "" then
        table.insert(parts, string.format("← #%d: %s", from_num, syms))
      else
        table.insert(parts, string.format("← #%d", from_num))
      end
    end
  end
  if #parts == 0 then
    return "⚠ stale"
  end
  return "⚠ stale (" .. table.concat(parts, "; ") .. ")"
end

--- Returns { sign_text, hl_group } for a cell's status & staleness, or nil.
function M.icon_for(status_info, stale_info)
  status_info = status_info or {}
  if status_info.status == "busy" then
    return { sign_text = "●", hl_group = "DiagnosticWarn" }
  end
  if status_info.has_error then
    return { sign_text = "✗", hl_group = "DiagnosticError" }
  end
  if stale_info then
    return { sign_text = "~", hl_group = "DiagnosticWarn" }
  end
  if has_execution_count(status_info) then
    return { sign_text = "✓", hl_group = "DiagnosticOk" }
  end
  return nil
end

--- Returns virtual text shown at the end of a cell's marker line, e.g.:
---   "  [2] 0.4s  ⚠ stale (← #1: lr)"
function M.virt_text_for(status_info, stale_info)
  status_info = status_info or {}
  if status_info.status == "busy" then
    return ""
  end
  local text = ""
  if has_execution_count(status_info) then
    text = "  [" .. status_info.execution_count .. "]"
    if status_info.duration_ms ~= nil and status_info.duration_ms ~= vim.NIL then
      text = text .. " " .. string.format("%.1fs", status_info.duration_ms / 1000)
    end
  end
  if stale_info and not status_info.has_error then
    text = text .. "  " .. format_stale_reasons(stale_info)
  end
  return text
end

return M
