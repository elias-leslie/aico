import type { TuiSpec } from '../spec'

/** Codex CLI — proves the non-Claude path. The canonical launcher uses additive
 * developer_instructions for lossless context; trusted native
 * SessionStart/SubagentStart hooks bind that delivery to real IDs. Aico retains
 * the established no-prompt execution default and never bypasses hook trust. */
export const codexTui: TuiSpec = {
  slug: 'codex',
  displayName: 'Codex',
  // OpenAI-style hexafoil blossom (three crossed lenses).
  icon: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.4"><ellipse cx="12" cy="12" rx="3.5" ry="9.4" transform="rotate(0 12 12)"/><ellipse cx="12" cy="12" rx="3.5" ry="9.4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="3.5" ry="9.4" transform="rotate(120 12 12)"/></svg>',
  accent: '#10A37F', // teal
  order: 1,
  enabled: true,
  command: ['codex', '--yolo'],
  processName: 'codex',
  context: { kind: 'codex-hooks' },
}
