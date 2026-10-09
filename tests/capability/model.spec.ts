import { describe, expect, it } from 'vitest'
import { CapabilityRegistry, createCapabilityKey } from '../../src/index.js'
import { evaluate } from '../../src/capability/evaluate.js'
import type { ComponentDeclaration } from '../../src/capability/evaluate.js'
import type { CapabilityKey, ComponentId, ProviderInstance } from '../../src/capability/types.js'

function permutations(values: readonly number[]): readonly (readonly number[])[] {
  return values.length === 0 ? [[]] : values.flatMap(value =>
    permutations(values.filter(entry => entry !== value)).map(tail => [value, ...tail]))
}

describe('capability evaluation model', () => {
  it('matches the classification table for every status, release intent and two-key resolution', () => {
    const keys = [createCapabilityKey<string>('classification.a'), createCapabilityKey<string>('classification.b')]
    const statuses = ['unsatisfied', 'activating', 'active', 'deactivating', 'failed', 'disposed'] as const
    for (const status of statuses) {
      for (const releasing of [false, true]) {
        for (let count = 0; count <= keys.length; count += 1) {
          for (let combination = 0; combination < 3 ** count; combination += 1) {
            const required = keys.slice(0, count)
            const previous = required.map((key, index): ProviderInstance => ({
              id: `previous-${index}` as ProviderInstance['id'],
              component: `p${index}` as ComponentId,
              bindings: [{ key, value: 'same' }],
            }))
            const active = new Map<CapabilityKey<unknown>, ProviderInstance>()
            let missing = false
            let replaced = false
            required.forEach((key, index) => {
              const choice = Math.floor(combination / (3 ** index)) % 3
              missing ||= choice === 0
              replaced ||= choice === 2
              if (choice > 0) {
                active.set(key, choice === 1 ? previous[index]! : {
                  ...previous[index]!,
                  id: `next-${index}` as ProviderInstance['id'],
                })
              }
            })
            const declaration: ComponentDeclaration = {
              id: 'consumer' as ComponentId,
              label: 'consumer',
              ordinal: 0,
              requires: required,
              provides: [],
              releasing,
              status,
              committed: new Map(required.map((key, index) => [key, previous[index]!])),
            }
            const change = evaluate({ declarations: [declaration], activeBindings: active }).changes[0]!
            let expected = 'neutral'
            if (status === 'unsatisfied') {
              expected = releasing ? 'deactivating' : missing ? 'neutral' : 'activating'
            } else if (status === 'activating' || status === 'active') {
              expected = releasing || missing || replaced ? 'deactivating' : 'neutral'
            }
            expect(change.classification).toBe(expected)
            expect(change.target === undefined).toBe(missing || releasing)
            if (change.target !== undefined) {
              expect(change.target.size).toBe(count)
              for (const key of required) expect(change.target.get(key)).toBe(active.get(key))
            }
          }
        }
      }
    }
  })

  it('uses stable reverse topology for every four-node DAG and mount permutation', () => {
    const nodes = [0, 1, 2, 3]
    const keys = nodes.map(index => createCapabilityKey<string>(`topology.${index}`))
    const pairs = nodes.flatMap(from => nodes.map(to => [from, to] as const))
      .filter(([from, to]) => from > to)
    const providers = keys.map((key, index): ProviderInstance => ({
      id: `p${index}` as ProviderInstance['id'],
      component: `c${index}` as ComponentId,
      bindings: [{ key, value: 'same' }],
    }))
    const bindings = new Map(keys.map((key, index) => [key, providers[index]!]))

    for (let mask = 0; mask < 2 ** pairs.length; mask += 1) {
      const edges = pairs.filter((_, index) => (mask & (1 << index)) !== 0)
      for (const order of permutations(nodes)) {
        const declarations: ComponentDeclaration[] = nodes.map(index => ({
          id: `c${index}` as ComponentId,
          label: 'same-label',
          ordinal: order.indexOf(index),
          requires: edges.filter(([from]) => from === index).map(([, to]) => keys[to]!),
          provides: [keys[index]!],
          releasing: true,
          status: 'active',
          committed: new Map(edges.filter(([from]) => from === index)
            .map(([, to]) => [keys[to]!, providers[to]!])),
        }))
        const remaining = new Set(nodes)
        const expected: ComponentId[] = []
        while (remaining.size > 0) {
          const next = order.find(node => remaining.has(node)
            && edges.filter(([from]) => from === node).every(([, provider]) => !remaining.has(provider)))!
          remaining.delete(next)
          expected.push(`c${next}` as ComponentId)
        }
        const result = evaluate({ declarations, activeBindings: bindings })
        expect(result.deactivationOrder).toEqual(expected.reverse())
        expect(result.cycles).toEqual([])
      }
    }
  })

  it('starts a consumer-first branching graph in stable order and stops it in reverse', async () => {
    const registry = new CapabilityRegistry()
    const root = createCapabilityKey<string>('branch.root')
    const left = createCapabilityKey<string>('branch.left')
    const right = createCapabilityKey<string>('branch.right')
    const started: string[] = []
    const stopped: string[] = []
    const definitions = [
      { label: 'leaf', requires: [left, right], provides: [] },
      { label: 'left', requires: [root], provides: [left] },
      { label: 'right', requires: [root], provides: [right] },
      { label: 'root', requires: [], provides: [root] },
      { label: 'unrelated', requires: [], provides: [] },
    ]
    for (const definition of definitions) {
      registry.mount({
        ...definition,
        setup: async context => {
          for (const key of definition.requires) expect(context.require(key)).toBe('same')
          started.push(definition.label)
          for (const key of definition.provides) context.provide(key, 'same')
          await context.apply('lease', () => undefined, () => { stopped.push(definition.label) })
        },
      })
    }

    await registry.whenQuiescent()
    expect(started).toEqual(['root', 'left', 'right', 'leaf', 'unrelated'])
    await registry.dispose()
    expect(stopped).toEqual([...started].reverse())
    expect(registry.status).toBe('disposed')
  })
})
