import { describe, expect, it } from "vitest"
// @ts-expect-error plain JS module shared with the browser bundle
import { cellSignature, planReconcile } from "./reconcile.js"

const cell = (id: string | undefined, source: string, extra: object = {}) => ({
  id,
  source,
  cell_type: "code",
  outputs: [],
  ...extra,
})
const entryFor = (c: any, name: string) => ({ name, cell: c, sig: cellSignature(c) })

describe("cellSignature", () => {
  it("ignores the list index but not content", () => {
    expect(cellSignature({ ...cell("a", "1"), index: 0 })).toBe(
      cellSignature({ ...cell("a", "1"), index: 5 }),
    )
    expect(cellSignature(cell("a", "1"))).not.toBe(cellSignature(cell("a", "2")))
  })
})

describe("planReconcile", () => {
  it("keeps every entry untouched when nothing changed", () => {
    const old = [entryFor(cell("a", "1"), "A"), entryFor(cell("b", "2"), "B")]
    const plan = planReconcile(old, [cell("a", "1"), cell("b", "2")])

    expect(plan.items.map((i: any) => i.entry.name)).toEqual(["A", "B"])
    expect(plan.items.every((i: any) => !i.changed)).toBe(true)
    expect(plan.removed).toEqual([])
  })

  it("keeps the later cells' DOM when a cell is inserted above", () => {
    const old = [entryFor(cell("a", "1"), "A"), entryFor(cell("b", "2"), "B")]
    const plan = planReconcile(old, [cell("new", "0"), cell("a", "1"), cell("b", "2")])

    expect(plan.items[0].entry).toBeNull()
    expect(plan.items[1].entry.name).toBe("A")
    expect(plan.items[2].entry.name).toBe("B")
    expect(plan.items.slice(1).every((i: any) => !i.changed)).toBe(true)
  })

  it("removes only the deleted cell", () => {
    const old = [
      entryFor(cell("a", "1"), "A"),
      entryFor(cell("b", "2"), "B"),
      entryFor(cell("c", "3"), "C"),
    ]
    const plan = planReconcile(old, [cell("a", "1"), cell("c", "3")])

    expect(plan.removed.map((e: any) => e.name)).toEqual(["B"])
    expect(plan.items.map((i: any) => i.entry.name)).toEqual(["A", "C"])
    expect(plan.items.every((i: any) => !i.changed)).toBe(true)
  })

  it("re-renders an edited cell in place, matched by id", () => {
    const old = [entryFor(cell("a", "1"), "A"), entryFor(cell("b", "2"), "B")]
    const plan = planReconcile(old, [cell("a", "1"), cell("b", "2 edited")])

    expect(plan.items[1].entry.name).toBe("B")
    expect(plan.items[1].changed).toBe(true)
    expect(plan.items[0].changed).toBe(false)
  })

  it("follows a reordered cell by id", () => {
    const old = [entryFor(cell("a", "1"), "A"), entryFor(cell("b", "2"), "B")]
    const plan = planReconcile(old, [cell("b", "2"), cell("a", "1")])

    expect(plan.items.map((i: any) => i.entry.name)).toEqual(["B", "A"])
    expect(plan.items.every((i: any) => !i.changed)).toBe(true)
  })

  it("matches id-less cells by identical content when they shift", () => {
    const old = [entryFor(cell(undefined, "1"), "A"), entryFor(cell(undefined, "2"), "B")]
    const plan = planReconcile(old, [
      cell(undefined, "0"),
      cell(undefined, "1"),
      cell(undefined, "2"),
    ])

    expect(plan.items[1].entry.name).toBe("A")
    expect(plan.items[2].entry.name).toBe("B")
    expect(plan.items[1].changed).toBe(false)
    expect(plan.items[0].entry).toBeNull()
  })

  it("pairs leftover id-less cells in order and re-renders them", () => {
    const old = [entryFor(cell(undefined, "1"), "A"), entryFor(cell(undefined, "2"), "B")]
    const plan = planReconcile(old, [cell(undefined, "1"), cell(undefined, "2 edited")])

    expect(plan.items[1].entry.name).toBe("B")
    expect(plan.items[1].changed).toBe(true)
    expect(plan.removed).toEqual([])
  })

  it("treats an output change as a change to that cell only", () => {
    const old = [entryFor(cell("a", "1"), "A"), entryFor(cell("b", "2"), "B")]
    const plan = planReconcile(old, [
      cell("a", "1", { outputs: [{ kind: "text", content: "hi" }] }),
      cell("b", "2"),
    ])

    expect(plan.items[0].changed).toBe(true)
    expect(plan.items[1].changed).toBe(false)
  })

  it("handles an empty page and an empty notebook", () => {
    expect(planReconcile([], [cell("a", "1")]).items[0].entry).toBeNull()
    const plan = planReconcile([entryFor(cell("a", "1"), "A")], [])
    expect(plan.items).toEqual([])
    expect(plan.removed).toHaveLength(1)
  })
})
