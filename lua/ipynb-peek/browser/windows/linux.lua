--- Closes the popup on Linux. Reports success to `done(closed)` so the caller
--- can retry while the window title hasn't been set yet.
local M = {}

--- Both mimic the same `search --name <pattern> windowclose` CLI, but see
--- different windows: xdotool only sees X11/XWayland windows (via EWMH),
--- kdotool only sees windows KWin knows about (via its scripting API, which
--- covers both native-Wayland and X11 KWin sessions, and on wlroots
--- compositors like Sway/Hyprland via wlr-foreign-toplevel-management).
--- There's no way to tell from here whether the popup ended up XWayland or
--- native-Wayland, so both are tried when present - whichever doesn't find
--- a matching window is a harmless no-op.
local XDOTOOL_COMPATIBLE = { "kdotool", "xdotool" }

local function close_wmctrl(tag, done)
  vim.system({ "wmctrl", "-l" }, { text = true }, function(result)
    if result.code ~= 0 or not result.stdout then
      return done(false)
    end
    local closed = false
    for line in result.stdout:gmatch("[^\n]+") do
      local window_id = line:match("^(%S+)")
      if window_id and line:find(tag, 1, true) then
        closed = true
        vim.fn.jobstart({ "wmctrl", "-ic", window_id }, { detach = true })
      end
    end
    done(closed)
  end)
end

function M.close(_, tag, done)
  local tools = {}
  for _, bin in ipairs(XDOTOOL_COMPATIBLE) do
    if vim.fn.executable(bin) == 1 then
      table.insert(tools, bin)
    end
  end

  if #tools == 0 then
    if vim.fn.executable("wmctrl") == 1 then
      return close_wmctrl(tag, done)
    end
    return done(true) -- no tool to try; retrying is pointless
  end

  local remaining, closed_any = #tools, false
  for _, bin in ipairs(tools) do
    vim.system({ bin, "search", "--name", tag, "windowclose" }, {}, function(result)
      closed_any = closed_any or result.code == 0
      remaining = remaining - 1
      if remaining == 0 then
        done(closed_any)
      end
    end)
  end
end

return M
