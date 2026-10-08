/** Task composition chooses submit-only or one finite drive and keeps exact user-wait identity. */
import { useState } from 'react'
import { Box, Text } from 'ink'
import type { AgentActionReference } from '../agent/contract.js'
import { DraftInput } from './input.js'
import { plainText } from './text.js'

/**
 * Compose a task or an answer; Enter and paste never dispatch.
 * @param props Exact selected member/wait and explicit confirmation callbacks.
 * @returns A multiline field with a visible submit policy.
 */
export function TaskComposer(props: { readonly agentKey: string; readonly wait?: AgentActionReference; readonly question?: string;
  readonly secrets?: readonly string[]; readonly onSubmit: (text: string, drive: boolean) => void; readonly onCancel: () => void }) {
  const [drive, setDrive] = useState(false)
  return <Box flexDirection="column"><Text bold>{props.wait === undefined ? '新任务' : '回答 user wait'} · {plainText(props.agentKey)}</Text>
    {props.wait !== undefined && <Text>{props.wait.eventId}:{props.wait.index} · {plainText(props.question ?? '', props.secrets)}</Text>}
    <Text color="cyan">{drive ? '提交并运行一批' : '仅提交'} · Tab 切换</Text>
    <DraftInput label="多行文本" multiline secrets={props.secrets ?? []} onTab={() => setDrive(value => !value)} onConfirm={text => props.onSubmit(text, drive)} onCancel={props.onCancel} />
  </Box>
}
