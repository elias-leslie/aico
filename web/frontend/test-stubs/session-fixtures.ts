/**
 * Test fixtures for sessions and Slots. The `*_CAN` rows are the backend's
 * capability flags per kind (a_term/services/session_capabilities.py).
 */
import type { ATermSession } from '@/lib/hooks/use-a-term-sessions'
import type { SlotCapabilities } from '@/lib/utils/slot'

type CapabilityFlags = Pick<
  ATermSession,
  'can_rename' | 'can_respawn' | 'can_end'
>

/** An ordinary Tether session. */
export const TETHER_CAN: CapabilityFlags = {
  can_rename: true,
  can_respawn: true,
  can_end: true,
}

/** A Tether root session: runs one launch, never respawned. */
export const ROOT_CAN: CapabilityFlags = {
  can_rename: true,
  can_respawn: false,
  can_end: true,
}

/** A pre-Tether Legacy session: attach-only, but A-Term can end it. */
export const LEGACY_CAN: CapabilityFlags = {
  can_rename: false,
  can_respawn: false,
  can_end: true,
}

/** An Own tmux session: shown, never renamed, respawned or ended. */
export const OWN_TMUX_CAN: CapabilityFlags = {
  can_rename: false,
  can_respawn: false,
  can_end: false,
}

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
