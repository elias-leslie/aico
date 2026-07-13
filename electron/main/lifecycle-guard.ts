declare const lifecycleOwnerTokenBrand: unique symbol

/** Opaque proof that a caller owns one widget's lifecycle operation. */
export interface LifecycleOwnerToken {
  readonly [lifecycleOwnerTokenBrand]: never
}

/**
 * Serializes lifecycle work per widget without allowing an older operation to
 * release a newer operation's lock. Tokens are intentionally unforgeable at
 * runtime: their widget association lives only in this instance's WeakMap.
 */
export class LifecycleOwnerLock {
  private readonly owners = new Map<string, LifecycleOwnerToken>()
  private readonly widgetByToken = new WeakMap<LifecycleOwnerToken, string>()

  acquire(widgetId: string): LifecycleOwnerToken | null {
    if (this.owners.has(widgetId)) return null

    const token = Object.freeze({}) as LifecycleOwnerToken
    this.owners.set(widgetId, token)
    this.widgetByToken.set(token, widgetId)
    return token
  }

  isHeld(widgetId: string): boolean {
    return this.owners.has(widgetId)
  }

  release(token: LifecycleOwnerToken): boolean {
    const widgetId = this.widgetByToken.get(token)
    if (widgetId === undefined || this.owners.get(widgetId) !== token) return false

    this.owners.delete(widgetId)
    this.widgetByToken.delete(token)
    return true
  }
}

/**
 * Coalesces an explicit lifecycle intent while another operation owns the
 * widget. The intent is consumed only after the caller actually acquires the
 * matching owner token, so a competing reconciliation cannot lose it.
 */
export class CoalescedLifecycleIntent {
  private readonly pending = new Set<string>()
  private readonly active = new Set<string>()

  request(widgetId: string): void {
    if (this.active.has(widgetId)) return
    this.pending.add(widgetId)
  }

  isPending(widgetId: string): boolean {
    return this.pending.has(widgetId)
  }

  take(widgetId: string, owners: LifecycleOwnerLock): LifecycleOwnerToken | null {
    if (!this.pending.has(widgetId)) return null
    const owner = owners.acquire(widgetId)
    if (!owner) return null
    this.pending.delete(widgetId)
    this.active.add(widgetId)
    return owner
  }

  complete(widgetId: string): boolean {
    return this.active.delete(widgetId)
  }
}

export type PersistedScopePair =
  | { readonly state: 'absent' }
  | {
      readonly state: 'paired'
      readonly scopeUnit: string
      readonly scopeInvocationId: string
    }
  | { readonly state: 'malformed' }

/**
 * Distinguish an already-cleared scope tuple from cleanup authority and from a
 * partial/corrupt tuple. Callers may skip cleanup only for `absent`; `paired`
 * still requires the owning unit/invocation validators before it can be used.
 */
export function classifyPersistedScopePair(
  scopeUnit: string | null | undefined,
  scopeInvocationId: string | null | undefined,
): PersistedScopePair {
  if (scopeUnit == null && scopeInvocationId == null) return { state: 'absent' }
  if (scopeUnit && scopeInvocationId) {
    return { state: 'paired', scopeUnit, scopeInvocationId }
  }
  return { state: 'malformed' }
}

export interface ManagedSessionOwnershipState {
  readonly tmuxSessionId: string | null
  readonly paneId: string | null
  readonly launchState: 'none' | 'gated' | 'dispatched'
  readonly launchNonce: string | null
}

/** An absent scope is already clean only after the session and launch identity
 * were cleared by reconciliation. Otherwise missing scope metadata is lost
 * cleanup authority and retirement must fail closed. */
export function isReconciledSessionOwnershipAbsent(state: ManagedSessionOwnershipState): boolean {
  return (
    state.tmuxSessionId === null &&
    state.paneId === null &&
    state.launchState === 'none' &&
    state.launchNonce === null
  )
}

export interface PersistedScopeState {
  readonly scopeUnit: string | null | undefined
  readonly pendingScopeUnit: string | null | undefined
}

/**
 * Any persisted scope reference is cleanup evidence. Even an invalid or empty
 * value must fail closed rather than let recreation overwrite the only record
 * that an older workload may still exist.
 */
export function hasPersistedScopeCleanupEvidence(state: PersistedScopeState): boolean {
  return state.scopeUnit != null || state.pendingScopeUnit != null
}

export type ManagedGateState = 'inert' | 'active-workload' | 'ambiguous'
export type ManagedGateRecoveryDecision = 'recovered' | 'dispatch' | 'blocked' | 'blocked-replay'

export interface ManagedGateRecoveryState {
  readonly gateState: ManagedGateState
  readonly launchState: 'none' | 'gated' | 'dispatched'
  readonly pendingMatchesCurrent: boolean
  readonly dispatchGate: boolean
}

/**
 * Decide whether an interrupted launch gate may advance. A singleton gate is
 * necessary but not sufficient: an equal current/pending generation means a
 * respawn may have reused the old cgroup, while a dispatched nonce means the
 * previous launch result is unknowable. Both cases preserve the gate and
 * require an explicit, freshly requested replacement rather than replay.
 */
export function decideManagedGateRecovery(
  state: ManagedGateRecoveryState,
): ManagedGateRecoveryDecision {
  if (state.gateState === 'ambiguous') return 'blocked'
  if (state.gateState === 'active-workload') return 'recovered'
  if (state.pendingMatchesCurrent || !state.dispatchGate || state.launchState === 'dispatched') {
    return 'blocked-replay'
  }
  return state.launchState === 'gated' ? 'dispatch' : 'blocked'
}

/** A matching pending tuple is safe to clear only when the current generation
 * is still the pre-respawn workload. An inert/ambiguous gate could instead be
 * a same-cgroup respawn with unattributed descendants and must fail closed. */
export function mayClearMatchingPendingScope(gateState: ManagedGateState): boolean {
  return gateState === 'active-workload'
}
