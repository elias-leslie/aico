import type { TuiSpec } from '../spec'

/** Google Antigravity CLI. The operator explicitly requested its native
 * auto-approval mode, whose current CLI spelling matches Claude's flag. */
export const antigravityTui: TuiSpec = {
  slug: 'agy',
  displayName: 'Antigravity',
  // Angular A with an orbiting point: compact at titlebar size and distinct
  // from Gemini's four-point mark.
  icon: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 19 L12 4 L19 19 M8 14 H16"/><path d="M3 10 C6 6 15 5 21 8"/><circle cx="20.5" cy="8" r="1.3" fill="currentColor" stroke="none"/></svg>',
  accent: '#4F8DF7',
  order: 4,
  enabled: true,
  command: ['agy', '--dangerously-skip-permissions'],
  processName: 'agy',
}
