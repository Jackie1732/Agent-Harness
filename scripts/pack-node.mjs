import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Pack only the built runtime and manifest; local workspace Markdown never enters an asset. */
export async function packNode(root, output, pnpm) {
  const staging = await mkdtemp(join(tmpdir(), 'atomic-node-package-'))
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  delete manifest.scripts
  delete manifest.devDependencies
  delete manifest.packageManager
  await writeFile(join(staging, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  await cp(join(root, 'dist'), join(staging, 'dist'), { recursive: true })
  const packed = spawnSync(process.execPath, [pnpm, 'pack', '--out', output], {
    cwd: staging, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024,
  })
  assert.equal(packed.status, 0, `${packed.error?.message ?? ''}\n${packed.stderr}\n${packed.stdout}`)
}
