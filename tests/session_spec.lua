local session = require("ipynb-peek.session")

describe("session state machine", function()
  before_each(function()
    session._reset()
  end)

  it("walks idle -> starting -> active -> idle", function()
    local id = session.begin(7)
    assert.are.equal("starting", session.state)
    assert.is_false(session.is_active())

    assert.is_true(session.activate(id))
    assert.is_true(session.is_active())
    assert.are.equal(7, session.bufnr)

    assert.are.equal(7, session.finish())
    assert.are.equal("idle", session.state)
    assert.is_nil(session.bufnr)
  end)

  it("refuses a second session and says why", function()
    session.begin(1)
    local id, reason = session.begin(1)
    assert.is_nil(id)
    assert.are.equal("same-buffer", reason)

    local id2, reason2 = session.begin(2)
    assert.is_nil(id2)
    assert.are.equal("other-buffer", reason2)
  end)

  it("hands out a fresh id per session and drops stale ones", function()
    local first = session.begin(1)
    session.finish()
    local second = session.begin(1)

    assert.are_not.equal(first, second)
    assert.is_false(session.is_current(first))
    assert.is_false(session.activate(first))
    assert.is_true(session.activate(second))
  end)

  it("records the failure reason and still finishes cleanly", function()
    local id = session.begin(3)
    assert.is_true(session.fail(id, "boom"))
    assert.are.equal("error", session.state)
    assert.are.equal("boom", session.error)
    assert.is_false(session.is_active())

    assert.are.equal(3, session.finish())
    assert.are.equal("idle", session.state)
    assert.are.equal("boom", session.error)
  end)

  it("ignores a failure reported for a stale session", function()
    local old = session.begin(1)
    session.finish()
    session.begin(1)

    assert.is_false(session.fail(old, "late"))
    assert.are.equal("starting", session.state)
  end)

  it("finish on an idle session is a no-op", function()
    assert.is_nil(session.finish())
    assert.are.equal("idle", session.state)
  end)
end)
