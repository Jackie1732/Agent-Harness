import { describe, expect, it } from 'vitest'
import { createCapabilityKey } from '../../src/index.js'
import type {
  CapabilityKey,
  ComponentDeclaration,
  ComponentChange,
  ComponentId,
  ComponentStatus,
  EvaluationResult,
  ProviderInstance,
} from '../../src/index.js'
import { detectCycles, evaluate } from '../../src/capability/evaluate.js'

let keyCounter = 0
function key<T>(name?: string): CapabilityKey<T> {
  keyCounter += 1
  return createCapabilityKey<T>(name ?? `test.key.${keyCounter}`)
}

function id(name: string): ComponentId {
  return name as ComponentId
}

function instance(name: string, component: string, keys: readonly CapabilityKey<unknown>[]): ProviderInstance {
  return {
    id: name as ProviderInstance['id'],
    component: id(component),
    bindings: keys.map(binding => ({ key: binding, value: binding.name })),
  }
}

function declaration(options: {
  readonly id: string
  readonly ordinal: number
  readonly requires?: readonly CapabilityKey<unknown>[]
  readonly provides?: readonly CapabilityKey<unknown>[]
  readonly status?: ComponentStatus
  readonly releasing?: boolean
  readonly committed?: ReadonlyMap<CapabilityKey<unknown>, ProviderInstance>
  readonly label?: string
}): ComponentDeclaration {
  return {
    id: id(options.id),
    label: options.label ?? options.id,
    ordinal: options.ordinal,
    requires: options.requires ?? [],
    provides: options.provides ?? [],
    releasing: options.releasing ?? false,
    status: options.status ?? 'unsatisfied',
    committed: options.committed ?? new Map(),
  }
}

function bindings(
  entries: readonly (readonly [CapabilityKey<unknown>, ProviderInstance])[],
): ReadonlyMap<CapabilityKey<unknown>, ProviderInstance> {
  return new Map(entries)
}

describe('cycle detection over the declaration graph', () => {
  it('reports a cycle between two components that never activated', () => {
    const a = key('a')
    const b = key('b')
    const first = declaration({ id: 'A', ordinal: 0, requires: [b], provides: [a] })
    const second = declaration({ id: 'B', ordinal: 1, requires: [a], provides: [b] })

    const cycles = detectCycles([first, second])

    expect(cycles).toHaveLength(1)
    expect([...cycles[0]!.ids].sort()).toEqual(['A', 'B'])
    expect(cycles[0]!.keyNames).toHaveLength(2)
  })

  it('reports a cycle when no component is active', () => {
    // The whole point of reading declarations: neither component has ever published a
    // binding, so a view built from active bindings would see no cycle at all.
    const a = key('a')
    const b = key('b')
    const result = evaluate({
      declarations: [
        declaration({ id: 'A', ordinal: 0, requires: [b], provides: [a] }),
        declaration({ id: 'B', ordinal: 1, requires: [a], provides: [b] }),
      ],
      activeBindings: new Map(),
    })

    expect(result.cycles).toHaveLength(1)
    expect(result.changes.every(change => change.classification === 'neutral')).toBe(true)
    expect(result.activationOrder).toEqual([])
  })

  it('reports a self-cycle', () => {
    const a = key('a')
    const cycles = detectCycles([declaration({ id: 'A', ordinal: 0, requires: [a], provides: [a] })])

    expect(cycles).toHaveLength(1)
    expect(cycles[0]!.ids).toEqual(['A'])
  })

  it('keeps ids as path identity when labels repeat', () => {
    const a = key('a')
    const b = key('b')
    const cycles = detectCycles([
      declaration({ id: 'A', ordinal: 0, label: 'same', requires: [b], provides: [a] }),
      declaration({ id: 'B', ordinal: 1, label: 'same', requires: [a], provides: [b] }),
    ])

    expect(cycles).toHaveLength(1)
    expect(cycles[0]!.ids).toHaveLength(2)
    expect(new Set(cycles[0]!.ids).size).toBe(2)
    expect(cycles[0]!.labels).toEqual(['same', 'same'])
  })

  it('reports a three-component cycle once', () => {
    const a = key('a')
    const b = key('b')
    const c = key('c')
    const cycles = detectCycles([
      declaration({ id: 'A', ordinal: 0, requires: [c], provides: [a] }),
      declaration({ id: 'B', ordinal: 1, requires: [a], provides: [b] }),
      declaration({ id: 'C', ordinal: 2, requires: [b], provides: [c] }),
    ])

    expect(cycles).toHaveLength(1)
    const cycle = cycles[0]!
    expect([...cycle.ids].sort()).toEqual(['A', 'B', 'C'])
    expect(cycle.keyNames).toHaveLength(3)
    // The report is a valid cycle: every step's requirement is published by its successor.
    const requiresOf: Record<string, string> = { A: 'c', B: 'a', C: 'b' }
    const providesOf: Record<string, string> = { A: 'a', B: 'b', C: 'c' }
    cycle.ids.forEach((from, index) => {
      const to = cycle.ids[(index + 1) % cycle.ids.length]!
      expect(cycle.keyNames[index]).toBe(requiresOf[String(from)])
      expect(requiresOf[String(from)]).toBe(providesOf[String(to)])
    })
  })

  it('reports overlapping cycles that share an already visited path', () => {
    const a = key('overlap.a')
    const b = key('overlap.b')
    const c = key('overlap.c')
    const d = key('overlap.d')
    const cycles = detectCycles([
      declaration({ id: 'A', ordinal: 0, requires: [b, c], provides: [a] }),
      declaration({ id: 'B', ordinal: 1, requires: [d], provides: [b] }),
      declaration({ id: 'C', ordinal: 2, requires: [d], provides: [c] }),
      declaration({ id: 'D', ordinal: 3, requires: [a], provides: [d] }),
    ])

    expect(cycles).toHaveLength(2)
    expect(cycles.map(cycle => cycle.ids)).toEqual([
      ['A', 'B', 'D'],
      ['A', 'C', 'D'],
    ])
  })

  it('reports no cycle for an acyclic chain', () => {
    const a = key('a')
    const b = key('b')
    expect(detectCycles([
      declaration({ id: 'A', ordinal: 0, provides: [a] }),
      declaration({ id: 'B', ordinal: 1, requires: [a], provides: [b] }),
      declaration({ id: 'C', ordinal: 2, requires: [b] }),
    ])).toEqual([])
  })
})

describe('component classification', () => {
  it('activates an unsatisfied component once its requirements resolve', () => {
    const a = key('a')
    const provider = instance('p1', 'P', [a])
    const result = evaluate({
      declarations: [
        declaration({ id: 'P', ordinal: 0, provides: [a], status: 'active' }),
        declaration({ id: 'C', ordinal: 1, requires: [a] }),
      ],
      activeBindings: bindings([[a, provider]]),
    })

    expect(changeOf(result, 'C').classification).toBe('activating')
    expect(changeOf(result, 'C').target?.get(a)?.id).toBe('p1')
    expect(changeOf(result, 'P').classification).toBe('neutral')
  })

  it('stays neutral while a requirement is unresolved', () => {
    const a = key('a')
    const result = evaluate({
      declarations: [declaration({ id: 'C', ordinal: 0, requires: [a] })],
      activeBindings: new Map(),
    })

    expect(changeOf(result, 'C').classification).toBe('neutral')
    expect(result.unresolved.get('a')).toEqual(['C'])
  })

  it('deactivates an active component whose provider disappeared', () => {
    const a = key('a')
    const result = evaluate({
      declarations: [
        declaration({
          id: 'C',
          ordinal: 0,
          requires: [a],
          status: 'active',
          committed: bindings([[a, instance('p1', 'P', [a])]]),
        }),
      ],
      activeBindings: new Map(),
    })

    expect(changeOf(result, 'C').classification).toBe('deactivating')
  })

  it('treats an equal value from a different provider instance as a replacement', () => {
    const a = key('a')
    const first = instance('p1', 'P', [a])
    const second = { ...instance('p2', 'P', [a]), bindings: [{ key: a, value: a.name }] }
    const result = evaluate({
      declarations: [
        declaration({
          id: 'C',
          ordinal: 0,
          requires: [a],
          status: 'active',
          committed: bindings([[a, first]]),
        }),
      ],
      activeBindings: bindings([[a, second]]),
    })

    expect(changeOf(result, 'C').classification).toBe('deactivating')
  })

  it('stays neutral when the target still names the same instance', () => {
    const a = key('a')
    const provider = instance('p1', 'P', [a])
    const result = evaluate({
      declarations: [
        declaration({
          id: 'C',
          ordinal: 0,
          requires: [a],
          status: 'active',
          committed: bindings([[a, provider]]),
        }),
      ],
      activeBindings: bindings([[a, provider]]),
    })

    expect(changeOf(result, 'C').classification).toBe('neutral')
  })

  it('deactivates a component that is still activating when its target drifts', () => {
    const a = key('a')
    const provider = instance('p1', 'P', [a])
    const result = evaluate({
      declarations: [
        declaration({
          id: 'C',
          ordinal: 0,
          requires: [a],
          status: 'activating',
          committed: new Map(),
        }),
      ],
      activeBindings: bindings([[a, provider]]),
    })

    expect(changeOf(result, 'C').classification).toBe('deactivating')
  })

  it('keeps a releasing unsatisfied component on the deactivation path', () => {
    const result = evaluate({
      declarations: [declaration({ id: 'C', ordinal: 0, status: 'unsatisfied', releasing: true })],
      activeBindings: new Map(),
    })

    expect(changeOf(result, 'C').classification).toBe('deactivating')
  })

  it('leaves failed and disposed components neutral', () => {
    const a = key('a')
    const provider = instance('p1', 'P', [a])
    const result = evaluate({
      declarations: [
        declaration({ id: 'F', ordinal: 0, requires: [a], status: 'failed' }),
        declaration({ id: 'D', ordinal: 1, requires: [a], status: 'disposed' }),
      ],
      activeBindings: bindings([[a, provider]]),
    })

    expect(changeOf(result, 'F').classification).toBe('neutral')
    expect(changeOf(result, 'D').classification).toBe('neutral')
  })

  it('never activates a component that sits on a cycle', () => {
    const a = key('a')
    const b = key('b')
    const result = evaluate({
      declarations: [
        declaration({ id: 'A', ordinal: 0, requires: [b], provides: [a] }),
        declaration({ id: 'B', ordinal: 1, requires: [a], provides: [b] }),
      ],
      activeBindings: new Map(),
    })

    expect(changeOf(result, 'A').classification).toBe('neutral')
    expect(changeOf(result, 'B').classification).toBe('neutral')
    expect(result.unresolved.size).toBe(0)
  })
})

describe('ordering', () => {
  it('activates a provider before a consumer that becomes ready in the same evaluation', () => {
    const a = key('a')
    const b = key('b')
    const provider = instance('p1', 'PROVIDER', [a])
    const result = evaluate({
      declarations: [
        declaration({ id: 'CONSUMER', ordinal: 0, requires: [a] }),
        // Mounted later, but the consumer must still wait for it.
        declaration({ id: 'PROVIDER', ordinal: 1, provides: [a] }),
      ],
      activeBindings: new Map(),
    })

    expect(changeOf(result, 'CONSUMER').classification).toBe('neutral')
    expect(changeOf(result, 'PROVIDER').classification).toBe('activating')

    // Once the provider publishes, the consumer becomes ready; the order still puts the
    // provider first because the consumer depends on it.
    const after = evaluate({
      declarations: [
        declaration({ id: 'CONSUMER', ordinal: 0, requires: [a] }),
        declaration({ id: 'PROVIDER', ordinal: 1, provides: [a], status: 'active' }),
      ],
      activeBindings: bindings([[a, provider]]),
    })

    expect(after.activationOrder).toEqual(['CONSUMER'])
    expect(changeOf(after, 'CONSUMER').classification).toBe('activating')
    void b
  })

  it('deactivates consumers before their providers', () => {
    const a = key('a')
    const result = evaluate({
      declarations: [
        declaration({ id: 'CONSUMER', ordinal: 0, requires: [a], status: 'active' }),
        declaration({ id: 'ROOT', ordinal: 1, provides: [a], status: 'active', releasing: true }),
      ],
      activeBindings: new Map(),
    })

    expect(result.deactivationOrder).toEqual(['CONSUMER', 'ROOT'])
  })

  it('breaks ties by mount order', () => {
    const a = key('a')
    const result = evaluate({
      declarations: [
        declaration({ id: 'SECOND', ordinal: 1, provides: [a] }),
        declaration({ id: 'FIRST', ordinal: 0, provides: [] }),
      ],
      activeBindings: new Map(),
    })

    expect(result.activationOrder).toEqual(['FIRST', 'SECOND'])
  })

  it('reports changes in mount order', () => {
    const result = evaluate({
      declarations: [
        declaration({ id: 'B', ordinal: 1 }),
        declaration({ id: 'A', ordinal: 0 }),
      ],
      activeBindings: new Map(),
    })

    expect(result.changes.map(change => change.id)).toEqual(['A', 'B'])
  })
})

function changeOf(result: EvaluationResult, name: string): ComponentChange {
  const found = result.changes.find(change => change.id === name)
  if (found === undefined) throw new Error(`no change for ${name}`)
  return found
}
