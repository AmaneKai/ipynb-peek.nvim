local browser = require("ipynb-peek.browser")

describe("browser.command", function()
  it("appends url to a custom browser command table without mutating input", function()
    local pref = { "surf", "-z", "1.2" }
    local cmd = browser.command("http://127.0.0.1:9999/?token=abc", pref)
    assert.are.same({ "surf", "-z", "1.2", "http://127.0.0.1:9999/?token=abc" }, cmd)
    assert.are.same({ "surf", "-z", "1.2" }, pref)
  end)

  it("returns nil for default or false preference", function()
    assert.is_nil(browser.command("http://127.0.0.1:1/", "default"))
    assert.is_nil(browser.command("http://127.0.0.1:1/", false))
    assert.is_nil(browser.command("http://127.0.0.1:1/", nil))
  end)
end)

describe("browser.open", function()
  it("notifies the URL and does not call vim.ui.open when browser = false", function()
    local notified = {}
    local opened = false
    local orig_notify = vim.notify
    local orig_open = vim.ui.open
    vim.notify = function(msg)
      table.insert(notified, msg)
    end
    vim.ui.open = function()
      opened = true
    end

    browser.open("http://127.0.0.1:1234/?token=tok", false)

    vim.notify = orig_notify
    vim.ui.open = orig_open

    assert.is_false(opened)
    assert.are.equal(1, #notified)
    assert.is_truthy(notified[1]:find("http://127.0.0.1:1234/?token=tok", 1, true))
  end)

  it("uses vim.ui.open when browser = 'default'", function()
    local opened_url = nil
    local orig_open = vim.ui.open
    vim.ui.open = function(url)
      opened_url = url
    end

    browser.open("http://127.0.0.1:1234/?token=tok", "default")
    vim.ui.open = orig_open

    assert.are.equal("http://127.0.0.1:1234/?token=tok", opened_url)
  end)
end)
