import vegaEmbed from "vega-embed"
import { expressionInterpreter } from "vega-interpreter"

/**
 * Renders a Vega / Vega-Lite spec. The interpreter replaces vega's default
 * `new Function` expression compiler, which the page's CSP forbids.
 */
export async function renderVega(container, spec, lite) {
  const result = await vegaEmbed(container, spec, {
    mode: lite ? "vega-lite" : "vega",
    ast: true,
    expr: expressionInterpreter,
    renderer: "canvas",
    actions: { export: true, source: false, compiled: false, editor: false },
  })
  return () => result.view.toImageURL("png", 2)
}
