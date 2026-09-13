import { assertNever } from '../foundation/never.js'
import type {
  CapabilityKey,
  ComponentId,
  ComponentStatus,
  ProviderInstance,
} from './types.js'

/** Declaration of one mounted component, as the evaluator sees it. */
export interface ComponentDeclaration {
  /** Registry-local identity. */
  readonly id: ComponentId
  /** Diagnostic label; duplicates are allowed and never used as identity. */
  readonly label: string
  /** Mount order; the stable tie-break for ordering. */
  readonly ordinal: number
  /** Declared requirement keys. */
  readonly requires: readonly CapabilityKey<unknown>[]
  /** Declared offered keys; ownership is reserved at mount. */
  readonly provides: readonly CapabilityKey<unknown>[]
  /** Whether a release has been requested for this component. */
  readonly releasing: boolean
  /** Current lifecycle state. */
  readonly status: ComponentStatus
  /**
   * Resolution this component is bound to for its current episode.
   *
   * While `activating` it is the view captured when the attempt started, which keeps the
   * running setup reading one stable resolution. While `active` it is the resolution the
   * published bindings established. A component that is neither carries an empty map.
   */
  readonly committed: ReadonlyMap<CapabilityKey<unknown>, ProviderInstance>
}

/** Immutable inputs of one evaluation. */
export interface EvaluationInput {
  /** Every mounted component, in mount order. */
  readonly declarations: readonly ComponentDeclaration[]
  /** Published provider instances indexed by the key they bind. */
  readonly activeBindings: ReadonlyMap<CapabilityKey<unknown>, ProviderInstance>
}

/** How one component's lifecycle is affected by the current state. */
export type ChangeClassification = 'neutral' | 'activating' | 'deactivating'

/** What one component should do next. */
export interface ComponentChange {
  /** Component the change applies to. */
  readonly id: ComponentId
  /** Diagnostic label. */
  readonly label: string
  /** Classification of the change. */
  readonly classification: ChangeClassification
  /**
   * Target resolution of this component.
   *
   * `undefined` marks an unsatisfied target. A satisfied target maps every required key
   * to the provider instance that currently resolves it, so an equal value published by
   * a different instance still compares as a change.
   */
  readonly target: ReadonlyMap<CapabilityKey<unknown>, ProviderInstance> | undefined
}

/** A cycle found in the declaration graph. */
export interface CycleReport {
  /** Components on the cycle, canonicalized to start at the smallest identity. */
  readonly ids: readonly ComponentId[]
  /** Diagnostic labels of those components, in the same order. */
  readonly labels: readonly string[]
  /** Key names connecting them, in the same order. */
  readonly keyNames: readonly string[]
}

/** Output of one evaluation; it holds no mutable state and owns no tasks. */
export interface EvaluationResult {
  /** Per-component change, sorted by mount order. */
  readonly changes: readonly ComponentChange[]
  /** Components to activate, in dependency order with a mount-order tie-break. */
  readonly activationOrder: readonly ComponentId[]
  /** Components to deactivate, in reverse dependency order. */
  readonly deactivationOrder: readonly ComponentId[]
  /** Cycles over the declaration graph; empty when the graph is acyclic. */
  readonly cycles: readonly CycleReport[]
  /** Requirement key names with no resolvable provider, mapped to waiting components. */
  readonly unresolved: ReadonlyMap<string, readonly ComponentId[]>
}

/** Internal adjacency of the declaration graph. */
interface Graph {
  /** Key to the component that reserves it. */
  readonly providerByKey: ReadonlyMap<CapabilityKey<unknown>, ComponentId>
  /** Component to the components it depends on directly. */
  readonly dependencies: ReadonlyMap<ComponentId, ReadonlySet<ComponentId>>
  /** Dependent to the requirement keys that connect it to a provider. */
  readonly edgeKeys: ReadonlyMap<ComponentId, ReadonlyMap<ComponentId, CapabilityKey<unknown>>>
}

function buildGraph(declarations: readonly ComponentDeclaration[]): Graph {
  const providerByKey = new Map<CapabilityKey<unknown>, ComponentId>()
  const dependencies = new Map<ComponentId, Set<ComponentId>>()
  const edgeKeys = new Map<ComponentId, Map<ComponentId, CapabilityKey<unknown>>>()

  for (const declaration of declarations) {
    dependencies.set(declaration.id, new Set())
    edgeKeys.set(declaration.id, new Map())
  }

  for (const declaration of declarations) {
    for (const key of declaration.provides) {
      const existing = providerByKey.get(key)
      if (existing === undefined) {
        providerByKey.set(key, declaration.id)
      }
    }
  }

  for (const declaration of declarations) {
    const edges = dependencies.get(declaration.id)
    const keys = edgeKeys.get(declaration.id)
    if (edges === undefined || keys === undefined) continue
    for (const key of declaration.requires) {
      const provider = providerByKey.get(key)
      if (provider === undefined) continue
      edges.add(provider)
      keys.set(provider, key)
    }
  }

  return { providerByKey, dependencies, edgeKeys }
}

/**
 * Detect cycles in the declaration graph and report each once.
 *
 * A cycle is reachable through declarations alone, so two components that never
 * activated successfully still report one. Each reported path is rotated to start at its
 * smallest identity, which makes the report independent of traversal order.
 *
 * @param declarations - Every mounted component, in mount order.
 * @returns One report per distinct cycle.
 */
export function detectCycles(declarations: readonly ComponentDeclaration[]): readonly CycleReport[] {
  const live = declarations.filter(declaration => declaration.status !== 'disposed')
  const graph = buildGraph(live)
  const byId = new Map(live.map(declaration => [declaration.id, declaration]))
  const reported = new Set<string>()
  const reports: CycleReport[] = []
  const orderedIds = [...live].sort((a, b) => a.ordinal - b.ordinal).map(entry => entry.id)

  for (const start of orderedIds) {
    const path: ComponentId[] = []
    const onPath = new Set<ComponentId>()
    const visit = (id: ComponentId): void => {
      path.push(id)
      onPath.add(id)
      for (const next of [...(graph.dependencies.get(id) ?? [])].sort(compareIds)) {
        if (next === start) {
          const cycle = canonicalize(path, graph, byId)
          const fingerprint = JSON.stringify(cycle.ids)
          if (!reported.has(fingerprint)) {
            reported.add(fingerprint)
            reports.push(cycle)
          }
        } else if (!onPath.has(next) && compareIds(next, start) >= 0) {
          // The smallest identity owns each cycle's traversal. Skipping smaller nodes
          // avoids rediscovering rotations while preserving distinct overlapping paths.
          visit(next)
        }
      }
      onPath.delete(id)
      path.pop()
    }
    visit(start)
  }

  return reports
}

function canonicalize(
  cycle: readonly ComponentId[],
  graph: Graph,
  byId: ReadonlyMap<ComponentId, ComponentDeclaration>,
): CycleReport {
  // Rotate to the lexicographically smallest reading so that the report does not depend
  // on which node the traversal happened to start from.
  const rotations = cycle.map((_, start) => [...cycle.slice(start), ...cycle.slice(0, start)])
  const rotated = rotations.reduce((best, candidate) =>
    candidate.join() < best.join() ? candidate : best)

  const keyNames: string[] = []
  for (let index = 0; index < rotated.length; index += 1) {
    const dependent = rotated[index]
    const provider = rotated[(index + 1) % rotated.length]
    if (dependent === undefined || provider === undefined) continue
    const key = graph.edgeKeys.get(dependent)?.get(provider)
    keyNames.push(key?.name ?? byId.get(dependent)?.label ?? 'unknown')
  }

  return {
    ids: rotated,
    labels: rotated.map(id => byId.get(id)?.label ?? 'unknown'),
    keyNames,
  }
}

function compareIds(left: ComponentId, right: ComponentId): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sameTarget(
  committed: ReadonlyMap<CapabilityKey<unknown>, ProviderInstance>,
  target: ReadonlyMap<CapabilityKey<unknown>, ProviderInstance>,
): boolean {
  if (committed.size !== target.size) return false
  for (const [key, instance] of target) {
    if (committed.get(key)?.id !== instance.id) return false
  }
  return true
}

function resolve(
  declaration: ComponentDeclaration,
  activeBindings: ReadonlyMap<CapabilityKey<unknown>, ProviderInstance>,
): ReadonlyMap<CapabilityKey<unknown>, ProviderInstance> | undefined {
  const target = new Map<CapabilityKey<unknown>, ProviderInstance>()
  for (const key of declaration.requires) {
    const instance = activeBindings.get(key)
    if (instance === undefined) return undefined
    target.set(key, instance)
  }
  return target
}

function classify(
  declaration: ComponentDeclaration,
  satisfied: boolean,
  target: ReadonlyMap<CapabilityKey<unknown>, ProviderInstance> | undefined,
): ChangeClassification {
  switch (declaration.status) {
    case 'unsatisfied':
      return satisfied ? 'activating' : 'neutral'
    case 'activating':
    case 'active':
      if (!satisfied) return 'deactivating'
      // A target that still names the same instances leaves the running episode alone; a
      // different instance is a replacement even when it publishes an equal value. A
      // component that satisfies its requirements trivially, such as one with none, is
      // not a replacement: it reports neutral here and its own transition decides what
      // happens next.
      if (target === undefined || target.size === 0) return 'neutral'
      return sameTarget(declaration.committed, target) ? 'neutral' : 'deactivating'
    case 'deactivating':
    case 'failed':
    case 'disposed':
      return 'neutral'
    default:
      return assertNever(declaration.status, 'component status')
  }
}

/**
 * Evaluate the declaration graph and the active bindings into per-component changes.
 *
 * The function is pure: it reads its inputs, executes no user code, and owns no tasks.
 * It is the only place that decides whether a component is satisfied, what it should
 * resolve, and in which order components start and stop.
 *
 * @param input - Declarations and currently published bindings.
 * @returns Changes, ordering, cycles, and unresolved keys.
 */
export function evaluate(input: EvaluationInput): EvaluationResult {
  const ordered = [...input.declarations].sort((a, b) => a.ordinal - b.ordinal)
  const live = ordered.filter(declaration => declaration.status !== 'disposed')
  // A provider leaves the resolvable set as soon as it is asked to leave, and stays out
  // for as long as it is deactivating. Its consumers therefore read themselves as
  // unsatisfied and deactivate first, in a cascade that reaches the end of the chain,
  // while each binding stays published and readable until its own consumer has finished.
  const retiring = new Set(
    ordered
      .filter(entry => entry.releasing || entry.status === 'deactivating')
      .map(entry => entry.id),
  )
  const resolvable = new Map(
    [...input.activeBindings].filter(([, instance]) => !retiring.has(instance.component)),
  )
  const graph = buildGraph(live)
  const cycles = detectCycles(live)
  const cyclic = new Set(cycles.flatMap(cycle => cycle.ids))

  const changes: ComponentChange[] = []
  for (const declaration of ordered) {
    const resolved = cyclic.has(declaration.id) ? undefined : resolve(declaration, resolvable)
    const satisfied = resolved !== undefined && !declaration.releasing && !cyclic.has(declaration.id)
    // A release request outranks satisfaction: it turns a waiting component into a
    // deactivating one, and leaves the two settled states alone.
    const classification = declaration.releasing && declaration.status === 'unsatisfied'
      ? 'deactivating'
      : classify(declaration, satisfied, resolved)

    changes.push({
      id: declaration.id,
      label: declaration.label,
      classification,
      target: satisfied ? resolved : undefined,
    })
  }

  const statusById = new Map(ordered.map(declaration => [declaration.id, declaration.status]))
  const activationCandidates = changes.filter(change =>
    change.classification === 'activating' || statusById.get(change.id) === 'activating')
  const deactivationCandidates = changes.filter(change =>
    change.classification === 'deactivating' || statusById.get(change.id) === 'deactivating')

  return {
    changes,
    activationOrder: orderFor(
      ordered,
      activationCandidates,
      graph,
      true,
      cyclic,
    ),
    deactivationOrder: orderFor(
      ordered,
      deactivationCandidates,
      graph,
      false,
      cyclic,
    ),
    cycles,
    unresolved: collectUnresolved(ordered, resolvable, cyclic),
  }
}

function collectUnresolved(
  declarations: readonly ComponentDeclaration[],
  activeBindings: ReadonlyMap<CapabilityKey<unknown>, ProviderInstance>,
  cyclic: ReadonlySet<ComponentId>,
): ReadonlyMap<string, readonly ComponentId[]> {
  const unresolved = new Map<string, ComponentId[]>()
  for (const declaration of declarations) {
    if (cyclic.has(declaration.id) || declaration.status === 'disposed') continue
    for (const key of declaration.requires) {
      if (activeBindings.has(key)) continue
      const waiting = unresolved.get(key.name) ?? []
      waiting.push(declaration.id)
      unresolved.set(key.name, waiting)
    }
  }
  return unresolved
}

/**
 * Order the components of one direction by dependency topology.
 *
 * Activation runs from providers to consumers; deactivation runs the same order in
 * reverse. Components that are not part of the requested direction keep their relative
 * position through the mount-order tie-break.
 *
 * @param declarations - Every mounted component, in mount order.
 * @param selected - Components whose classification matches the requested direction.
 * @param graph - Declaration adjacency.
 * @param forward - Whether providers precede consumers.
 * @param cyclic - Components excluded by a cycle.
 * @returns Identities in the order they should run.
 */
function orderFor(
  declarations: readonly ComponentDeclaration[],
  selected: readonly ComponentChange[],
  graph: Graph,
  forward: boolean,
  cyclic: ReadonlySet<ComponentId>,
): readonly ComponentId[] {
  const chosen = new Set(selected.map(change => change.id))
  const byId = new Map(declarations.map(declaration => [declaration.id, declaration]))
  const ordinal = (id: ComponentId): number => byId.get(id)?.ordinal ?? Number.MAX_SAFE_INTEGER
  const pick = (candidates: Iterable<ComponentId>): ComponentId | undefined => {
    let best: ComponentId | undefined
    for (const candidate of candidates) {
      if (!chosen.has(candidate) || cyclic.has(candidate)) continue
      if (best === undefined || ordinal(candidate) < ordinal(best)) best = candidate
    }
    return best
  }

  const remaining = new Map<ComponentId, Set<ComponentId>>()
  for (const id of chosen) {
    if (cyclic.has(id)) continue
    const prereqs = new Set<ComponentId>()
    for (const provider of graph.dependencies.get(id) ?? []) {
      if (chosen.has(provider) && !cyclic.has(provider)) prereqs.add(provider)
    }
    remaining.set(id, prereqs)
  }

  const order: ComponentId[] = []
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, prereqs]) => prereqs.size === 0)
      .map(([id]) => id)
    const next = pick(ready)
    if (next === undefined) break
    remaining.delete(next)
    order.push(next)
    for (const prereqs of remaining.values()) prereqs.delete(next)
  }

  // Preserve every selected component if an inconsistent input leaves an unreported cycle.
  for (const id of [...remaining.keys()].sort((a, b) => ordinal(a) - ordinal(b))) order.push(id)

  return forward ? order : order.reverse()
}
