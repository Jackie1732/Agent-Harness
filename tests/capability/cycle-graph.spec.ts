import { describe, expect, it } from 'vitest'
import { createCapabilityKey } from '../../src/index.js'
import { detectCycles, evaluate } from '../../src/capability/evaluate.js'
import type { ComponentDeclaration } from '../../src/capability/evaluate.js'
import type { ComponentId } from '../../src/capability/types.js'

describe('capability declaration graph model', () => {
  it('matches independent reachability for every four-node directed graph', () => {
    const ids = ['c1', 'c2', 'c10', 'c11'] as ComponentId[]
    const keys = ids.map(id => createCapabilityKey<string>(`cycle-model.${id}`))
    const pairs = ids.flatMap((_, from) => ids.map((_, to) => [from, to] as const))
      .filter(([from, to]) => from !== to)
    const permutations = ids.flatMap(first => ids.filter(id => id !== first).flatMap(second =>
      ids.filter(id => id !== first && id !== second).flatMap(third =>
        ids.filter(id => id !== first && id !== second && id !== third)
          .map(fourth => [first, second, third, fourth]))))
    const possibleCycles = [...new Map([2, 3, 4]
      .flatMap(length => permutations.map(order => order.slice(0, length)))
      .filter(path => path[0] === [...path].sort()[0])
      .map(path => [path.join(), path])).values()]

    for (let mask = 0; mask < 2 ** pairs.length; mask += 1) {
      const edges = pairs.filter((_, index) => (mask & (1 << index)) !== 0)
      const reachable = ids.map((_, from) => ids.map((_, to) =>
        edges.some(([consumer, provider]) => consumer === from && provider === to)))
      for (let via = 0; via < ids.length; via += 1) {
        for (let from = 0; from < ids.length; from += 1) {
          for (let to = 0; to < ids.length; to += 1) {
            reachable[from]![to] ||= reachable[from]![via]! && reachable[via]![to]!
          }
        }
      }
      const declarations: ComponentDeclaration[] = ids.map((id, index) => ({
        id,
        label: 'same-label',
        ordinal: index,
        requires: edges.filter(([from]) => from === index).map(([, to]) => keys[to]!),
        provides: [keys[index]!],
        releasing: false,
        status: 'unsatisfied',
        committed: new Map(),
      }))
      const cycles = detectCycles(declarations)
      const expectedPaths = possibleCycles.filter(path => path.every((from, index) => {
        const to = path[(index + 1) % path.length]!
        return edges.some(([consumer, provider]) => ids[consumer] === from && ids[provider] === to)
      })).map(path => path.join()).sort()
      expect(cycles.map(cycle => cycle.ids.join()).sort()).toEqual(expectedPaths)
      const cyclic = new Set(cycles.flatMap(cycle => cycle.ids))
      expect([...cyclic].sort()).toEqual(ids.filter((_, index) => reachable[index]![index]).sort())
      expect(new Set(cycles.map(cycle => JSON.stringify(cycle.ids))).size).toBe(cycles.length)
      for (const cycle of cycles) {
        expect(cycle.ids[0]).toBe([...cycle.ids].sort()[0])
        for (let index = 0; index < cycle.ids.length; index += 1) {
          const from = ids.indexOf(cycle.ids[index]!)
          const to = ids.indexOf(cycle.ids[(index + 1) % cycle.ids.length]!)
          expect(edges.some(([consumer, provider]) => consumer === from && provider === to)).toBe(true)
          expect(cycle.keyNames[index]).toBe(keys[to]!.name)
        }
      }
      expect(detectCycles([...declarations].reverse())).toEqual(cycles)
      const result = evaluate({ declarations, activeBindings: new Map() })
      expect(result.changes.filter(change => cyclic.has(change.id))
        .every(change => change.classification === 'neutral')).toBe(true)
    }
  })

  it('keeps a consumer-first DAG with convergent dependency paths acyclic', () => {
    const size = 18
    const ids = Array.from({ length: size }, (_, index) => `c${index + 1}` as ComponentId)
    const keys = ids.map((_, index) => createCapabilityKey<string>(`dag-model.${index}`))
    const declarations: ComponentDeclaration[] = ids.map((id, index) => ({
      id,
      label: `component-${index}`,
      ordinal: index,
      requires: keys.slice(index + 1),
      provides: [keys[index]!],
      releasing: false,
      status: 'unsatisfied',
      committed: new Map(),
    }))

    expect(detectCycles(declarations)).toEqual([])
    const result = evaluate({ declarations, activeBindings: new Map() })
    expect(result.activationOrder).toEqual([ids[size - 1]])
    expect(result.changes.filter(change => change.classification === 'activating')).toHaveLength(1)
  })

  it('reports only local simple cycles when branching cycles share articulation nodes', () => {
    const stages = 12
    const size = stages * 3 + 1
    const ids = Array.from({ length: size }, (_, index) => `c${index + 1}` as ComponentId)
    const keys = ids.map((_, index) => createCapabilityKey<string>(`diamond.${index}`))
    const adjacency: number[][] = ids.map(() => [])
    const expected: string[] = []
    for (let stage = 0; stage < stages; stage += 1) {
      const hub = stage * 3
      const left = hub + 1, right = hub + 2, nextHub = hub + 3
      adjacency[hub]!.push(left, right)
      adjacency[left]!.push(nextHub)
      adjacency[right]!.push(nextHub)
      adjacency[nextHub]!.push(hub)
      expected.push([ids[hub]!, ids[left]!, ids[nextHub]!].sort().join())
      expected.push([ids[hub]!, ids[right]!, ids[nextHub]!].sort().join())
    }
    const declarations: ComponentDeclaration[] = ids.map((id, index) => ({
      id,
      label: `node-${index}`,
      ordinal: index,
      requires: adjacency[index]!.map(provider => keys[provider]!),
      provides: [keys[index]!],
      releasing: false,
      status: 'unsatisfied',
      committed: new Map(),
    }))

    const cycles = detectCycles(declarations)
    expect(cycles.map(cycle => [...cycle.ids].sort().join()).sort()).toEqual(expected.sort())
    for (const cycle of cycles) {
      expect(cycle.ids).toHaveLength(3)
      for (let index = 0; index < cycle.ids.length; index += 1) {
        const from = ids.indexOf(cycle.ids[index]!)
        const to = ids.indexOf(cycle.ids[(index + 1) % cycle.ids.length]!)
        expect(adjacency[from]).toContain(to)
        expect(cycle.keyNames[index]).toBe(keys[to]!.name)
      }
    }
    expect(detectCycles([...declarations].reverse())).toEqual(cycles)
  })
})
