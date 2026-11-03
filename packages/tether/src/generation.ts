import { createHash } from 'node:crypto'

export type TmuxAllocationState = 'unallocated' | 'legacy-unclassified' | 'bound' | 'external'
export type LaunchState = 'none' | 'gated' | 'dispatched'

/** The identity columns a generation covers (Aico WidgetRow subset). */
export interface SessionIdentity {
  id: string
  ownershipId: string
  scopeUnit: string | null
  scopeInvocationId: string | null
  pendingScopeUnit: string | null
  pendingScopeInvocationId: string | null
  lifecycleVersion: number
  tmuxSessionId: string | null
  paneId: string | null
  tmuxServerId: string | null
  tmuxAllocationState: TmuxAllocationState
  launchState: LaunchState
  launchNonce: string | null
}

/**
 * Opaque SHA-256 fence over a session's exact identity.
 *
 * This reproduces Aico's `sessionGeneration` (electron/main/owner-retirement.ts)
 * byte for byte, including the two always-null external tmux fields and the
 * object key order, so a generation a client read from Aico before cutover
 * stays valid against the imported row. Changing the serialization is an API
 * break.
 */
export function sessionGeneration(row: SessionIdentity): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        row.id,
        row.ownershipId,
        null,
        null,
        {
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
        },
      ]),
    )
    .digest('hex')
}

export const GENERATION_RE = /^[0-9a-f]{64}$/
export const SESSION_ID_RE = /^[0-9a-f]{8}$/
