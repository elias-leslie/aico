import type { TuiSpec } from '../spec'

/** Claude Code — the default widget TUI. Mandates inject via the existing
 * `~/.claude/hooks/SessionStart.sh` hook (verified, not installed, by Aico).
 * Keep the CLI's normal permission prompts. Autonomous execution must be an
 * explicit, visible Agent Hub profile rather than a hidden launcher default. */
export const claudeCodeTui: TuiSpec = {
  slug: 'claude-code',
  displayName: 'Claude Code',
  // Radiating sunburst — Claude's spark mark.
  icon: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><line x1="12.00" y1="11.40" x2="12.00" y2="1.40"/><line x1="12.32" y1="11.50" x2="16.65" y2="4.77"/><line x1="12.55" y1="11.75" x2="22.01" y2="7.43"/><line x1="12.59" y1="12.09" x2="20.91" y2="13.28"/><line x1="12.45" y1="12.39" x2="19.71" y2="18.68"/><line x1="12.17" y1="12.58" x2="14.31" y2="19.87"/><line x1="11.83" y1="12.58" x2="8.90" y2="22.55"/><line x1="11.55" y1="12.39" x2="4.90" y2="18.16"/><line x1="11.41" y1="12.09" x2="1.51" y2="13.51"/><line x1="11.45" y1="11.75" x2="4.18" y2="8.43"/><line x1="11.68" y1="11.50" x2="6.49" y2="3.42"/></svg>',
  accent: '#E5A647', // Lantern amber
  order: 0,
  enabled: true,
  command: ['claude'],
  processName: 'claude',
  context: { kind: 'claude-session-start' },
}
