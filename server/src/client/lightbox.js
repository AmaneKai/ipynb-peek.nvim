/** Pan/zoom math for the image lightbox. Pure so it can be unit-tested. */

export const MIN_SCALE = 0.1
export const MAX_SCALE = 16

export function clampScale(scale) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

/**
 * Zooms by `factor` keeping the image point under (px, py) fixed. Coordinates
 * are relative to the stage centre, which is the image's transform origin.
 */
export function zoomAbout(transform, factor, px = 0, py = 0) {
  const scale = clampScale(transform.scale * factor)
  const ratio = scale / transform.scale
  return {
    scale,
    x: px - (px - transform.x) * ratio,
    y: py - (py - transform.y) * ratio,
  }
}

/** Scale that fits the whole image inside the stage (never above 100%). */
export function fitScale(image, stage) {
  if (!image.width || !image.height) return 1
  return clampScale(Math.min(1, stage.width / image.width, stage.height / image.height))
}

export const IDENTITY = { scale: 1, x: 0, y: 0 }

export function createLightbox(root) {
  const stage = root.querySelector("#lightbox-stage")
  const img = root.querySelector("#lightbox-img")
  const download = root.querySelector("#lb-download")
  let transform = IDENTITY
  let drag = null

  function apply() {
    img.style.transform = `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`
  }

  function fit() {
    const rect = stage.getBoundingClientRect()
    transform = {
      scale: fitScale(
        { width: img.naturalWidth, height: img.naturalHeight },
        { width: rect.width * 0.92, height: rect.height * 0.92 },
      ),
      x: 0,
      y: 0,
    }
    apply()
  }

  function zoom(factor, clientX, clientY) {
    const rect = stage.getBoundingClientRect()
    const px = clientX == null ? 0 : clientX - (rect.left + rect.width / 2)
    const py = clientY == null ? 0 : clientY - (rect.top + rect.height / 2)
    transform = zoomAbout(transform, factor, px, py)
    apply()
  }

  function close() {
    root.classList.remove("open")
    drag = null
  }

  stage.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault()
      zoom(event.deltaY < 0 ? 1.15 : 1 / 1.15, event.clientX, event.clientY)
    },
    { passive: false },
  )
  img.addEventListener("pointerdown", (event) => {
    drag = { x: event.clientX - transform.x, y: event.clientY - transform.y, moved: false }
    img.setPointerCapture(event.pointerId)
  })
  img.addEventListener("pointermove", (event) => {
    if (!drag) return
    drag.moved = true
    transform = { ...transform, x: event.clientX - drag.x, y: event.clientY - drag.y }
    apply()
  })
  img.addEventListener("pointerup", () => {
    drag = null
  })
  img.addEventListener("dblclick", () => {
    if (transform.scale === 1) fit()
    else {
      transform = IDENTITY
      apply()
    }
  })
  // A click on the empty backdrop closes; clicks on the image never do.
  stage.addEventListener("click", (event) => {
    if (event.target === stage) close()
  })

  root.querySelector("#lb-zoom-in").addEventListener("click", () => zoom(1.4))
  root.querySelector("#lb-zoom-out").addEventListener("click", () => zoom(1 / 1.4))
  root.querySelector("#lb-reset").addEventListener("click", () => {
    transform = IDENTITY
    apply()
  })
  root.querySelector("#lb-fit").addEventListener("click", fit)
  root.querySelector("#lb-close").addEventListener("click", close)
  document.addEventListener("keydown", (event) => {
    if (!root.classList.contains("open")) return
    if (event.key === "Escape") close()
    else if (event.key === "+" || event.key === "=") zoom(1.4)
    else if (event.key === "-") zoom(1 / 1.4)
    else if (event.key === "0") {
      transform = IDENTITY
      apply()
    }
  })

  return {
    open(src) {
      img.src = src
      const extension = src.startsWith("data:image/svg") ? "svg" : "png"
      download.href = src
      download.download = `plot.${extension}`
      root.classList.add("open")
      transform = IDENTITY
      apply()
      // Large plots start fitted to the window rather than cropped.
      if (img.complete) fit()
      else img.addEventListener("load", fit, { once: true })
    },
    close,
  }
}
