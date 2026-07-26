import { describe, test, expect } from "bun:test"
import { createHmac } from "node:crypto"
import { sign, buildMessage, parseFrames, DELIM } from "./wire-protocol"

describe("sign", () => {
  test("matches an independently computed HMAC-SHA256 digest", () => {
    const digest = createHmac("sha256", "secret-key").update("a").update("b").digest("hex")
    expect(sign(["a", "b"], "secret-key")).toBe(digest)
  })

  test("changes when any part changes", () => {
    const base = sign(["header", "parent", "meta", "content"], "key")
    const changed = sign(["header", "parent", "meta", "different"], "key")
    expect(changed).not.toBe(base)
  })
})

describe("buildMessage", () => {
  test("produces a DELIM-prefixed frame list with a verifiable signature", () => {
    const frames = buildMessage("execute_request", { code: "1+1" }, "msg-1", "key", "session-1")
    const [delim, signature, headerStr, parentStr, metaStr, contentStr] = frames

    expect(delim).toBe(DELIM)
    expect(sign([headerStr, parentStr, metaStr, contentStr], "key")).toBe(signature)

    const header = JSON.parse(headerStr)
    expect(header.msg_id).toBe("msg-1")
    expect(header.msg_type).toBe("execute_request")
    expect(header.session).toBe("session-1")
    expect(JSON.parse(contentStr)).toEqual({ code: "1+1" })
    expect(JSON.parse(parentStr)).toEqual({})
  })

  test("carries a provided parent header through", () => {
    const frames = buildMessage("status", {}, "msg-2", "key", "session-1", { msg_id: "parent-1" })
    const parentStr = frames[3]
    expect(JSON.parse(parentStr)).toEqual({ msg_id: "parent-1" })
  })
})

describe("parseFrames", () => {
  test("round-trips a message built by buildMessage", () => {
    const built = buildMessage("execute_result", { data: {} }, "msg-3", "key", "session-1", {
      msg_id: "parent-3",
    })
    const frames = built.map((part) => Buffer.from(part, "utf8"))

    const parsed = parseFrames(frames)

    expect(parsed).not.toBeNull()
    expect(parsed?.header.msg_type).toBe("execute_result")
    expect(parsed?.parent_header.msg_id).toBe("parent-3")
    expect(parsed?.content).toEqual({ data: {} })
  })

  test("skips leading ROUTER identity frames before the delimiter", () => {
    const built = buildMessage("status", { execution_state: "idle" }, "msg-4", "key", "session-1")
    const frames = [Buffer.from("identity-frame"), ...built.map((part) => Buffer.from(part))]

    const parsed = parseFrames(frames)

    expect(parsed?.header.msg_type).toBe("status")
    expect(parsed?.content).toEqual({ execution_state: "idle" })
  })

  test("returns null when no delimiter frame is present", () => {
    const frames = [Buffer.from("not"), Buffer.from("a"), Buffer.from("jupyter-message")]
    expect(parseFrames(frames)).toBeNull()
  })
})
