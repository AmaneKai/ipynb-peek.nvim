local status = require("ipynb-peek.status")

describe("status.icon_for", function()
  it("shows a busy icon regardless of prior execution_count, error, or staleness", function()
    local icon = status.icon_for(
      { status = "busy", execution_count = 3, has_error = true },
      { edited = true, reasons = {} }
    )
    assert.are.same({ sign_text = "●", hl_group = "DiagnosticWarn" }, icon)
  end)

  it("shows an error icon for an idle cell whose last output was an error", function()
    local icon = status.icon_for(
      { status = "idle", execution_count = 2, has_error = true },
      { edited = true, reasons = {} }
    )
    assert.are.same({ sign_text = "✗", hl_group = "DiagnosticError" }, icon)
  end)

  it("shows a stale sign when idle, non-errored, and stale", function()
    local icon = status.icon_for(
      { status = "idle", execution_count = 2, has_error = false },
      { edited = false, reasons = { { from = 0, symbols = { "lr" }, kind = "upstream_edited" } } }
    )
    assert.are.same({ sign_text = "~", hl_group = "DiagnosticWarn" }, icon)
  end)

  it("shows a success icon for an idle fresh cell with an execution_count", function()
    local icon = status.icon_for({ status = "idle", execution_count = 1, has_error = false })
    assert.are.same({ sign_text = "✓", hl_group = "DiagnosticOk" }, icon)
  end)

  it("shows nothing for a cell that has never been run and is not stale", function()
    local decoded = vim.json.decode('{"status":"idle","execution_count":null,"has_error":false}')
    assert.is_nil(status.icon_for(decoded))
  end)
end)

describe("status.virt_text_for", function()
  it("is blank while busy", function()
    assert.are.equal(
      "",
      status.virt_text_for(
        { status = "busy", execution_count = 5, duration_ms = 100 },
        { edited = true, reasons = { { from = 0, symbols = {}, kind = "edited" } } }
      )
    )
  end)

  it("is blank for a never-run fresh cell", function()
    assert.are.equal("", status.virt_text_for({ status = "idle", execution_count = vim.NIL }))
  end)

  it("shows execution count and duration for a finished cell", function()
    assert.are.equal(
      "  [3] 1.2s",
      status.virt_text_for({ status = "idle", execution_count = 3, duration_ms = 1200 })
    )
  end)

  it("appends human-readable stale reason with 1-indexed cell number and symbols", function()
    local text = status.virt_text_for(
      { status = "idle", execution_count = 2, duration_ms = 400, has_error = false },
      { edited = false, reasons = { { from = 0, symbols = { "lr" }, kind = "upstream_edited" } } }
    )
    assert.are.equal("  [2] 0.4s  ⚠ stale (← #1: lr)", text)
  end)

  it("formats edited-stale reasons", function()
    local text = status.virt_text_for(
      { status = "idle", execution_count = 1, has_error = false },
      { edited = true, reasons = { { from = 0, symbols = {}, kind = "edited" } } }
    )
    assert.are.equal("  [1]  ⚠ stale (edited)", text)
  end)
end)
