--- Closes the popup on Windows via PostMessage(WM_CLOSE).
local M = {}

--- PostMessage(WM_CLOSE) targeted at the one matching window, rather than
--- Stop-Process (which would kill the whole browser process, taking every
--- other window/tab down with it). FindWindow requires an exact title
--- match - if the browser decorates the app-mode window title beyond
--- exactly `tag`, this silently fails to find it rather than closing the
--- wrong thing, an acceptable degrade for a best-effort feature. The script
--- prints 1 when a window was found and 0 otherwise.
function M.close(_, tag, done)
  local script = table.concat({
    '$sig = \'[DllImport("user32.dll")] '
      .. "public static extern IntPtr FindWindow(string c, string t);",
    '[DllImport("user32.dll")] public static extern bool PostMessage'
      .. "(IntPtr h, uint m, IntPtr w, IntPtr l);';",
    "Add-Type -MemberDefinition $sig -Name Win32 -Namespace Native;",
    string.format('$h = [Native.Win32]::FindWindow($null, "%s");', tag),
    "if ($h -ne [IntPtr]::Zero) { [Native.Win32]::PostMessage"
      .. "($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null; Write-Output 1 }"
      .. " else { Write-Output 0 }",
  }, " ")
  vim.system({ "powershell", "-NoProfile", "-Command", script }, { text = true }, function(result)
    done(result.code == 0 and vim.trim(result.stdout or "") == "1")
  end)
end

return M
