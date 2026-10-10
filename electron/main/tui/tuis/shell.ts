import type { TuiSpec } from '../spec'

/** Plain shell — the baseline/fallback widget. No command is sent (the tmux
 * session's own shell is the TUI) and there is no context hook. */
export const shellTui: TuiSpec = {
  slug: 'shell',
  displayName: 'Shell',
  // A filled terminal tile with a `>_` prompt — generic shell, no brand.
  icon: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path fill-rule="evenodd" d="M6 3h12a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4Zm.9 6.2a1 1 0 0 0-.1 1.4L8.7 12.5l-1.9 1.9a1 1 0 1 0 1.4 1.4l2.6-2.6a1 1 0 0 0 0-1.4L8.2 9.2a1 1 0 0 0-1.3 0ZM12.5 14.5a1 1 0 1 0 0 2h4.5a1 1 0 1 0 0-2Z"/></svg>',
  accent: '#8A8F98', // gunmetal
  order: 6, // keep the bare shell last in tray order, after the agent TUIs
  enabled: true,
  command: [], // empty: attach to the bare shell, send no launch command
  processName: '',
}
