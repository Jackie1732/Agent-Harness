import { createRequire } from 'node:module'

interface PackageManifest {
  readonly version?: unknown
}

const require = createRequire(import.meta.url)
const manifest = require('../package.json') as PackageManifest

if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
  throw new TypeError('package.json must contain a non-empty string version')
}

/** Version declared by this package's manifest. */
export const HARNESS_VERSION = manifest.version
