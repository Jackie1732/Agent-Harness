import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildOperatorProfile, resolveOperatorProfile } from '../src/operator/profile.js'
import { decodeHostConfig, resolveHostConfig } from '../src/host/config.js'
import { initializeHost } from '../src/host/initialization.js'
import { hostConfig } from './host/fixtures.js'

/** Create an initialized local Host with its separate operator profile and journal location. */
export async function localFixture(configFactory = hostConfig) {
  const directory = await mkdtemp(join(tmpdir(), 'step15-operator-review-'))
  const config = configFactory(join(directory, 'store'))
  const spec = resolveHostConfig(decodeHostConfig(config, directory))
  await initializeHost(spec)
  const hostPath = join(directory, 'host.json'), profilePath = join(directory, 'operator.json')
  await writeFile(hostPath, JSON.stringify(config))
  const raw = buildOperatorProfile({ kind: 'local', hostConfig: hostPath, shutdownMode: 'drain' })
  await writeFile(profilePath, JSON.stringify(raw))
  return { directory, spec, raw, profilePath, profile: resolveOperatorProfile(raw, profilePath) }
}
