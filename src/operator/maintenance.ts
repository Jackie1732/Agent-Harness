import { runHostCli } from '../host/cli.js'
import type { HostCliIo } from '../host/cli.js'
import { readOperatorProfile } from './profile.js'
import { readConfigDocument } from './config-check.js'
import { OperatorError } from './errors.js'

/** Profile conveniences preserve original maintenance commands, results and confirmations. */
export async function runProfileMaintenance(args: readonly string[], io: HostCliIo): Promise<number> {
  const index = args.indexOf('--profile'), profilePath = args[index + 1]
  if (index < 0 || profilePath === undefined || args.includes('--config') || args.includes('--protocol-version')
    || args.filter(arg => arg === '--profile').length !== 1) throw new OperatorError('OPERATOR_USAGE_PROFILE_MAINTENANCE', 2)
  const { profile } = await readOperatorProfile(profilePath)
  if (profile.connection.kind !== 'local') throw new OperatorError('OPERATOR_USAGE_LOCAL_MAINTENANCE', 2)
  const document = await readConfigDocument(profilePath, 'host')
  const normalized = [...args]; normalized.splice(index, 2)
  return runHostCli([...normalized, '--config', profile.connection.hostConfig, '--protocol-version', String(document.check.protocolVersion)], io)
}
