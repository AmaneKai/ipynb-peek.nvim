import { spawnSync } from "node:child_process"

const result = spawnSync(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", "run", "src/kernel.e2e.test.ts"],
  {
    stdio: "inherit",
    env: { ...process.env, IPYNB_PEEK_E2E: "1" },
  },
)

process.exit(result.status ?? 1)
