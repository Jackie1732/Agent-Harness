/** Task composition chooses submit-only or one finite drive and keeps exact user-wait identity. */
import { useState } from 'react'
import { Box, Text } from 'ink'
import type { AgentActionReference } from '../agent/contract.js'
import { DraftInput } from './input.js'
import { plainText } from './text.js'
import { ResultPanel } from './panels.js'

/**
 * Compose a task or an answer; Enter and paste never dispatch.
 * @param props Exact selected member/wait and explicit confirmation callbacks.
 * @returns A multiline field with a visible submit policy.
 */
export function TaskComposer(props: { readonly agentKey: string; readonly wait?: AgentActionReference; readonly question?: string;
  readonly secrets?: readonly string[]; readonly onSubmit: (text: string, drive: boolean) => void; readonly onCancel: () => void }) {
  const [drive, setDrive] = useState(false)
  return <Box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={8}><Box flexShrink={0}><Text bold wrap="truncate">{props.wait === undefined ? '新任务' : '回答 user wait'} · {plainText(props.agentKey)}</Text></Box>
    {props.wait !== undefined && <Box flexDirection="column" height={5} flexShrink={0}><ResultPanel label="精确 user wait"
      text={`${props.wait.eventId}:${props.wait.index}\n${props.question ?? ''}`} maxTextBytes={65536} secrets={props.secrets ?? []} /></Box>}
    <Box flexShrink={0}><Text color="cyan" wrap="truncate">{drive ? '提交并运行一批' : '仅提交'} · Tab 切换</Text></Box>
    <DraftInput label="多行文本" multiline secrets={props.secrets ?? []} onTab={() => setDrive(value => !value)} onConfirm={text => props.onSubmit(text, drive)} onCancel={props.onCancel} />
  </Box>
}
