import type { TmuxServerRow } from './store'

/** Runtime classification of one persisted tmux-server generation. None of
 * these states by itself grants process-kill authority. */
export type TmuxServerRuntimeState =
  | 'reachable'
  | 'live-unreachable'
  | 'dead'
  | 'ambiguous'
  | 'socket-collision'

/** `/proc/<persisted-pid>` evidence. `missing` is definitive only when the
 * observer looked up the exact persisted PID; `unavailable` covers permission
 * and transient read failures and must fail closed. */
export type TmuxServerProcessEvidence =
  | { status: 'present'; pid: number; procStartTime: string; controlGroup: string }
  | { status: 'missing'; pid: number }
  | { status: 'unavailable'; pid: number }

/** Evidence from `systemctl --user show <persisted-unit>`. */
export type TmuxServerUnitEvidence =
  | {
      status: 'active'
      scopeUnit: string
      controlGroup: string
      invocationId: string
    }
  | { status: 'inactive'; scopeUnit: string }
  | { status: 'missing'; scopeUnit: string }
  | { status: 'unavailable'; scopeUnit: string }

/** A parsed, read-only roster response from the persisted absolute socket. */
export type TmuxServerRosterEvidence =
  | { status: 'reachable'; serverPid: number }
  | { status: 'transport-failure' }
  | { status: 'unavailable' }

export interface TmuxServerRuntimeEvidence {
  process: TmuxServerProcessEvidence
  unit: TmuxServerUnitEvidence
  roster: TmuxServerRosterEvidence
}

/**
 * Classify a persisted server against independently collected evidence.
 *
 * Precedence is deliberate:
 * 1. A socket that answers as a different PID is a collision, regardless of
 *    whether the original process subsequently died.
 * 2. Missing/reused exact PID+starttime proves the original tmux server died;
 *    its in-memory sessions cannot still exist.
 * 3. A still-live tuple must also match its exact cgroup, unit ControlGroup,
 *    and InvocationID. Any mismatch is ambiguous, never absence.
 * 4. Only after that full live proof can transport failure mean an unlinked or
 *    otherwise unreachable live socket rather than a dead server.
 */
export function classifyTmuxServerState(
  server: TmuxServerRow,
  evidence: TmuxServerRuntimeEvidence,
): TmuxServerRuntimeState {
  const persistedPid = server.serverPid
  const persistedStartTime = server.procStartTime
  const persistedControlGroup = server.controlGroup
  const persistedInvocationId = server.invocationId

  // Provisioning records do not yet carry a complete identity and need their
  // dedicated launch-recovery path. An immutable dead tombstone remains dead.
  if (
    persistedPid === null ||
    persistedStartTime === null ||
    persistedControlGroup === null ||
    persistedInvocationId === null
  ) {
    return server.phase === 'dead' ? 'dead' : 'ambiguous'
  }

  if (evidence.roster.status === 'reachable' && evidence.roster.serverPid !== persistedPid) {
    return 'socket-collision'
  }
  if (server.phase === 'dead') return 'dead'
  if (server.phase !== 'active') return 'ambiguous'

  if (evidence.process.pid !== persistedPid) return 'ambiguous'
  if (evidence.process.status === 'missing') return 'dead'
  if (evidence.process.status === 'unavailable') return 'ambiguous'
  if (evidence.process.procStartTime !== persistedStartTime) return 'dead'

  if (evidence.process.controlGroup !== persistedControlGroup) return 'ambiguous'
  if (evidence.unit.scopeUnit !== server.scopeUnit || evidence.unit.status !== 'active') {
    return 'ambiguous'
  }
  if (
    evidence.unit.controlGroup !== persistedControlGroup ||
    evidence.unit.invocationId !== persistedInvocationId
  ) {
    return 'ambiguous'
  }

  if (evidence.roster.status === 'reachable') return 'reachable'
  if (evidence.roster.status === 'transport-failure') return 'live-unreachable'
  return 'ambiguous'
}
