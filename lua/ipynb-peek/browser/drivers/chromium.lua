--- Chromium-family browsers (Chrome, Brave, Edge, Chromium): launched with
--- --app=<url>, a chromeless "app mode" window sized and positioned via flags.
local M = {}

M.name = "chromium"

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

--- Returns a descriptor for the best available browser of this family on this
--- OS, or nil. Shape differs per OS because launch mechanics differ: macOS
--- needs an app *name* (for `open -na`), Linux/Windows need a binary path to
--- exec directly.
function M.find()
  if vim.fn.has("mac") == 1 then
    for _, app in ipairs(MAC_APPS) do
      if vim.fn.isdirectory(app.path) == 1 then
        return { driver = M.name, os = "mac", name = app.name }
      end
    end
  elseif vim.fn.has("linux") == 1 then
    for _, binary in ipairs(LINUX_BIN_CANDIDATES) do
      if vim.fn.executable(binary) == 1 then
        return { driver = M.name, os = "linux", binary = binary }
      end
    end
  elseif vim.fn.has("win32") == 1 then
    for _, path in ipairs(windows_candidates()) do
      if path and vim.fn.filereadable(path) == 1 then
        return { driver = M.name, os = "win32", path = path }
      end
    end
  end
  return nil
end

--- The command line that opens `url` as a popup (pure; see M.launch).
function M.command(found, url, window, position)
  local flags = {
    "--app=" .. url,
    string.format("--window-size=%d,%d", window.width, window.height),
    string.format("--window-position=%d,%d", position.x, position.y),
  }
  if found.os == "mac" then
    return vim.list_extend({ "open", "-na", found.name, "--args" }, flags)
  end
  return vim.list_extend({ found.binary or found.path }, flags)
end

function M.launch(found, url, window, position)
  vim.fn.jobstart(M.command(found, url, window, position), { detach = true })
end

return M
