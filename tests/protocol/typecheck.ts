import type { Params, Result } from '../../src/protocol/index.js'
import { eventId, messageId } from './fixtures.js'

const send: Params<'message.send'> = { agentKey: 'writer', peerKey: 'reviewer', type: 'test/note', payloadVersion: 1, payloadJson: '{}' }
const answer: Params<'input.answer'> = { agentKey: 'writer', submissionKey: 'answer-1', wait: { eventId, index: 0 }, text: 'answer' }
// @ts-expect-error reply identity cannot replace a send destination
const wrongSend: Params<'message.send'> = { agentKey: 'writer', messageId, type: 'test/note', payloadVersion: 1, payloadJson: '{}' }
// @ts-expect-error Inbox waits use disposed, not terminal
const wrongWait: Params<'message.wait'> = { agentKey: 'writer', messageId, direction: 'inbox', until: 'terminal', timeoutMs: 100 }
// @ts-expect-error durable lookup chooses exactly one key
const bothKeys: Params<'input.get'> = { agentKey: 'writer', inputEventId: eventId, submissionKey: 'key' }
// @ts-expect-error callers cannot supply their own namespace or origin
const spoofed: Params<'input.submit'> = { agentKey: 'writer', submissionKey: 'key', text: 'task', namespace: 'api:other' }
function output(result: Result<'workflow.output'>): unknown { return result.status === 'available' ? result.value : undefined }
void [send, answer, wrongSend, wrongWait, bothKeys, spoofed, output]
