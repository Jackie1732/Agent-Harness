/** Hidden local credential prompts supply only this invocation's environment. */
import { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { HostConfig } from '../host/config-types.js'
import { DraftInput } from './input.js'
import { plainText } from './text.js'

/**
 * Find credential references in an already decoded local Host candidate.
 * @param config Decoded local Host configuration containing references, never secret values.
 * @returns Unique explicitly named model environment references.
 */
export function modelCredentialReferences(config: HostConfig): readonly string[] {
  const models = [...config.members.flatMap(member => member.kind === 'local' && member.enabled ? [member.model] : []),
    ...(config.schemaVersion !== 1 && config.subagents.kind === 'enabled' ? config.subagents.templates.map(template => template.model) : [])]
  return [...new Set(models.flatMap(model => model.kind === 'scripted-fixed' ? [] : [model.credentialRef]))]
}

/**
 * Ask only for absent local model credentials; cancellation prevents Host acquisition.
 * @param props Missing references and invocation-local completion/cancellation callbacks.
 * @returns Hidden fields with no credential-derived diagnostic or ordinary output.
 */
export function CredentialsPrompt(props: { readonly references: readonly string[]; readonly onReady: (values: Readonly<Record<string, string>>) => void;
  readonly onCancel: () => void; readonly onInterrupt: () => void }) {
  const [index, setIndex] = useState(0), [values, setValues] = useState<Readonly<Record<string, string>>>({})
  const reference = props.references[index]!
  useInput((input, key) => { if (key.ctrl && input === 'c') props.onInterrupt() })
  return <Box flexDirection="column"><Text>local 启动缺少环境凭据 · {index + 1}/{props.references.length}</Text>
    <Text dimColor>输入仅用于此次Host；profile/journal只保存credentialRef</Text>
    <DraftInput key={reference} label={plainText(reference)} secret onCancel={props.onCancel} onConfirm={value => {
      if (value.length === 0) return
      const next = { ...values, [reference]: value }
      if (index + 1 === props.references.length) props.onReady(next)
      else { setValues(next); setIndex(current => current + 1) }
    }} /></Box>
}
