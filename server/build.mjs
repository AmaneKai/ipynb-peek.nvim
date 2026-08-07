/**
 * Maintainer-only build step - end users never run this. Bundles index.ts
 * (and everything it imports) into a single dist/index.js, and copies
 * kernel-bridge.mjs/wire-protocol.mjs (already plain Node ESM, no TS to
 * strip) plus the static client assets alongside it.
 *
 * `ws` is marked external rather than bundled: it's internally CommonJS,
 * and esbuild's ESM output can't inline its dynamic `require()` calls
 * (bundling it produces a "Dynamic require of ... is not supported" crash
 * at runtime, confirmed directly). This means `ws` has to actually be
 * resolvable via node_modules at runtime - it's a real `dependency`, not a
 * bundled-away devDependency - same as zeromq (which only kernel-bridge.mjs
 * imports, and that file isn't bundled at all).
 *
 * dist/ is committed to the repo, not gitignored - rerun this and commit
 * the result whenever server/src changes. CI checks this hasn't drifted.
 */
import * as esbuild from "esbuild"
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"

rmSync("dist", { recursive: true, force: true })
mkdirSync("dist", { recursive: true })

await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "dist/index.js",
  external: ["ws"],
})

await esbuild.build({
  entryPoints: ["src/client.js"],
  bundle: true,
  platform: "browser",
  format: "esm",
  minify: true,
  outfile: "dist/client.js",
})

for (const file of ["kernel-bridge.mjs", "wire-protocol.mjs", "index.html", "style.css"]) {
  cpSync(`src/${file}`, `dist/${file}`)
}

// Every browser this local preview targets supports woff2, and each
// @font-face below lists it first - the woff/ttf fallbacks katex ships
// never get requested. Drop them rather than committing ~750KB of dead
// weight to the repo (and again on every katex version bump).
const katexCss = readFileSync("node_modules/katex/dist/katex.min.css", "utf8").replace(
  /,url\([^)]*\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g,
  "",
)
writeFileSync("dist/katex.min.css", katexCss)

mkdirSync("dist/fonts", { recursive: true })
for (const file of readdirSync("node_modules/katex/dist/fonts")) {
  if (file.endsWith(".woff2")) cpSync(`node_modules/katex/dist/fonts/${file}`, `dist/fonts/${file}`)
}

const bundledLicenses = [
  ["ansi_up", "ansi_up", "LICENSE", ""],
  ["highlight.js", "highlight.js", "LICENSE", ""],
  ["KaTeX", "katex", "LICENSE", " (including its distributed fonts)"],
  ["marked", "marked", "LICENSE.md", ""],
]
const notices = bundledLicenses
  .map(([label, packageName, licenseFile, suffix]) => {
    const packageDir = `node_modules/${packageName}`
    const { version } = JSON.parse(readFileSync(`${packageDir}/package.json`, "utf8"))
    const heading = `${label} ${version}${suffix}`
    return `${"=".repeat(72)}\n${heading}\n${"=".repeat(72)}\n\n${readFileSync(`${packageDir}/${licenseFile}`, "utf8").trim()}\n`
  })
  .join("\n")
writeFileSync("dist/THIRD_PARTY_NOTICES.txt", notices)
