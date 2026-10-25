/**
 * Cell-level reconciliation: decides which existing DOM entries can be kept
 * for a new cell list, which need re-rendering in place, and which are new or
 * gone. Pure data in, plan out - no DOM - so it is unit-testable.
 */

/** Everything that affects how a cell renders, except where it sits in the list. */
export function cellSignature(cell) {
  const { index: _index, ...rest } = cell
  return JSON.stringify(rest)
}

/**
 * @param {{cell: object, sig: string}[]} oldEntries entries currently on the page, in order
 * @param {object[]} newCells the cells that should be on the page, in order
 * @returns {{ items: {cell: object, sig: string, entry: object|null, changed: boolean}[],
 *             removed: object[] }}
 *   `entry` is the old entry to reuse for that position (null: create one);
 *   `changed` says its content must be re-rendered.
 *
 * Matching, in order of preference:
 *  1. same nbformat id (the cell is the same cell, edited or not)
 *  2. identical content (id-less cells that merely moved)
 *  3. leftovers paired in order, to be re-rendered in place
 * Only what is left after that is created or removed.
 */
export function planReconcile(oldEntries, newCells) {
  const sigs = newCells.map(cellSignature)
  const matched = new Array(newCells.length).fill(null)
  const used = new Set()

  const byId = new Map()
  oldEntries.forEach((entry, i) => {
    const id = entry.cell.id
    if (id && !byId.has(id)) byId.set(id, i)
  })
  newCells.forEach((cell, n) => {
    if (!cell.id || !byId.has(cell.id)) return
    const i = byId.get(cell.id)
    if (used.has(i)) return
    used.add(i)
    matched[n] = oldEntries[i]
  })

  const bySig = new Map()
  oldEntries.forEach((entry, i) => {
    if (used.has(i)) return
    if (!bySig.has(entry.sig)) bySig.set(entry.sig, [])
    bySig.get(entry.sig).push(i)
  })
  newCells.forEach((cell, n) => {
    if (matched[n]) return
    const candidates = bySig.get(sigs[n])
    if (!candidates || candidates.length === 0) return
    const i = candidates.shift()
    used.add(i)
    matched[n] = oldEntries[i]
  })

  const leftoverOld = oldEntries.filter((_, i) => !used.has(i))
  newCells.forEach((cell, n) => {
    if (matched[n] || leftoverOld.length === 0) return
    matched[n] = leftoverOld.shift()
  })

  return {
    items: newCells.map((cell, n) => ({
      cell,
      sig: sigs[n],
      entry: matched[n],
      changed: matched[n] === null || matched[n].sig !== sigs[n],
    })),
    removed: leftoverOld,
  }
}
