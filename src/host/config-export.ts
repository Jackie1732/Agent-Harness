import { createHash } from 'node:crypto'
import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import type { JsonValue } from '../foundation/json.js'
import { snapshotJson } from '../foundation/json.js'
import type { ResolvedHostSpec } from './config.js'

/** Export deployment comparisons with paths removed; the result is not an executable configuration. */
export function exportHostConfig(spec: ResolvedHostSpec) {
  const data = snapshotJson({ ...spec, storage: { ...spec.storage, root: '<storage-root>' },
    members: spec.members.map(member => member.kind !== 'local' || member.tools.kind === 'none' ? member : { ...member,
      tools: { ...member.tools, rootPath: '<tool-root>', protectedRoots: member.tools.protectedRoots.map(() => '<protected-root>') } }),
    https: spec.https.kind === 'disabled' ? spec.https : { ...spec.https,
      caFile: '<ca-file>', serverCertFile: '<server-cert>', serverKeyFile: '<server-key>', clientCertFile: '<client-cert>', clientKeyFile: '<client-key>' },
  } as unknown as JsonValue)
  return Object.freeze({ redacted: true, config: data, fingerprint: createHash('sha256').update(canonicalJsonBytes(data)).digest('hex') })
}
