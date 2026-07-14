import type { TuiSpec } from '../spec'

/** Codex CLI — proves the non-Claude path. `processName` is kept because Codex
 * leaves the pane's current command as the shell, so pane-metadata detection
 * (when added) must fall back to the TTY process list. Mandates inject via the
 * codex launcher's `model_instructions_file` (verified by context.ts `codex-hooks`).
 * Aico is an operator-owned autonomous workspace, so new widgets retain the
 * established no-prompt execution default explicitly in their launch argv. */
export const codexTui: TuiSpec = {
  slug: 'codex',
  displayName: 'Codex',
  // OpenAI-style hexafoil blossom (three crossed lenses).
  icon: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.4"><ellipse cx="12" cy="12" rx="3.5" ry="9.4" transform="rotate(0 12 12)"/><ellipse cx="12" cy="12" rx="3.5" ry="9.4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="3.5" ry="9.4" transform="rotate(120 12 12)"/></svg>',
  accent: '#10A37F', // teal
  order: 1,
  enabled: true,
  command: ['codex', '--yolo', '--dangerously-bypass-hook-trust'],
  processName: 'codex',
  context: { kind: 'codex-hooks' },
}
