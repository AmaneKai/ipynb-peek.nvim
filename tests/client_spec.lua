local client = require("ipynb-peek.client")

describe("client.debounce", function()
  after_each(function()
    client.cancel_debounced()
  end)

  it("runs only the newest callback for a key", function()
    local calls = {}
    client.debounce("test-latest", 5, function()
      table.insert(calls, "old")
    end)
    client.debounce("test-latest", 5, function()
      table.insert(calls, "new")
    end)

    assert.is_true(vim.wait(100, function()
      return #calls == 1
    end))
    assert.are.same({ "new" }, calls)
  end)

  it("does not run work cancelled before its timer fires", function()
    local called = false
    client.debounce("test-cancel", 5, function()
      called = true
    end)

    client.cancel_debounced()
    vim.wait(30)

    assert.is_false(called)
  end)
end)
