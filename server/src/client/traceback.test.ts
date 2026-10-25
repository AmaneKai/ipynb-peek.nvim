import { describe, expect, it } from "vitest"
// @ts-expect-error plain JS module shared with the browser bundle
import { tracebackSegments } from "./traceback.js"

const links = (text: string) =>
  tracebackSegments(text)
    .filter((s: any) => s.link)
    .map((s: any) => s.link)

describe("tracebackSegments", () => {
  it("links an ipykernel cell frame by execution count", () => {
    const text = 'ValueError\nCell In[3], line 4\n    raise ValueError("x")'
    expect(links(text)).toEqual([{ execCount: 3, line: 4 }])
  })

  it("links the older Input In [N] form", () => {
    expect(links("Input In [12], line 7")).toEqual([{ execCount: 12, line: 7 }])
  })

  it("links classic File frames", () => {
    expect(links('  File "/p/model.py", line 42, in forward')).toEqual([
      { file: "/p/model.py", line: 42 },
    ])
  })

  it("links IPython 8 path:line frames, including Windows paths", () => {
    expect(links("File /p/model.py:42, in forward")).toEqual([{ file: "/p/model.py", line: 42 }])
    expect(links("File C:\\proj\\m.py:9, in f")).toEqual([{ file: "C:\\proj\\m.py", line: 9 }])
  })

  it("keeps all text, in order, around the links", () => {
    const text = 'a\nCell In[1], line 2\nb\nFile "/x.py", line 3\nc'
    const rebuilt = tracebackSegments(text)
      .map((s: any) => s.text)
      .join("")
    expect(rebuilt).toBe(text)
    expect(links(text)).toHaveLength(2)
  })

  it("does not link pseudo-files or plain prose", () => {
    expect(links("File <string>, line 1")).toEqual([])
    expect(links("see line 4 of the notebook")).toEqual([])
  })

  it("never treats markup in the text as anything but text", () => {
    const segments = tracebackSegments("<img src=x onerror=alert(1)> Cell In[1], line 1")
    expect(segments[0].text).toContain("<img")
    expect(segments[0].link).toBeUndefined()
  })
})
