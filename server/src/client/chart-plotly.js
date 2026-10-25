import Plotly from "plotly.js-strict-dist-min"

/** Renders a Plotly figure bundle into `container`; resolves to a static-image exporter. */
export async function renderPlotly(container, spec) {
  await Plotly.newPlot(container, spec.data || [], spec.layout || {}, {
    responsive: true,
    displaylogo: false,
    ...(spec.config || {}),
  })
  return () => Plotly.toImage(container, { format: "png", scale: 2 })
}
