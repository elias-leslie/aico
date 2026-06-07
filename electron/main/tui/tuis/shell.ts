import type { TuiSpec } from '../spec'

/** Plain shell — the baseline/fallback widget. No command is sent (the tmux
 * session's own shell is the TUI) and there is no context hook. */
export const shellTui: TuiSpec = {
  slug: 'shell',
  displayName: 'Shell',
  // `>_` terminal prompt — generic shell, no brand.
  icon: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="6,7.5 11.5,12 6,16.5"/><line x1="13" y1="16.5" x2="19" y2="16.5"/></svg>',
  accent: '#8A8F98', // gunmetal
  order: 6, // keep the bare shell last in tray order, after the agent TUIs
  enabled: true,
  command: [], // empty: attach to the bare shell, send no launch command
  processName: '',
}
