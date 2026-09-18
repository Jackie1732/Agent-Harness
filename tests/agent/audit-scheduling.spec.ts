import { expect, it } from 'vitest'
import { SessionContext, parseChannelId } from '../../src/index.js'
import { agentFixture } from './fixtures.js'
import { auditedAgent } from './audit-fixtures.js'
import { createCommunicationService, messageCatalog, requestMessage, channelIds } from '../communication/fixtures.js'

it('keeps lane FIFO and bounded fairness across object replacement while another lane receives work', async () => {
  const sequences: string[][] = []
  for (const restart of [false, true]) {
    const defaults = await agentFixture(); const limits = { ...defaults.spec.limits, maxTurnsPerRun: 1 }; const budget = { ...defaults.spec.budget, models: 0 }; await defaults.close()
    const f = await agentFixture({ limits, budget, messages: [{ type: 'test/request', payloadVersion: 1, requiresReply: false }] }, undefined, messageCatalog)
    const { service, policy } = createCommunicationService(); const peer = await f.repo.create()
    const local = await service.attach(f.session, { catalog: messageCatalog, policy }); const remote = await service.attach(peer, { catalog: messageCatalog, policy })
    let agent = auditedAgent(f, { mailbox: local, messageCatalog })
    const send = async (channel: number, text: string) => {
      await remote.send(requestMessage, { kind: 'root', recipient: f.session.header.address, channelId: parseChannelId(channelIds[channel]!) }, { text })
      await service.createDispatcher(remote).dispatch()
    }
    try {
      for (let index = 0; index < 3; index++) await agent.submitInput({ kind: 'task', text: 'user-' + index, originLabel: 'audit' })
      await send(0, 'peer-0'); await send(1, 'peer-other')
      for (let index = 0; index < 7; index++) {
        if (restart && index === 2) { await agent.dispose(); agent = auditedAgent(f, { context: new SessionContext({ session: f.session, messageCatalog }), mailbox: local, messageCatalog }) }
        await agent.start()
        if (index < 2) await send(0, 'refill-' + index)
      }
      const state = agent.snapshot()
      sequences.push(state.turns.map(turn => state.inputs.find(input => input.reference.eventId === turn.started.payload.input.eventId)!.input?.text
        ?? requestMessage.decode(state.inputs.find(input => input.reference.eventId === turn.started.payload.input.eventId)!.message!.payload).text))
      expect(sequences.at(-1)?.slice(0, 3)).toEqual(['user-0', 'peer-0', 'peer-other'])
      expect(sequences.at(-1)?.filter(text => text.startsWith('refill'))).toEqual(['refill-0', 'refill-1'])
    } finally { await agent.dispose(); await service.dispose(); await f.close() }
  }
  expect(sequences[0]).toEqual(sequences[1])
})
