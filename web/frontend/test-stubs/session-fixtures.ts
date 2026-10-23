/**
 * Test fixtures for sessions and Slots. The `*_CAN` rows are the backend's
 * capability flags per kind, read from session-capabilities.json, which
 * tests/test_session_capabilities.py checks against
 * a_term/services/session_capabilities.py.
 */
import type { ATermSession } from '@/lib/hooks/use-a-term-sessions'
import type { SlotCapabilities } from '@/lib/utils/slot'
import capabilities from './session-capabilities.json'

type CapabilityFlags = Pick<
  ATermSession,
  'can_rename' | 'can_respawn' | 'can_end'
>

/** An ordinary Tether session. */
export const TETHER_CAN: CapabilityFlags = capabilities.tether

/** A Tether root session: runs one launch, never respawned. */
export const ROOT_CAN: CapabilityFlags = capabilities.root

/** A Tether session an older Tether started (status `legacy`): never respawned. */
export const TETHER_LEGACY_CAN: CapabilityFlags = capabilities.tether_legacy

/** An Own tmux session: shown, never renamed, respawned or ended. */
export const OWN_TMUX_CAN: CapabilityFlags = capabilities.own_tmux

/** Session fields a test rarely cares about (a Tether session by default). */
export const SESSION_BASE = {
  user_id: null,
  project_id: null,
  display_order: 0,
  created_at: null,
  last_accessed_at: null,
  ...TETHER_CAN,
} satisfies Partial<ATermSession>

/** Slot capabilities for tests that do not exercise them: a pane session that
 * is renamed as a pane and can be reset and ended. */
export const SLOT_BASE: {
  can: SlotCapabilities
  showsSessionTitle: boolean
} = {
  can: { rename: false, reset: true, end: true },
  showsSessionTitle: false,
}
