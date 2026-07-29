/**
 * Pure Jupyter wire-protocol framing: HMAC-SHA256 signed multipart messages
 * delimited by "<IDS|MSG>". Split out of kernel-bridge.mjs so it can be unit
 * tested without triggering that file's stdin command-loop side effect.
 */
import { createHmac } from "node:crypto"

export const DELIM = "<IDS|MSG>"

export function sign(parts, key) {
  const hmac = createHmac("sha256", key)

  for (const part of parts) hmac.update(part)

  return hmac.digest("hex")
}

export function buildMessage(msgType, content, msgId, key, session, parentHeader = {}) {
  const header = {
    msg_id: msgId,
    username: "ipynb-peek",
    session,
    date: new Date().toISOString(),
    msg_type: msgType,
    version: "5.3",
  }
  const headerStr = JSON.stringify(header)
  const parentStr = JSON.stringify(parentHeader)
  const metaStr = JSON.stringify({})
  const contentStr = JSON.stringify(content)
  const sig = sign([headerStr, parentStr, metaStr, contentStr], key)
  return [DELIM, sig, headerStr, parentStr, metaStr, contentStr]
}

export function parseFrames(frames) {
  const strs = frames.map((frame) => frame.toString("utf8"))
  const index = strs.indexOf(DELIM)

  if (index === -1) return null

  /** slice = [DELIM, signature, header, parent_header, metadata, content] */
  const [, , headerStr, parentStr, , contentStr] = strs.slice(index, index + 6)
  return {
    header: JSON.parse(headerStr),
    parent_header: parentStr ? JSON.parse(parentStr) : {},
    content: contentStr ? JSON.parse(contentStr) : {},
  }
}
