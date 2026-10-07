import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { connect } from 'node:net'
import { expect, it } from 'vitest'
import { runApiCli } from '../../src/api/cli.js'
import { initializeHost } from '../../src/host/initialization.js'
import { decodeHostConfig, resolveHostConfig } from '../../src/host/config.js'
import { hostConfig } from '../host/fixtures.js'
import { apiConfig } from './fixtures.js'

it('closes Host and the bound listener when the sole ready write fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'api-cli-output-'))
  try {
    const raw = hostConfig(join(directory, 'store'))
    await initializeHost(resolveHostConfig(decodeHostConfig(raw, directory)))
    const hostPath = join(directory, 'host.json'), apiPath = join(directory, 'api.json')
    await writeFile(hostPath, JSON.stringify(raw)); await writeFile(apiPath, JSON.stringify(await apiConfig()))
    let port = 0
    const output = new Writable({ write(chunk, _encoding, callback) {
      port = (JSON.parse(chunk.toString()) as { listen: { port: number } }).listen.port
      callback(new Error('output unavailable'))
    } })
    await expect(runApiCli(['--config', hostPath, '--api-config', apiPath], { stdin: Readable.from([]), stdout: output, stderr: new Writable({ write(_chunk, _encoding, callback) { callback() } }) })).rejects.toMatchObject({ code: 'HOST_OUTPUT_FAILED' })
    expect(port).toBeGreaterThan(0)
    expect(await readFile(join(directory, 'store', '.atomic-harness.lock'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })).toBeNull()
    await new Promise<void>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1')
      socket.once('connect', () => { socket.destroy(); reject(new Error('Failed startup retained its listener')) })
      socket.once('error', error => { if ('code' in error && error.code === 'ECONNREFUSED') resolve(); else reject(error) })
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
