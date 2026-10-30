// Terminal escape sequences for the phone key row
export const KEY_SEQUENCES = {
  ESC: '\x1b',
  TAB: '\t',
  ENTER: '\r',
  BACKSPACE: '\x7f',
} as const

/**
 * Empties the prompt box of Claude Code, Codex, Pi and a shell: end of line,
 * then Ctrl+U until nothing is left. Ctrl+U kills to the start of the line and,
 * at the start, joins the line above, so a typed multi-line prompt takes two
 * per line; a long paste is one placeholder. Checked live 2026-10-30. Ctrl+C
 * also clears these prompts but interrupts a running agent.
 */
export const CLEAR_PROMPT = `\x05${'\x15'.repeat(32)}`

export type ArrowDirection = 'left' | 'up' | 'down' | 'right'

/** Xterm CSI modifier encoding for terminal arrow keys. */
export function arrowSequence(
  direction: ArrowDirection,
  modifiers: { shift?: boolean; ctrl?: boolean; alt?: boolean } = {},
): string {
  const suffix = { up: 'A', down: 'B', right: 'C', left: 'D' }[direction]
  const parameter =
    1 +
    (modifiers.shift ? 1 : 0) +
    (modifiers.alt ? 2 : 0) +
    (modifiers.ctrl ? 4 : 0)
  return parameter === 1 ? `\x1b[${suffix}` : `\x1b[1;${parameter}${suffix}`
}

/** The control character a Ctrl+letter sends (Ctrl+C is \x03). */
export function ctrlLetter(letter: string): string {
  return String.fromCharCode(letter.toLowerCase().charCodeAt(0) - 96)
}
