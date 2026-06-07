import type { TuiSpec } from '../spec'

/** opencode — terminal coding agent (a-term parity). Launched bare, as a-term
 * does. Current opencode supports static instruction files and plugins, but no
 * verified native dynamic SessionStart-equivalent hook in this environment. */
export const opencodeTui: TuiSpec = {
  slug: 'opencode',
  displayName: 'opencode',
  // Two stacked / offset squares — opencode's layered-block mark.
  icon: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="3.5" y="3.5" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="10.5" y="10.5" width="10" height="10" fill="currentColor"/></svg>',
  accent: '#C57B57', // clay / terracotta
  order: 2,
  enabled: true,
  command: ['opencode'],
  processName: 'opencode',
}
