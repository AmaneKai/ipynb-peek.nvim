import { describe, expect, it } from "vitest"
// @ts-expect-error plain JS module shared with the browser bundle
import { MAX_SCALE, MIN_SCALE, clampScale, fitScale, zoomAbout } from "./lightbox.js"

describe("lightbox math", () => {
  it("clamps the scale", () => {
    expect(clampScale(1000)).toBe(MAX_SCALE)
    expect(clampScale(0)).toBe(MIN_SCALE)
  })

  it("keeps the point under the cursor fixed while zooming", () => {
    const start = { scale: 1, x: 10, y: -20 }
    const px = 100
    const py = 50
    const next = zoomAbout(start, 2, px, py)
    // image-space point under the cursor before and after
    const before = [(px - start.x) / start.scale, (py - start.y) / start.scale]
    const after = [(px - next.x) / next.scale, (py - next.y) / next.scale]
    expect(after[0]).toBeCloseTo(before[0])
    expect(after[1]).toBeCloseTo(before[1])
  })

  it("does not drift when already at the zoom limit", () => {
    const atMax = { scale: MAX_SCALE, x: 5, y: 5 }
    expect(zoomAbout(atMax, 2, 30, 30)).toEqual(atMax)
  })

  it("fits large images down but never enlarges small ones", () => {
    expect(fitScale({ width: 2000, height: 1000 }, { width: 1000, height: 1000 })).toBe(0.5)
    expect(fitScale({ width: 100, height: 100 }, { width: 1000, height: 1000 })).toBe(1)
    expect(fitScale({ width: 0, height: 0 }, { width: 1000, height: 1000 })).toBe(1)
  })
})
