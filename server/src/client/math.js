let mathRendererPromise

/**
 * KaTeX accounts for most of the frontend bundle but most notebook cells do
 * not contain math. Keep it in a separate browser module and only fetch/parse
 * it after a cell actually contains a supported delimiter.
 */
function loadMathRenderer() {
  if (!mathRendererPromise) {
    const stylesheet = document.createElement("link")
    stylesheet.rel = "stylesheet"
    stylesheet.href = "/katex.min.css"
    document.head.appendChild(stylesheet)
    mathRendererPromise = import("./math-renderer.js").then((module) => module.renderMathInElement)
  }
  return mathRendererPromise
}

/**
 * Runs after marked.js has already turned markdown into HTML, so KaTeX
 * only ever sees plain text/HTML, never raw markdown syntax - matches how
 * Jupyter's own markdown-it + katex renderer is ordered.
 */
export function renderMath(container) {
  const text = container.textContent || ""
  if (!text.includes("$") && !text.includes("\\(") && !text.includes("\\[")) return

  loadMathRenderer()
    .then((renderMathInElement) => {
      // A rapid live-sync may have replaced this cell while the lazy module
      // was loading. Rendering a detached old node only wastes work.
      if (!container.isConnected) return
      renderMathInElement(container, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "$", right: "$", display: false },
          { left: "\\(", right: "\\)", display: false },
          { left: "\\[", right: "\\]", display: true },
        ],
        throwOnError: false,
      })
    })
    .catch((error) => console.error("[ipynb-peek] LaTeX rendering failed:", error))
}
