import type { TuiSpec } from '../spec'
import { claudeCodeTui } from './claude-code'

/** Claude Code using GPT-5.6 through the local claude-code-proxy wrapper.
 * Reuses Claude Code's canonical context delivery while keeping the OpenAI
 * backend explicit as a separate operator-selectable TUI. */
export const claudeGptTui: TuiSpec = {
  slug: 'claude-gpt',
  displayName: 'Claude GPT',
  icon: claudeCodeTui.icon,
  accent: '#10A37F',
  order: 1,
  enabled: true,
  command: ['claude-gpt', '--dangerously-skip-permissions'],
  processName: 'claude',
  context: { kind: 'claude-session-start' },
}
