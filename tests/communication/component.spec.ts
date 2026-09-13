import { describe, expect, it } from 'vitest'
import {
  CapabilityRegistry,
  CommunicationServiceKey,
  MemorySessionBackend,
  SessionRepositoryKey,
  communicationSessionEventDefinitions,
  createCommunicationServiceComponent,
  createDurableEventCatalog,
  createInProcessMessageTransportComponent,
  createSessionDirectoryComponent,
  createSessionRepositoryComponent,
} from '../../src/index.js'
import type { CommunicationService } from '../../src/index.js'
import { limits } from './fixtures.js'
import { messageCatalog } from './fixtures.js'

describe('communication Components', () => {
  it('publishes the Service only while Directory and Transport dependencies are active', async () => {
    const registry = new CapabilityRegistry()
    const directory = registry.mount(createSessionDirectoryComponent())
    const transport = registry.mount(createInProcessMessageTransportComponent())
    const communication = registry.mount(createCommunicationServiceComponent({ limits }))
    let service: CommunicationService | undefined
    const consumer = registry.mount({
      label: 'communication consumer',
      requires: [CommunicationServiceKey],
      provides: [],
      setup: context => { service = context.require(CommunicationServiceKey) },
    })
    await registry.whenQuiescent()

    expect(directory.status).toBe('active')
    expect(transport.status).toBe('active')
    expect(communication.status).toBe('active')
    expect(consumer.status).toBe('active')
    expect(service).toBeDefined()

    await directory.dispose()
    await registry.whenQuiescent()
    expect(transport.status).toBe('unsatisfied')
    expect(communication.status).toBe('unsatisfied')
    expect(consumer.status).toBe('unsatisfied')
    expect(() => service!.createDispatcher({} as never)).toThrowError(
      expect.objectContaining({ code: 'MESSAGE_SERVICE_INACTIVE' }),
    )
    await registry.dispose()
  })

  it('lets a Consumer release its Mailbox before the borrowed Session Handle', async () => {
    const registry = new CapabilityRegistry()
    registry.mount(createSessionRepositoryComponent({
      backend: new MemorySessionBackend({ maxRecordBytes: 8192 }),
      catalog: createDurableEventCatalog(communicationSessionEventDefinitions),
      maxLineageDepth: 2,
    }))
    registry.mount(createSessionDirectoryComponent())
    registry.mount(createInProcessMessageTransportComponent())
    registry.mount(createCommunicationServiceComponent({ limits }))
    const released: string[] = []
    registry.mount({
      label: 'Session communication owner',
      requires: [SessionRepositoryKey, CommunicationServiceKey],
      provides: [],
      setup: async context => {
        const repository = context.require(SessionRepositoryKey)
        const service = context.require(CommunicationServiceKey)
        const handle = await context.apply('Session Handle', () => repository.create(), async active => {
          released.push('handle')
          await active.dispose()
        })
        await context.apply('Session Mailbox', () => service.attach(handle, {
          catalog: messageCatalog,
          policy: { canSend: () => ({ kind: 'allow' }), canReceive: () => ({ kind: 'allow' }) },
        }), async active => {
          released.push('mailbox')
          await active.dispose()
        })
      },
    })
    await registry.whenQuiescent()

    await registry.dispose()
    expect(released).toEqual(['mailbox', 'handle'])
  })
})
