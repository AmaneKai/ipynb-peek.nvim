--- Firefox has no app-mode flag, so the closest to a dedicated popup is a
--- separate Firefox instance: --no-remote plus a cached, plugin-owned profile
--- keeps it from attaching to (and disturbing) the user's running Firefox and
--- from touching their real profile. Opt-in (`browser = "firefox"`), since
--- the default for non-Chromium users is a tab in their own browser.
local M = {}

M.name = "firefox"

local MAC_APP = { name = "Firefox", path = "/Applications/Firefox.app" }
local LINUX_BIN_CANDIDATES = { "firefox", "firefox-esr" }

local function windows_candidates()
  local program_files = os.getenv("PROGRAMFILES")
  local program_files_x86 = os.getenv("ProgramFiles(x86)")
  return {
    program_files and (program_files .. "\\Mozilla Firefox\\firefox.exe"),
    program_files_x86 and (program_files_x86 .. "\\Mozilla Firefox\\firefox.exe"),
  }
end

function M.find()
  if vim.fn.has("mac") == 1 then
    if vim.fn.isdirectory(MAC_APP.path) == 1 then
      return { driver = M.name, os = "mac", name = MAC_APP.name }
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

--- Profile directory reused across launches so Firefox's first-run work
--- happens once; created on demand.
function M.profile_dir()
  return vim.fn.stdpath("cache") .. "/ipynb-peek/firefox-profile"
end

function M.command(found, url, window, profile_dir)
  local flags = {
    "--no-remote",
    "--profile",
    profile_dir,
    "--width",
    tostring(window.width),
    "--height",
    tostring(window.height),
    "--new-window",
    url,
  }
  if found.os == "mac" then
    return vim.list_extend({ "open", "-na", found.name, "--args" }, flags)
  end
  return vim.list_extend({ found.binary or found.path }, flags)
end

function M.launch(found, url, window)
  local profile_dir = M.profile_dir()
  vim.fn.mkdir(profile_dir, "p")
  vim.fn.jobstart(M.command(found, url, window, profile_dir), { detach = true })
end

return M
