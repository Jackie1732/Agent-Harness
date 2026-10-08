import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { connect } from 'node:net'
import { expect, it } from 'vitest'
import { runUiCli } from '../../src/ui/cli.js'
import { uiConfig } from './fixtures.js'

it('requires an explicit password and releases the listener if the ready output fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atomic-ui-cli-')), config = uiConfig(1234), path = join(directory, 'ui.json')
  const previous = process.env[config.passwordEnv]
  try {
    await writeFile(path, JSON.stringify(config)); delete process.env[config.passwordEnv]
    const io = { stdin: Readable.from([]), stdout: new Writable({ write(_chunk, _encoding, callback) { callback() } }), stderr: new Writable({ write(_chunk, _encoding, callback) { callback() } }) }
    await expect(runUiCli(['--config', path], io)).rejects.toMatchObject({ code: 'HOST_CONFIG_INVALID' })
    process.env[config.passwordEnv] = 'cli-password-not-emitted'
    let port = 0
    io.stdout = new Writable({ write(chunk, _encoding, callback) { const ready = JSON.parse(chunk.toString()) as { url: string }; port = Number(new URL(ready.url).port); expect(chunk.toString()).not.toContain('cli-password'); callback(new Error('Output lost')) } })
    await expect(runUiCli(['--config', path], io)).rejects.toMatchObject({ code: 'HOST_OUTPUT_FAILED' })
    expect(port).toBeGreaterThan(0)
    await new Promise<void>((resolve, reject) => { const socket = connect(port, '127.0.0.1'); socket.once('connect', () => { socket.destroy(); reject(new Error('Listener retained')) }); socket.once('error', error => { if ('code' in error && error.code === 'ECONNREFUSED') resolve(); else reject(error) }) })
  } finally { if (previous === undefined) delete process.env[config.passwordEnv]; else process.env[config.passwordEnv] = previous; await rm(directory, { recursive: true, force: true }) }
})
