import { describe, expect, it } from "vitest"
// @ts-expect-error plain JS module shared with the browser bundle
import { cellKey, createStore, initialState, reducer } from "./store.js"

const cell = (id: string | undefined, source = "x") => ({ id, source, cell_type: "code" })

describe("cellKey", () => {
  it("prefers the nbformat id and falls back to position", () => {
    expect(cellKey(cell("abc"), 3)).toBe("id:abc")
    expect(cellKey(cell(undefined), 3)).toBe("pos:3")
  })
})

describe("reducer", () => {
  it("replaces the cell list on NOTEBOOK_RENDERED without touching reveal state", () => {
    const revealed = reducer(initialState(), { type: "TOGGLE_SOURCE", key: "id:a" })
    const next = reducer(revealed, { type: "NOTEBOOK_RENDERED", cells: [cell("a")] })
    expect(next.cells).toHaveLength(1)
    expect(next.revealedSource.has("id:a")).toBe(true)
  })

  it("updates a single cell immutably", () => {
    const state = reducer(initialState(), {
      type: "NOTEBOOK_RENDERED",
      cells: [cell("a"), cell("b")],
    })
    const next = reducer(state, { type: "CELL_UPDATED", index: 1, cell: cell("b", "new") })
    expect(next.cells[1].source).toBe("new")
    expect(next.cells[0]).toBe(state.cells[0])
    expect(state.cells[1].source).toBe("x")
  })

  it("ignores an update for a cell that does not exist", () => {
    const state = initialState()
    expect(reducer(state, { type: "CELL_UPDATED", index: 4, cell: cell("z") })).toBe(state)
  })

  it("toggles source and output reveal independently", () => {
    let state = reducer(initialState(), { type: "TOGGLE_OUTPUTS", key: "pos:0" })
    expect(state.revealedOutputs.has("pos:0")).toBe(true)
    expect(state.revealedSource.has("pos:0")).toBe(false)
    state = reducer(state, { type: "TOGGLE_OUTPUTS", key: "pos:0" })
    expect(state.revealedOutputs.has("pos:0")).toBe(false)
  })

  it("tracks the stdin prompt", () => {
    let state = reducer(initialState(), {
      type: "INPUT_REQUESTED",
      prompt: "name?",
      password: true,
    })
    expect(state.input).toEqual({ prompt: "name?", password: true })
    state = reducer(state, { type: "INPUT_CLEARED" })
    expect(state.input).toBeNull()
  })

  it("records the cursor cell", () => {
    expect(reducer(initialState(), { type: "CURSOR_MOVED", index: 2 }).activeIndex).toBe(2)
  })
})

describe("ui state", () => {
  it("clamps the outline width", () => {
    expect(reducer(initialState(), { type: "SET_TOC_WIDTH", width: 20 }).tocWidth).toBe(160)
    expect(reducer(initialState(), { type: "SET_TOC_WIDTH", width: 9000 }).tocWidth).toBe(600)
    expect(reducer(initialState(), { type: "SET_TOC_WIDTH", width: 300.4 }).tocWidth).toBe(300)
  })

  it("sets theme, presentation and outline visibility", () => {
    let state = reducer(initialState(), { type: "SET_THEME", name: "gruvbox" })
    state = reducer(state, { type: "SET_PRESENTATION", on: true })
    state = reducer(state, { type: "SET_TOC", open: true })
    expect([state.theme, state.presentation, state.tocOpen]).toEqual(["gruvbox", true, true])
    expect(reducer(state, { type: "SET_THEME" }).theme).toBe("default")
  })
})

describe("createStore", () => {
  it("notifies subscribers with the new state, previous state and action", () => {
    const store = createStore()
    const seen: any[] = []
    store.subscribe((state: any, previous: any, action: any) =>
      seen.push([state, previous, action]),
    )

    store.dispatch({ type: "CURSOR_MOVED", index: 1 })

    expect(seen).toHaveLength(1)
    expect(seen[0][0].activeIndex).toBe(1)
    expect(seen[0][1].activeIndex).toBeNull()
    expect(seen[0][2].type).toBe("CURSOR_MOVED")
  })
})
