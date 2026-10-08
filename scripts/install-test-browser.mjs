import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const pnpm = process.env.npm_execpath
assert.ok(pnpm, 'Use pnpm run test:ui:browser:install')
const result = spawnSync(process.execPath, [pnpm, 'exec', 'playwright', 'install', 'chromium', '--only-shell'], {
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: fileURLToPath(new URL('../.tmp/playwright-browsers/', import.meta.url)) },
  stdio: 'inherit', windowsHide: true,
})
assert.equal(result.status, 0, result.error?.message)
