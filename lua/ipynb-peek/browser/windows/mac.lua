--- Closes the popup via AppleScript. Only scriptable browsers (the Chromium
--- family) expose `windows`; Firefox has no AppleScript dictionary.
local M = {}

--- -1743 is macOS's AppleEvents/Automation error code for "the calling app
--- isn't authorized to control the target app" - the one failure mode here
--- the user can actually fix (grant Automation access under System Settings
--- > Privacy & Security > Automation), as opposed to "nothing to close" or
--- some other scripting error. Deliberately doesn't try to name *which*
--- terminal/app needs that permission - this plugin has no reliable way to
--- know that, and doesn't need to: macOS's own Automation settings page
--- already lists it grouped by whichever app is asking.
local function is_automation_denied(output)
  return output ~= nil and output:find("-1743") ~= nil
end

--- Fires at most once per Neovim session - permission state essentially
--- never changes mid-session, and this can otherwise repeat on every single
--- :IpynbPeekClose/quit for as long as it stays denied.
local automation_warned = false

local function warn_automation_denied(app_name)
  if automation_warned then
    return
  end
  automation_warned = true
  vim.notify(
    "[ipynb-peek] macOS blocked AppleScript control of "
      .. app_name
      .. ", so the preview popup can't auto-close. Grant it: System Settings > Privacy & "
      .. "Security > Automation > (whatever terminal/app you run Neovim from) > enable "
      .. app_name
      .. ". Run :checkhealth ipynb-peek to check this directly.",
    vim.log.levels.WARN
  )
end

--- Still detached (so this outlives Neovim exiting via VimLeavePre) -
--- on_exit/on_stderr are best-effort here: if Neovim's own event loop has
--- already torn down by the time osascript finishes, the warning never
--- renders, same as any notify()s fired that late already couldn't.
--- `done(closed)` reports whether a window was found and closed.
function M.close(found, tag, done)
  if found.driver ~= "chromium" then
    return done(true) -- nothing scriptable to try; don't retry
  end
  local script = string.format(
    [[set closed to 0
      tell application "%s"
        repeat with w in every window
          try
            if (name of w) contains "%s" then
              close w
              set closed to closed + 1
            end if
          end try
        end repeat
      end tell
      return closed]],
    found.name,
    tag
  )
  local stdout_chunks, stderr_chunks = {}, {}
  vim.fn.jobstart({ "osascript", "-e", script }, {
    detach = true,
    stdout_buffered = true,
    stderr_buffered = true,
    on_stdout = function(_, data)
      vim.list_extend(stdout_chunks, data)
    end,
    on_stderr = function(_, data)
      for _, line in ipairs(data) do
        if line ~= "" then
          table.insert(stderr_chunks, line)
        end
      end
    end,
    on_exit = function(_, code)
      if code ~= 0 then
        if is_automation_denied(table.concat(stderr_chunks, "\n")) then
          vim.schedule(function()
            warn_automation_denied(found.name)
          end)
          return done(true) -- retrying cannot fix a permission problem
        end
        return done(false)
      end
      local closed = tonumber(vim.trim(table.concat(stdout_chunks, "")))
      done(closed ~= nil and closed > 0)
    end,
  })
end

return M
