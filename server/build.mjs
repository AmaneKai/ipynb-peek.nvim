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
import { cpSync, mkdirSync } from "node:fs"

mkdirSync("dist", { recursive: true })

await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "dist/index.js",
  external: ["ws"],
})

for (const file of [
  "kernel-bridge.mjs",
  "wire-protocol.mjs",
  "index.html",
  "style.css",
  "client.js",
]) {
  cpSync(`src/${file}`, `dist/${file}`)
}
