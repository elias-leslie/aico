import { describe, expect, it } from 'vitest'
import {
  CoalescedLifecycleIntent,
  classifyPersistedScopePair,
  decideManagedGateRecovery,
  hasPersistedScopeCleanupEvidence,
  isReconciledSessionOwnershipAbsent,
  LifecycleOwnerLock,
  type LifecycleOwnerToken,
  mayClearMatchingPendingScope,
} from './lifecycle-guard'

function acquire(lock: LifecycleOwnerLock, widgetId: string): LifecycleOwnerToken {
  const token = lock.acquire(widgetId)
  if (!token) throw new Error(`failed to acquire ${widgetId}`)
  return token
}

describe('LifecycleOwnerLock', () => {
  it('serializes lifecycle work independently per widget', () => {
    const lock = new LifecycleOwnerLock()
    const first = acquire(lock, 'first-widget')
    const second = acquire(lock, 'second-widget')

    expect(lock.acquire('first-widget')).toBeNull()
    expect(lock.isHeld('first-widget')).toBe(true)
    expect(lock.isHeld('second-widget')).toBe(true)

    expect(lock.release(first)).toBe(true)
    expect(lock.isHeld('first-widget')).toBe(false)
    expect(lock.isHeld('second-widget')).toBe(true)
    expect(lock.release(second)).toBe(true)
  })

  it('does not let a stale owner release a later operation', () => {
    const lock = new LifecycleOwnerLock()
    const staleOwner = acquire(lock, 'widget')
    expect(lock.release(staleOwner)).toBe(true)

    const currentOwner = acquire(lock, 'widget')
    expect(currentOwner).not.toBe(staleOwner)

    expect(lock.release(staleOwner)).toBe(false)
    expect(lock.isHeld('widget')).toBe(true)
    expect(lock.acquire('widget')).toBeNull()
    expect(lock.release(currentOwner)).toBe(true)
    expect(lock.isHeld('widget')).toBe(false)
  })

  it('rejects a token issued by another lock instance', () => {
    const firstLock = new LifecycleOwnerLock()
    const otherLock = new LifecycleOwnerLock()
    const token = acquire(firstLock, 'widget')

    expect(otherLock.release(token)).toBe(false)
    expect(firstLock.isHeld('widget')).toBe(true)
    expect(firstLock.release(token)).toBe(true)
  })
})

describe('CoalescedLifecycleIntent', () => {
  it('retains and coalesces an intent until it acquires the widget owner', () => {
    const owners = new LifecycleOwnerLock()
    const intents = new CoalescedLifecycleIntent()
    const reconciliation = acquire(owners, 'widget')

    intents.request('widget')
    intents.request('widget')
    expect(intents.take('widget', owners)).toBeNull()
    expect(intents.isPending('widget')).toBe(true)

    expect(owners.release(reconciliation)).toBe(true)
    const retirement = intents.take('widget', owners)
    expect(retirement).not.toBeNull()
    expect(intents.isPending('widget')).toBe(false)
    intents.request('widget')
    expect(intents.isPending('widget')).toBe(false)
    expect(intents.take('widget', owners)).toBeNull()
    expect(intents.complete('widget')).toBe(true)
    expect(intents.complete('widget')).toBe(false)
    expect(owners.release(retirement as LifecycleOwnerToken)).toBe(true)
  })

  it('does not let one widget block another pending intent', () => {
    const owners = new LifecycleOwnerLock()
    const intents = new CoalescedLifecycleIntent()
    const first = acquire(owners, 'first-widget')
    intents.request('first-widget')
    intents.request('second-widget')

    expect(intents.take('first-widget', owners)).toBeNull()
    const second = intents.take('second-widget', owners)
    expect(second).not.toBeNull()
    expect(intents.isPending('first-widget')).toBe(true)
    expect(intents.isPending('second-widget')).toBe(false)

    expect(intents.complete('second-widget')).toBe(true)
    expect(owners.release(second as LifecycleOwnerToken)).toBe(true)
    expect(owners.release(first)).toBe(true)
  })
})

describe('classifyPersistedScopePair', () => {
  it('distinguishes already-cleared, usable, and malformed scope tuples', () => {
    expect(classifyPersistedScopePair(null, null)).toEqual({ state: 'absent' })
    expect(classifyPersistedScopePair(undefined, undefined)).toEqual({ state: 'absent' })
    expect(classifyPersistedScopePair('tmux-spawn-owned.scope', 'invocation-id')).toEqual({
      state: 'paired',
      scopeUnit: 'tmux-spawn-owned.scope',
      scopeInvocationId: 'invocation-id',
    })

    expect(classifyPersistedScopePair('tmux-spawn-owned.scope', null)).toEqual({
      state: 'malformed',
    })
    expect(classifyPersistedScopePair(null, 'invocation-id')).toEqual({ state: 'malformed' })
    expect(classifyPersistedScopePair('', 'invocation-id')).toEqual({ state: 'malformed' })
    expect(classifyPersistedScopePair('tmux-spawn-owned.scope', '')).toEqual({
      state: 'malformed',
    })
  })
})

describe('isReconciledSessionOwnershipAbsent', () => {
  const reconciled = {
    tmuxSessionId: null,
    paneId: null,
    launchState: 'none' as const,
    launchNonce: null,
  }

  it('accepts only the exact post-reconciliation session state', () => {
    expect(isReconciledSessionOwnershipAbsent(reconciled)).toBe(true)
    expect(isReconciledSessionOwnershipAbsent({ ...reconciled, tmuxSessionId: '$1' })).toBe(false)
    expect(isReconciledSessionOwnershipAbsent({ ...reconciled, paneId: '%1' })).toBe(false)
    expect(
      isReconciledSessionOwnershipAbsent({
        ...reconciled,
        launchState: 'dispatched',
        launchNonce: '0123456789abcdef0123456789abcdef',
      }),
    ).toBe(false)
    expect(
      isReconciledSessionOwnershipAbsent({ ...reconciled, launchNonce: 'stale-launch-nonce' }),
    ).toBe(false)
  })
})

describe('hasPersistedScopeCleanupEvidence', () => {
  it('reports either current or pending persisted scope as cleanup evidence', () => {
    expect(hasPersistedScopeCleanupEvidence({ scopeUnit: null, pendingScopeUnit: null })).toBe(
      false,
    )
    expect(
      hasPersistedScopeCleanupEvidence({
        scopeUnit: 'tmux-spawn-current.scope',
        pendingScopeUnit: null,
      }),
    ).toBe(true)
    expect(
      hasPersistedScopeCleanupEvidence({
        scopeUnit: null,
        pendingScopeUnit: 'tmux-spawn-pending.scope',
      }),
    ).toBe(true)
  })

  it('fails closed for malformed persisted scope values', () => {
    expect(hasPersistedScopeCleanupEvidence({ scopeUnit: '', pendingScopeUnit: null })).toBe(true)
    expect(hasPersistedScopeCleanupEvidence({ scopeUnit: undefined, pendingScopeUnit: '' })).toBe(
      true,
    )
  })
})

describe('managed launch-gate recovery', () => {
  it('dispatches only a fresh, explicitly recoverable singleton gate', () => {
    expect(
      decideManagedGateRecovery({
        gateState: 'inert',
        launchState: 'gated',
        pendingMatchesCurrent: false,
        dispatchGate: true,
      }),
    ).toBe('dispatch')
  })

  it.each([
    ['already dispatched', 'dispatched' as const, false, true],
    ['matching pending generation', 'gated' as const, true, true],
    ['verify-only replacement', 'gated' as const, false, false],
  ])('never replays an inert gate that is %s', (_label, launchState, pendingMatchesCurrent, dispatchGate) => {
    expect(
      decideManagedGateRecovery({
        gateState: 'inert',
        launchState,
        pendingMatchesCurrent,
        dispatchGate,
      }),
    ).toBe('blocked-replay')
  })

  it('distinguishes active work from an ambiguous cgroup', () => {
    expect(
      decideManagedGateRecovery({
        gateState: 'active-workload',
        launchState: 'dispatched',
        pendingMatchesCurrent: false,
        dispatchGate: true,
      }),
    ).toBe('recovered')
    expect(
      decideManagedGateRecovery({
        gateState: 'ambiguous',
        launchState: 'gated',
        pendingMatchesCurrent: false,
        dispatchGate: true,
      }),
    ).toBe('blocked')
  })

  it('clears an equal pending tuple only for the still-active pre-respawn workload', () => {
    expect(mayClearMatchingPendingScope('active-workload')).toBe(true)
    expect(mayClearMatchingPendingScope('inert')).toBe(false)
    expect(mayClearMatchingPendingScope('ambiguous')).toBe(false)
  })
})
