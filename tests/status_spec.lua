local status = require("ipynb-peek.status")

describe("status.icon_for", function()
  it("shows a busy icon regardless of any prior execution_count or error", function()
    local icon = status.icon_for({ status = "busy", execution_count = 3, has_error = true })
    assert.are.same({ sign_text = "●", hl_group = "DiagnosticWarn" }, icon)
  end)

  it("shows an error icon for an idle cell whose last output was an error", function()
    local icon = status.icon_for({ status = "idle", execution_count = 2, has_error = true })
    assert.are.same({ sign_text = "✗", hl_group = "DiagnosticError" }, icon)
  end)

  it("shows a success icon for an idle cell with an execution_count and no error", function()
    local icon = status.icon_for({ status = "idle", execution_count = 1, has_error = false })
    assert.are.same({ sign_text = "✓", hl_group = "DiagnosticOk" }, icon)
  end)

  it("shows nothing for a cell that has never been run", function()
    local icon = status.icon_for({ status = "idle", execution_count = vim.NIL, has_error = false })
    assert.is_nil(icon)
  end)

  it("treats a decoded JSON null execution_count the same as never-run, not as success", function()
    -- Regression test: vim.json.decode('{"execution_count":null}').execution_count
    -- is vim.NIL, not Lua nil - a `~= nil` only check would wrongly treat this
    -- as "has an execution count" and show a checkmark.
    local decoded = vim.json.decode('{"status":"idle","execution_count":null,"has_error":false}')
    assert.is_nil(status.icon_for(decoded))
  end)
end)

describe("status.virt_text_for", function()
  it("is blank while busy even if an execution_count is already present", function()
    assert.are.equal(
      "",
      status.virt_text_for({ status = "busy", execution_count = 5, duration_ms = 100 })
    )
  end)

  it("is blank for a cell that has never been run", function()
    assert.are.equal("", status.virt_text_for({ status = "idle", execution_count = vim.NIL }))
  end)

  it("shows the execution count and duration for a finished cell", function()
    assert.are.equal(
      "  [3] 1.2s",
      status.virt_text_for({ status = "idle", execution_count = 3, duration_ms = 1200 })
    )
  end)

  it("shows just the execution count when duration_ms is absent", function()
    assert.are.equal("  [1]", status.virt_text_for({ status = "idle", execution_count = 1 }))
  end)
end)
