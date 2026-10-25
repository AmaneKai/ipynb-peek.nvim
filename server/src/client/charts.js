/**
 * Interactive chart outputs. The Plotly and Vega runtimes are large, so each
 * is its own lazily-fetched browser module (built as a separate bundle, like
 * the KaTeX renderer) and is only requested once a cell actually outputs one.
 */

/** @returns {HTMLElement} a container that fills in once its renderer has loaded */
export function renderChart(out) {
  const container = document.createElement("div")
  container.className = "chart-output"

  const loading = import(out.kind === "plotly" ? "./chart-plotly.js" : "./chart-vega.js")
    .then((module) =>
      out.kind === "plotly"
        ? module.renderPlotly(container, out.spec)
        : module.renderVega(container, out.spec, out.lite),
    )
    .catch((error) => {
      console.error("[ipynb-peek] chart rendering failed:", error)
      const note = document.createElement("div")
      note.className = "chart-error"
      note.textContent = "Could not render this chart: " + (error?.message || error)
      container.replaceChildren(note)
      return null
    })

  // Used by the HTML export to bake the live chart into a static image.
  container.__exportImage = async () => {
    const toImage = await loading
    return toImage ? toImage() : null
  }
  return container
}
