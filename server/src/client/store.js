/**
 * Unidirectional state for the preview page: every change is an action run
 * through `reducer`, and the view only ever reads the resulting state. No
 * module keeps its own copy of cells or reveal toggles.
 *
 * Actions:
 *   NOTEBOOK_RENDERED { cells }          full cell list from the server
 *   CELL_UPDATED      { index, cell }    one cell changed (output, status, ...)
 *   CURSOR_MOVED      { index }          Neovim's cursor entered this cell
 *   INPUT_REQUESTED   { prompt, password }
 *   INPUT_CLEARED
 *   TOGGLE_SOURCE     { key }            reveal/hide a source_hidden cell's input
 *   TOGGLE_OUTPUTS    { key }            reveal/hide an outputs_hidden cell's output
 *   THEME_AVAILABLE   { themes }         preset names the server offers
 *   SET_THEME         { name }           "default" = the server-configured theme
 *   SET_PRESENTATION  { on }             hide code, keep prose/plots/tables
 *   SET_TOC           { open }
 *   SET_TOC_WIDTH     { width }
 *   VARIABLES_LOADED  { variables, error }
 *   SET_VARIABLES_PANEL { open }
 *
 * Toggled-key sets (revealedSource/revealedOutputs) hold cells whose
 * visibility is flipped from what their nbformat metadata says: a
 * source_hidden cell in the set is shown, any other cell in the set is folded.
 */

/**
 * Identity of a cell across renders: its nbformat id when it has one, else
 * its position. Reveal toggles are keyed by this so they survive live-typing
 * updates to other cells.
 */
export function cellKey(cell, index) {
  return cell.id ? "id:" + cell.id : "pos:" + index
}

export function initialState() {
  return {
    cells: [],
    activeIndex: null,
    input: null,
    revealedSource: new Set(),
    revealedOutputs: new Set(),
    themes: [],
    theme: "default",
    presentation: false,
    tocOpen: false,
    tocWidth: 260,
    variables: { open: false, rows: null, error: null },
  }
}

function toggled(set, key) {
  const next = new Set(set)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

export function reducer(state, action) {
  switch (action.type) {
    case "NOTEBOOK_RENDERED":
      return { ...state, cells: action.cells }
    case "CELL_UPDATED": {
      if (!state.cells[action.index]) return state
      const cells = state.cells.slice()
      cells[action.index] = action.cell
      return { ...state, cells }
    }
    case "CURSOR_MOVED":
      return { ...state, activeIndex: action.index }
    case "INPUT_REQUESTED":
      return { ...state, input: { prompt: action.prompt, password: action.password === true } }
    case "INPUT_CLEARED":
      return state.input ? { ...state, input: null } : state
    case "TOGGLE_SOURCE":
      return { ...state, revealedSource: toggled(state.revealedSource, action.key) }
    case "TOGGLE_OUTPUTS":
      return { ...state, revealedOutputs: toggled(state.revealedOutputs, action.key) }
    case "THEME_AVAILABLE":
      return { ...state, themes: action.themes }
    case "SET_THEME":
      return { ...state, theme: action.name || "default" }
    case "SET_PRESENTATION":
      return { ...state, presentation: action.on === true }
    case "SET_TOC":
      return { ...state, tocOpen: action.open === true }
    case "SET_TOC_WIDTH":
      return { ...state, tocWidth: Math.min(600, Math.max(160, Math.round(action.width))) }
    case "VARIABLES_LOADED":
      return {
        ...state,
        variables: {
          ...state.variables,
          rows: action.variables ?? null,
          error: action.error ?? null,
        },
      }
    case "SET_VARIABLES_PANEL":
      return { ...state, variables: { ...state.variables, open: action.open === true } }
    default:
      return state
  }
}

export function createStore(initial = initialState()) {
  let state = initial
  const listeners = new Set()
  return {
    getState: () => state,
    dispatch(action) {
      const previous = state
      state = reducer(state, action)
      for (const listener of listeners) listener(state, previous, action)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
