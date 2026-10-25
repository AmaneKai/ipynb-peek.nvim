import hljs from "highlight.js/lib/core"

/**
 * Builds a standalone HTML report from the rendered page: inlined theme and
 * styles, images and charts baked in as data URIs, no scripts, no controls.
 * `noCode` strips code inputs for a prose-and-results ("executive") report.
 */

async function fetchText(path) {
  const response = await fetch(path)
  if (!response.ok) throw new Error(`${path}: ${response.status}`)
  return response.text()
}

async function toDataUri(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: ${response.status}`)
  const blob = await response.blob()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/** KaTeX's stylesheet points at font files; inline them so the report is self-contained. */
async function inlineKatexCss() {
  let css = await fetchText("/katex.min.css")
  const urls = [...new Set([...css.matchAll(/url\((fonts\/[^)]+\.woff2)\)/g)].map((m) => m[1]))]
  for (const url of urls) {
    try {
      css = css.split(`url(${url})`).join(`url(${await toDataUri("/" + url)})`)
    } catch {
      // A missing font only degrades math glyphs; keep exporting.
    }
  }
  return css
}

export async function buildExportHtml({ noCode }) {
  const live = document.getElementById("notebook")
  const clone = live.cloneNode(true)

  // Live charts and tables know how to produce a static form of themselves.
  const liveCharts = [...live.querySelectorAll(".chart-output")]
  const cloneCharts = [...clone.querySelectorAll(".chart-output")]
  for (let i = 0; i < cloneCharts.length; i++) {
    try {
      const src = await liveCharts[i].__exportImage?.()
      if (src) {
        const img = document.createElement("img")
        img.src = src
        cloneCharts[i].replaceWith(img)
      }
    } catch (error) {
      console.error("[ipynb-peek] chart export failed:", error)
    }
  }
  const liveFrames = [...live.querySelectorAll(".df-wrap")]
  const cloneFrames = [...clone.querySelectorAll(".df-wrap")]
  cloneFrames.forEach((wrap, i) => {
    const full = liveFrames[i]?.__exportTable?.()
    if (full) wrap.replaceWith(full)
  })

  for (const selector of [
    ".add-cell-bar",
    ".delete-cell-btn",
    ".fold-btn",
    ".interrupt-btn",
    ".cell-number",
  ])
    for (const node of clone.querySelectorAll(selector)) node.remove()
  if (noCode)
    for (const node of clone.querySelectorAll(".code-box, .input-hidden-bar")) node.remove()
  for (const node of clone.querySelectorAll(".cell.code-cell")) {
    if (!node.querySelector(".outputs") && noCode) node.remove()
  }

  // Cells the highlighter never reached (scrolled past or off-screen) still get colored.
  for (const code of clone.querySelectorAll("code[class*='language-']:not(.hljs)")) {
    try {
      hljs.highlightElement(code)
    } catch {}
  }

  // Images served from the notebook's directory need the page's token to load.
  for (const img of clone.querySelectorAll("img[src^='/notebook-asset']")) {
    try {
      img.src = await toDataUri(img.getAttribute("src"))
    } catch {}
  }

  const css = [await fetchText("/theme.css"), await fetchText("/style.css")]
  if (clone.querySelector(".katex")) css.push(await inlineKatexCss())
  const theme = document.documentElement.dataset.theme
  const title = document.title.replace(/^ipynb-peek:\d+$/, "Notebook report")

  return `<!doctype html>
<html${theme ? ` data-theme="${theme}"` : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${css.join("\n")}
body{padding-top:0}#notebook-pane{margin-left:0}</style>
</head>
<body class="${noCode ? "presentation-mode" : ""}">
<main id="notebook-pane">${clone.outerHTML}</main>
</body>
</html>
`
}
