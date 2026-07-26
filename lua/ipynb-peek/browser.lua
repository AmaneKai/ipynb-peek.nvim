--- Cross-platform popup launch and best-effort auto-close for the preview.
--- Launches via a Chromium-based browser's --app=<url> flag (a chromeless
--- "app mode" window, not a normal tab); auto-close has no portable "close
--- this exact window" API, only OS-specific approximations, and fails
--- silently by design - the server stopping is what actually matters.
local M = {}

local MAC_APPS = {
  { name = "Google Chrome", path = "/Applications/Google Chrome.app" },
  { name = "Brave Browser", path = "/Applications/Brave Browser.app" },
  { name = "Microsoft Edge", path = "/Applications/Microsoft Edge.app" },
  { name = "Chromium", path = "/Applications/Chromium.app" },
}

local LINUX_BIN_CANDIDATES = {
  "google-chrome-stable",
  "google-chrome",
  "chromium-browser",
  "chromium",
  "brave-browser",
  "microsoft-edge",
}

--- vim.fn.jobstart execs binaries directly and does not consult the
--- registry "App Paths" the way `cmd /c start chrome` would, so known
--- install locations are probed directly instead of relying on a bare name
--- on PATH.
local function windows_candidates()
  local program_files = os.getenv("PROGRAMFILES")
  local program_files_x86 = os.getenv("ProgramFiles(x86)")
  local local_app_data = os.getenv("LOCALAPPDATA")
  return {
    program_files and (program_files .. "\\Google\\Chrome\\Application\\chrome.exe"),
    program_files_x86 and (program_files_x86 .. "\\Google\\Chrome\\Application\\chrome.exe"),
    local_app_data and (local_app_data .. "\\Google\\Chrome\\Application\\chrome.exe"),
    program_files_x86 and (program_files_x86 .. "\\Microsoft\\Edge\\Application\\msedge.exe"),
    program_files and (program_files .. "\\Microsoft\\Edge\\Application\\msedge.exe"),
    local_app_data and (local_app_data .. "\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
  }
end

--- Returns a descriptor for the best available Chromium-based browser on
--- this OS, or nil. Shape differs per OS because launch mechanics differ:
--- macOS needs an app *name* (for `open -na`), Linux/Windows need a binary
--- path to exec directly.
function M.find()
  if vim.fn.has("mac") == 1 then
    for _, app in ipairs(MAC_APPS) do
      if vim.fn.isdirectory(app.path) == 1 then
        return { os = "mac", name = app.name }
      end
    end
  elseif vim.fn.has("linux") == 1 then
    for _, binary in ipairs(LINUX_BIN_CANDIDATES) do
      if vim.fn.executable(binary) == 1 then
        return { os = "linux", binary = binary }
      end
    end
  elseif vim.fn.has("win32") == 1 then
    for _, path in ipairs(windows_candidates()) do
      if path and vim.fn.filereadable(path) == 1 then
        return { os = "win32", path = path }
      end
    end
  end
  return nil
end

--- Launches `url` as a chromeless app-mode popup, exactly once per caller
--- (callers are responsible for not calling this on every re-render - the
--- popup receives live updates over its own websocket connection instead).
--- Falls back to a normal browser tab if no supported browser is found.
function M.open(url, window, position)
  local found = M.find()
  if not found then
    vim.notify(
      "[ipynb-peek] no supported Chromium-based browser found, "
        .. "opening a regular browser tab instead",
      vim.log.levels.WARN
    )
    vim.ui.open(url)
    return
  end

  local size_arg = string.format("--window-size=%d,%d", window.width, window.height)
  local pos_arg = string.format("--window-position=%d,%d", position.x, position.y)
  local app_arg = "--app=" .. url

  if found.os == "mac" then
    vim.fn.jobstart(
      { "open", "-na", found.name, "--args", app_arg, size_arg, pos_arg },
      { detach = true }
    )
  else
    local binary = found.os == "linux" and found.binary or found.path
    vim.fn.jobstart({ binary, app_arg, size_arg, pos_arg }, { detach = true })
  end
end

local function close_mac(app_name, tag)
  local script = string.format(
    [[tell application "%s"
        repeat with w in every window
          try
            if (name of w) contains "%s" then close w
          end try
        end repeat
      end tell]],
    app_name,
    tag
  )
  vim.fn.jobstart({ "osascript", "-e", script }, { detach = true })
end

local function close_wmctrl_match(tag, line)
  local window_id = line:match("^(%S+)")
  if not window_id or not line:find(tag, 1, true) then
    return
  end
  vim.fn.jobstart({ "wmctrl", "-ic", window_id }, { detach = true })
end

local function close_linux(tag)
  if vim.fn.executable("xdotool") == 1 then
    vim.fn.jobstart({ "xdotool", "search", "--name", tag, "windowclose" }, { detach = true })
    return
  end
  if vim.fn.executable("wmctrl") == 1 then
    vim.system({ "wmctrl", "-l" }, { text = true }, function(result)
      if result.code ~= 0 or not result.stdout then
        return
      end
      for line in result.stdout:gmatch("[^\n]+") do
        close_wmctrl_match(tag, line)
      end
    end)
  end
end

--- PostMessage(WM_CLOSE) targeted at the one matching window, rather than
--- Stop-Process (which would kill the whole browser process, taking every
--- other window/tab down with it). FindWindow requires an exact title
--- match - if the browser decorates the app-mode window title beyond
--- exactly `tag`, this silently fails to find it rather than closing the
--- wrong thing, an acceptable degrade for a best-effort feature.
local function close_windows(tag)
  local script = table.concat({
    "$sig = '[DllImport(\"user32.dll\")] "
      .. 'public static extern IntPtr FindWindow(string c, string t);',
    '[DllImport("user32.dll")] public static extern bool PostMessage'
      .. "(IntPtr h, uint m, IntPtr w, IntPtr l);';",
    "Add-Type -MemberDefinition $sig -Name Win32 -Namespace Native;",
    string.format('$h = [Native.Win32]::FindWindow($null, "%s");', tag),
    "if ($h -ne [IntPtr]::Zero) { [Native.Win32]::PostMessage"
      .. "($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }",
  }, " ")
  vim.fn.jobstart({ "powershell", "-NoProfile", "-Command", script }, { detach = true })
end

--- Best-effort close of the popup whose page title contains `tag` (the
--- server tags its page title with "ipynb-peek:<port>" specifically so
--- this can find the right window rather than any other browser window).
--- Reliability varies a lot by platform - see the README.
function M.close(tag)
  local found = M.find()
  if not found then
    return
  end

  if found.os == "mac" then
    close_mac(found.name, tag)
  elseif found.os == "linux" then
    close_linux(tag)
  elseif found.os == "win32" then
    close_windows(tag)
  end
end

return M
