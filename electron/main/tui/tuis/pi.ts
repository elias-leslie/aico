import type { TuiSpec } from '../spec'

/** Pi — @mariozechner/pi-coding-agent terminal agent (a-term parity).
 * `processName` is `pi-coding-agent` (the `pi` launcher is a node CLI whose
 * process name resolves to the package). Pi runs tools without a per-action
 * approval mode; `--approve` removes its separate project-local trust prompt in
 * this operator-owned workspace. A source-linked before_agent_start extension
 * appends canonical Agent Hub context to Pi's already-built native system prompt. */
export const piTui: TuiSpec = {
  slug: 'pi',
  displayName: 'Pi',
  // Blocky pi mark, geometry from pi.dev/favicon.svg on a tight canvas.
  icon: '<svg viewBox="-28 -28 616 616" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M420 280H280V140H0V0H420ZM560 560H420V280H560ZM140 560H0V140H140V280H280V420H140Z"/></svg>',
  accent: '#C16A8A', // dusty rose — distinct from Claude's terracotta
  order: 4,
  enabled: true,
  command: ['pi', '--approve'],
  processName: 'pi-coding-agent',
  context: { kind: 'pi-extension' },
}
