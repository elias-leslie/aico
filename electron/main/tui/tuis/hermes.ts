import type { TuiSpec } from '../spec'

/** Hermes — Nous Research's self-improving terminal agent (a-term parity).
 * Launched bare. a-term tints it amber (#F59E0B), which would clash with the
 * Lantern accent + Claude Code; we give it an aged-bronze accent instead.
 * Mandates inject via Hermes' native pre_llm_call shell hook. */
export const hermesTui: TuiSpec = {
  slug: 'hermes',
  displayName: 'Hermes',
  // Ringed circle enclosing an upward triangle, cardinal ticks — Nous's mark.
  icon: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12 7.2 L16.4 15 H7.6 Z" fill="currentColor"/><g stroke="currentColor" stroke-width="1.5"><line x1="12" y1="1" x2="12" y2="3.6"/><line x1="12" y1="20.4" x2="12" y2="23"/><line x1="1" y1="12" x2="3.6" y2="12"/><line x1="20.4" y1="12" x2="23" y2="12"/></g></svg>',
  accent: '#8B6B45', // aged bronze
  order: 5,
  enabled: true,
  command: ['hermes'],
  processName: 'hermes',
  context: { kind: 'hermes-shell-hooks' },
}
