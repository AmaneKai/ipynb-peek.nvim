/**
 * Finds source locations in a plain-text Python traceback so they can be made
 * clickable. Pure: returns segments, and the caller builds DOM from them (never
 * innerHTML - the text comes from whatever the kernel printed).
 *
 * Recognized forms (ipykernel / IPython):
 *   Cell In[3], line 4          -> { execCount: 3, line: 4 }
 *   Input In [3], line 4        -> { execCount: 3, line: 4 }   (older IPython)
 *   File "/p/model.py", line 42 -> { file: "/p/model.py", line: 42 }
 *   File /p/model.py:42         -> { file: "/p/model.py", line: 42 }   (IPython 8)
 */
const LOCATION = new RegExp(
  [
    String.raw`(?:Cell In|Input In) ?\[(\d+)\], line (\d+)`,
    String.raw`File "([^"\n]+)", line (\d+)`,
    String.raw`File ((?:\/|[A-Za-z]:[\\/])[^\s:"]+):(\d+)`,
  ].join("|"),
  "g",
)

/** @returns {{text: string, link?: {execCount?: number, file?: string, line: number}}[]} */
export function tracebackSegments(text) {
  const segments = []
  let last = 0
  for (const match of text.matchAll(LOCATION)) {
    if (match.index > last) segments.push({ text: text.slice(last, match.index) })
    const [whole, execCount, cellLine, quotedFile, quotedLine, plainFile, plainLine] = match
    let link
    if (execCount) link = { execCount: Number(execCount), line: Number(cellLine) }
    else if (quotedFile) link = { file: quotedFile, line: Number(quotedLine) }
    else link = { file: plainFile, line: Number(plainLine) }
    segments.push({ text: whole, link })
    last = match.index + whole.length
  }
  if (last < text.length) segments.push({ text: text.slice(last) })
  return segments
}

/**
 * Builds a <pre class="error-output"> whose locations are links;
 * `onJump(link)` receives the parsed location when one is clicked.
 */
export function renderTraceback(text, onJump) {
  const pre = document.createElement("pre")
  pre.className = "error-output"
  for (const segment of tracebackSegments(text)) {
    if (!segment.link) {
      pre.appendChild(document.createTextNode(segment.text))
      continue
    }
    const anchor = document.createElement("a")
    anchor.href = "#"
    anchor.className = "traceback-jump"
    anchor.title = "Jump to this line in Neovim"
    anchor.textContent = segment.text
    anchor.addEventListener("click", (event) => {
      event.preventDefault()
      onJump(segment.link)
    })
    pre.appendChild(anchor)
  }
  return pre
}
