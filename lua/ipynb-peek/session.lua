--- Lifecycle of the (single) preview session as an explicit state machine, so
--- "is it safe to send a command right now" has one answer instead of being
--- inferred from several flags:
---
---   idle -> starting -> active -> stopping -> idle
---              \          \
---               +----------+--> error -> stopping -> idle
---
--- Every begin() hands out a fresh id. Async callbacks (server ready, events,
--- timers) capture the id they were created under and drop themselves via
--- is_current() once the session they belonged to is gone - a stale callback
--- from a closed preview can never act on a later one.
---
--- Pure state: touches no buffers, processes, or timers.
local M = {}

local TRANSITIONS = {
  idle = { starting = true },
  starting = { active = true, error = true, stopping = true },
  active = { error = true, stopping = true },
  error = { stopping = true },
  stopping = { idle = true },
}

M.state = "idle"
M.id = 0
M.bufnr = nil
--- Why the session last entered "error" (kept after returning to idle so
--- :checkhealth / bug reports can see it); cleared by the next begin().
M.error = nil

local function transition(to)
  assert(TRANSITIONS[M.state][to], ("invalid session transition %s -> %s"):format(M.state, to))
  M.state = to
end

--- idle -> starting. Returns the new session id, or nil and a reason when a
--- session already exists (callers show the reason; there is one global
--- server/kernel, so a second notebook cannot be previewed concurrently).
function M.begin(bufnr)
  if M.state ~= "idle" then
    return nil, M.bufnr == bufnr and "same-buffer" or "other-buffer"
  end
  transition("starting")
  M.id = M.id + 1
  M.bufnr = bufnr
  M.error = nil
  return M.id
end

--- starting -> active. False (and no change) if `id` is no longer current.
function M.activate(id)
  if not M.is_current(id) or M.state ~= "starting" then
    return false
  end
  transition("active")
  return true
end

--- starting|active -> error. False if `id` is stale or already past that.
function M.fail(id, message)
  if not M.is_current(id) or (M.state ~= "starting" and M.state ~= "active") then
    return false
  end
  transition("error")
  M.error = message
  return true
end

--- Any live state -> stopping -> idle. Returns the buffer the session belonged
--- to (nil if there was none), so the caller can clean it up.
function M.finish()
  if M.state == "idle" then
    return nil
  end
  local bufnr = M.bufnr
  transition("stopping")
  M.bufnr = nil
  transition("idle")
  return bufnr
end

function M.is_active()
  return M.state == "active"
end

--- True while `id` still identifies the live session.
function M.is_current(id)
  return id == M.id and M.state ~= "idle" and M.state ~= "stopping"
end

--- Test helper: back to a pristine idle session.
function M._reset()
  M.state = "idle"
  M.id = 0
  M.bufnr = nil
  M.error = nil
end

return M
