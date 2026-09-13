import { createCapabilityKey } from '../capability/key.js'
import type { ComponentContext, ComponentDefinition } from '../capability/types.js'
import type { SessionRepositoryOptions } from './repository.js'
import { SessionRepository } from './repository.js'

/** Capability key under which a Component publishes the active Session Repository. */
export const SessionRepositoryKey = createCapabilityKey<SessionRepository>('core.session.repository')

/** Create the lifecycle adapter that owns and publishes one Session Repository. */
export function createSessionRepositoryComponent(
  options: SessionRepositoryOptions,
): ComponentDefinition {
  const definition: ComponentDefinition = {
    label: 'Session Repository',
    requires: Object.freeze([]),
    provides: Object.freeze([SessionRepositoryKey]),
    setup: async (context: ComponentContext) => {
      const repository = await context.apply(
        'Session Repository',
        () => new SessionRepository(options),
        (active: SessionRepository) => active.dispose(),
      )
      context.provide(SessionRepositoryKey, repository)
    },
  }
  return Object.freeze(definition)
}
