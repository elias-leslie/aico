import type { TuiSpec } from '../spec'

/** Google Antigravity CLI. The operator explicitly requested its native
 * auto-approval mode, whose current CLI spelling matches Claude's flag. */
export const antigravityTui: TuiSpec = {
  slug: 'agy',
  displayName: 'Antigravity',
  // Antigravity's arch, path from antigravity.google/favicon.svg.
  icon: '<svg viewBox="12 13 88 88" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M89.6992 93.695C94.3659 97.195 101.366 94.8617 94.9492 88.445C75.6992 69.7783 79.7825 18.445 55.8659 18.445C31.9492 18.445 36.0325 69.7783 16.7825 88.445C9.78251 95.445 17.3658 97.195 22.0325 93.695C40.1159 81.445 38.9492 59.8617 55.8659 59.8617C72.7825 59.8617 71.6159 81.445 89.6992 93.695Z"/></svg>',
  accent: '#3186FF', // Antigravity blue
  order: 4,
  enabled: true,
  command: ['agy', '--dangerously-skip-permissions'],
  processName: 'agy',
  context: { kind: 'canonical-retrieval', surface: 'antigravity' },
}
