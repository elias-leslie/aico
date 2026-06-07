import type { TuiSpec } from '../spec'

/** Pi — @mariozechner/pi-coding-agent terminal agent (a-term parity). Launched
 * bare. `processName` is `pi-coding-agent` (the `pi` launcher is a node CLI whose
 * process name resolves to the package). Pi exposes system-prompt files and an
 * --append-system-prompt flag, but no verified native dynamic startup hook here. */
export const piTui: TuiSpec = {
  slug: 'pi',
  displayName: 'Pi',
  // Blocky "Pi" monogram — pi's own pi-mono logo.
  icon: '<svg viewBox="0 0 800 800" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path fill-rule="evenodd" d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"/><path d="M517.36 400H634.72V634.72H517.36Z"/></svg>',
  accent: '#C16A8A', // dusty rose
  order: 4,
  enabled: true,
  command: ['pi'],
  processName: 'pi-coding-agent',
}
