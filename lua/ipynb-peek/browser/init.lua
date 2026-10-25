--- Cross-platform popup launch and best-effort auto-close for the preview.
---
--- Strategy pattern: a *driver* (browser/drivers/*) knows how to find and
--- launch one browser family; a *window handler* (browser/windows/*) knows how
--- to close a window on one OS. Auto-close has no portable "close this exact
--- window" API, only OS-specific approximations, and fails silently by design
--- - the server stopping is what actually matters.
local M = {}

local DRIVERS = {
  chromium = require("ipynb-peek.browser.drivers.chromium"),
  firefox = require("ipynb-peek.browser.drivers.firefox"),
}

--- Which drivers `browser = "auto"` tries, in order. Firefox is deliberately
--- absent: it can't do a chromeless popup, so it's only used when asked for.
local AUTO_ORDER = { "chromium" }

local CLOSE_RETRY_DELAYS_MS = { 150, 400, 1000 }

local function window_handler()
  if vim.fn.has("mac") == 1 then
    return require("ipynb-peek.browser.windows.mac")
  elseif vim.fn.has("linux") == 1 then
    return require("ipynb-peek.browser.windows.linux")
  elseif vim.fn.has("win32") == 1 then
    return require("ipynb-peek.browser.windows.windows")
  end
end

--- Returns a descriptor for the best available browser, or nil. `preference`
--- is "auto" (default), "chromium", "firefox", or "default" (always nil, i.e.
--- a tab in the system browser).
function M.find(preference)
  preference = preference or "auto"
  if preference == "default" then
    return nil
  end
  local order = preference == "auto" and AUTO_ORDER or { preference }
  for _, name in ipairs(order) do
    local driver = DRIVERS[name]
    local found = driver and driver.find()
    if found then
      return found
    end
  end
  return nil
end

--- Launches `url` as a popup, exactly once per caller (callers are
--- responsible for not calling this on every re-render - the popup receives
--- live updates over its own websocket connection instead). Falls back to a
--- normal browser tab if no supported browser is found.
function M.open(url, window, position, preference)
  local found = M.find(preference)
  if not found then
    if preference == nil or preference == "auto" then
      vim.notify(
        "[ipynb-peek] no supported Chromium-based browser found, "
          .. "opening a regular browser tab instead",
        vim.log.levels.WARN
      )
    end
    vim.ui.open(url)
    return
  end
  DRIVERS[found.driver].launch(found, url, window, position)
end

--- Best-effort close of the popup whose page title contains `tag` (the
--- server tags its page title with "ipynb-peek:<port>" specifically so
--- this can find the right window rather than any other browser window).
--- Reliability varies a lot by platform - see the README. The window's title
--- only exists once the page has loaded, so a close issued right after open
--- finds nothing; retries with growing delays cover that.
function M.close(tag, preference)
  local found = M.find(preference)
  local handler = window_handler()
  if not found or not handler then
    return
  end

  local function attempt(n)
    handler.close(found, tag, function(closed)
      if closed or n > #CLOSE_RETRY_DELAYS_MS then
        return
      end
      vim.defer_fn(function()
        attempt(n + 1)
      end, CLOSE_RETRY_DELAYS_MS[n])
    end)
  end
  attempt(1)
end

return M
