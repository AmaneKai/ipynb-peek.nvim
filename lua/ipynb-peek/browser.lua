--- Minimal browser launcher: no OS window-closing hacks, no Chromium/Firefox drivers.
local M = {}

--- Pure helper: returns the command list when `preference` is a custom command
--- table (e.g. `{ "surf" }` or `{ "falkon" }`), or nil otherwise.
function M.command(url, preference)
  if type(preference) == "table" and #preference > 0 then
    return vim.list_extend(vim.deepcopy(preference), { url })
  end
  return nil
end

--- Opens `url` according to `preference`:
---   - `false`: headless / SSH mode (notify URL only, do not launch a browser)
---   - `table` (e.g. `{ "surf" }`): spawn detached process with `url` appended
---   - `"default"` or `nil`: `vim.ui.open(url)`
function M.open(url, preference)
  if preference == false then
    vim.notify("[ipynb-peek] preview available at " .. url, vim.log.levels.INFO)
    return
  end
  local cmd = M.command(url, preference)
  if cmd then
    vim.fn.jobstart(cmd, { detach = true })
    return
  end
  vim.ui.open(url)
end

return M
