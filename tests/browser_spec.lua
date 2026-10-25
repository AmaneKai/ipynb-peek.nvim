local browser = require("ipynb-peek.browser")
local chromium = require("ipynb-peek.browser.drivers.chromium")
local firefox = require("ipynb-peek.browser.drivers.firefox")

local window = { width = 900, height = 1000 }
local position = { x = 40, y = 50 }

describe("chromium driver command", function()
  it("opens an app-mode window via `open -na` on macOS", function()
    local cmd = chromium.command(
      { os = "mac", name = "Google Chrome" },
      "http://127.0.0.1:1/",
      window,
      position
    )
    assert.are.same({
      "open",
      "-na",
      "Google Chrome",
      "--args",
      "--app=http://127.0.0.1:1/",
      "--window-size=900,1000",
      "--window-position=40,50",
    }, cmd)
  end)

  it("execs the binary directly elsewhere", function()
    local cmd =
      chromium.command({ os = "linux", binary = "chromium" }, "http://x/", window, position)
    assert.are.equal("chromium", cmd[1])
    assert.are.equal("--app=http://x/", cmd[2])
  end)
end)

describe("firefox driver command", function()
  it("uses an isolated profile and a separate instance", function()
    local cmd = firefox.command({ os = "linux", binary = "firefox" }, "http://x/", window, "/p")
    assert.are.same({
      "firefox",
      "--no-remote",
      "--profile",
      "/p",
      "--width",
      "900",
      "--height",
      "1000",
      "--new-window",
      "http://x/",
    }, cmd)
  end)
end)

describe("browser.find", function()
  it("returns nil for the `default` preference", function()
    assert.is_nil(browser.find("default"))
  end)
end)
