import { createHash } from 'node:crypto'
import {
  classifyPersistedScopePair,
  isNeverAllocatedWidget,
  isReconciledSessionOwnershipAbsent,
} from './lifecycle-guard'
import { stopOwnedPaneScope } from './owner-scope'
import { MANAGED_LIFECYCLE_VERSION } from './ownership'
import {
  clearWidgetPendingScope,
  getWidget,
  removeWidgetIfOwnership,
  type WidgetOwnershipGeneration,
  type WidgetRow,
} from './store'

export type RetirementResult =
  | { status: 'ended' }
  | { status: 'absent' }
  | { status: 'stale' }
  | { status: 'blocked'; reason: string }

export type SessionState = 'present' | 'absent' | 'unknown'

export interface RetirementOperations {
  sessionState(widgetId: string): Promise<SessionState>
  verifiedCurrentPane(row: WidgetRow): Promise<boolean>
  stopTmuxSession(row: WidgetRow): Promise<void>
  settleServer(row: WidgetRow): Promise<void>
}

export function ownershipGeneration(row: WidgetRow): WidgetOwnershipGeneration {
  return {
    scopeUnit: row.scopeUnit,
    scopeInvocationId: row.scopeInvocationId,
    pendingScopeUnit: row.pendingScopeUnit,
    pendingScopeInvocationId: row.pendingScopeInvocationId,
    lifecycleVersion: row.lifecycleVersion,
    tmuxSessionId: row.tmuxSessionId,
    paneId: row.paneId,
    tmuxServerId: row.tmuxServerId,
    tmuxAllocationState: row.tmuxAllocationState,
    launchState: row.launchState,
    launchNonce: row.launchNonce,
  }
}

/** A caller only receives an opaque token derived from the persisted row. */
export function sessionGeneration(row: WidgetRow): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        row.id,
        row.sessionId,
        row.externalTmuxSocket,
        row.externalTmuxSession,
        ownershipGeneration(row),
      ]),
    )
    .digest('hex')
}

/** Shared GUI/headless native End sequence. Each destructive step is guarded
 * by freshly observed owner identity; only a matching catalog CAS returns End. */
export async function retireOwnedSession(
  widgetId: string,
  operations: RetirementOperations,
  expectedGeneration?: string,
): Promise<RetirementResult> {
  let row = getWidget(widgetId)
  if (!row) return { status: 'absent' }
  if (row.externalTmuxSession) return { status: 'blocked', reason: 'external owner required' }
  const initialGeneration = sessionGeneration(row)
  if (expectedGeneration && initialGeneration !== expectedGeneration) {
    return { status: 'stale' }
  }
  if (row.lifecycleVersion < MANAGED_LIFECYCLE_VERSION) {
    if (isNeverAllocatedWidget(row)) {
      const latest = getWidget(widgetId)
      if (!latest || sessionGeneration(latest) !== initialGeneration) return { status: 'stale' }
      const removed = removeWidgetIfOwnership(widgetId, ownershipGeneration(row))
      return removed ? { status: 'ended' } : { status: 'stale' }
    }
    return {
      status: 'blocked',
      reason: 'legacy containment lacks exact descendant ownership',
    }
  }

  const before = await operations.sessionState(widgetId)
  if (before === 'unknown') return { status: 'blocked', reason: 'tmux state is unknown' }
  if (before === 'present') {
    if (!(await operations.verifiedCurrentPane(row))) {
      return { status: 'blocked', reason: 'session, pane, or scope identity is not exact' }
    }
    const latestBeforeStop = getWidget(widgetId)
    if (!latestBeforeStop) return { status: 'stale' }
    if (sessionGeneration(latestBeforeStop) !== initialGeneration) {
      return { status: 'stale' }
    }
    try {
      await operations.stopTmuxSession(row)
    } catch (error) {
      console.warn(`[aico:lifecycle] tmux stop failed for session=${row.sessionId}:`, error)
    }
    await operations.settleServer(row)
  }
  const afterTmux = await operations.sessionState(widgetId)
  if (afterTmux !== 'absent') {
    return { status: 'blocked', reason: `tmux state after stop is ${afterTmux}` }
  }

  const afterSession = getWidget(widgetId)
  if (!afterSession || sessionGeneration(afterSession) !== initialGeneration) {
    return { status: 'stale' }
  }
  row = afterSession
  const pendingScope = classifyPersistedScopePair(
    row.pendingScopeUnit,
    row.pendingScopeInvocationId,
  )
  if (pendingScope.state === 'malformed') {
    return { status: 'blocked', reason: 'pending scope identity is malformed' }
  }
  if (pendingScope.state === 'paired') {
    const beforePending = getWidget(widgetId)
    if (!beforePending || sessionGeneration(beforePending) !== initialGeneration) {
      return { status: 'stale' }
    }
    const pendingClean = await stopOwnedPaneScope(
      pendingScope.scopeUnit,
      pendingScope.scopeInvocationId,
      `retire pending generation ${row.sessionId}`,
    )
    if (!pendingClean) return { status: 'blocked', reason: 'pending scope cleanup failed' }
    if (
      !clearWidgetPendingScope(widgetId, pendingScope.scopeUnit, pendingScope.scopeInvocationId)
    ) {
      return { status: 'stale' }
    }
    const afterPending = getWidget(widgetId)
    if (!afterPending) return { status: 'stale' }
    if (
      sessionGeneration(afterPending) !==
      sessionGeneration({ ...row, pendingScopeUnit: null, pendingScopeInvocationId: null })
    )
      return { status: 'stale' }
    row = afterPending
  }

  const currentScope = classifyPersistedScopePair(row.scopeUnit, row.scopeInvocationId)
  if (currentScope.state === 'malformed') {
    return { status: 'blocked', reason: 'owned scope identity is malformed' }
  }
  if (currentScope.state === 'absent' && !isReconciledSessionOwnershipAbsent(row)) {
    return { status: 'blocked', reason: 'scope is absent before ownership reconciliation' }
  }
  if (currentScope.state === 'paired') {
    const beforeCurrent = getWidget(widgetId)
    if (!beforeCurrent || sessionGeneration(beforeCurrent) !== sessionGeneration(row)) {
      return { status: 'stale' }
    }
    const clean = await stopOwnedPaneScope(
      currentScope.scopeUnit,
      currentScope.scopeInvocationId,
      `retire session ${row.sessionId}`,
    )
    if (!clean) return { status: 'blocked', reason: 'owned scope cleanup failed' }
  }
  if ((await operations.sessionState(widgetId)) !== 'absent') {
    return { status: 'blocked', reason: 'session reappeared during cleanup' }
  }
  const latest = getWidget(widgetId)
  if (!latest || sessionGeneration(latest) !== sessionGeneration(row)) {
    return { status: 'stale' }
  }
  if (
    classifyPersistedScopePair(latest.pendingScopeUnit, latest.pendingScopeInvocationId).state !==
    'absent'
  ) {
    return { status: 'stale' }
  }
  if (!removeWidgetIfOwnership(widgetId, ownershipGeneration(row))) return { status: 'stale' }
  console.log(`[aico:lifecycle] retired session=${row.sessionId} scope=${row.scopeUnit}`)
  return { status: 'ended' }
}
