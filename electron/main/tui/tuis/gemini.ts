import type { TuiSpec } from '../spec'

/** Gemini CLI — Google's terminal coding agent (a-term parity). Mandates inject
 * via a native SessionStart hook installed by scripts/aico-install-context-hooks.sh. */
export const geminiTui: TuiSpec = {
  slug: 'gemini',
  displayName: 'Gemini CLI',
  // Four-point concave sparkle — Gemini's mark.
  icon: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M12 1.5 C12.9 8.4 15.6 11.1 22.5 12 C15.6 12.9 12.9 15.6 12 22.5 C11.1 15.6 8.4 12.9 1.5 12 C8.4 11.1 11.1 8.4 12 1.5 Z"/></svg>',
  accent: '#7E9B5F', // sage / olive
  order: 3,
  enabled: true,
  command: ['gemini'],
  processName: 'gemini',
  context: { kind: 'gemini-hooks' },
}
