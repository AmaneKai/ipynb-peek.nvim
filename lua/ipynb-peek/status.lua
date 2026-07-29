--- Pure formatting for the in-buffer cell status sign/virtual text pushed
--- over /events (see index.ts's cellStatusInfo / broadcastCell /
--- broadcastFull). Kept separate from cells.lua, which stays scoped to
--- buffer parsing - this module never touches a buffer or window.
local M = {}

--- vim.json.decode turns JSON `null` into the sentinel vim.NIL, not Lua
--- `nil` - execution_count is `number | null` on the wire (explicit null
--- for a cell that's never been run), so both must be checked here. Do not
--- simplify this to `~= nil` only - that would treat a never-run cell as
--- having a real execution count.
local function has_execution_count(status_info)
  return status_info.execution_count ~= nil and status_info.execution_count ~= vim.NIL
end

--- Returns { sign_text, hl_group } for a cell's execution status, or nil if
--- nothing should be shown (never run, not busy, no error).
function M.icon_for(status_info)
  if status_info.status == "busy" then
    return { sign_text = "●", hl_group = "DiagnosticWarn" }
  end
  if status_info.has_error then
    return { sign_text = "✗", hl_group = "DiagnosticError" }
  end
  if has_execution_count(status_info) then
    return { sign_text = "✓", hl_group = "DiagnosticOk" }
  end
  return nil
end

--- Returns the "  [n] Xs" virtual text shown at the end of a cell's marker
--- line, or "" for no virtual text. Deliberately blank while busy (rather
--- than showing a stale execution_count from the previous run) - only
--- rendered once the result of *this* run is known. duration_ms is
--- `number | undefined` on the wire (never explicit null), so unlike
--- execution_count a plain `~= nil` check is correct for it.
function M.virt_text_for(status_info)
  if status_info.status == "busy" then
    return ""
  end
  if not has_execution_count(status_info) then
    return ""
  end
  local text = "  [" .. status_info.execution_count .. "]"
  if status_info.duration_ms ~= nil then
    text = text .. " " .. string.format("%.1fs", status_info.duration_ms / 1000)
  end
  return text
end

return M
