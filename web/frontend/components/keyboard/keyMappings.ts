// Terminal escape sequences for special keys
export const KEY_SEQUENCES = {
  // Control keys
  ESC: '\x1b',
  TAB: '\t',
  SHIFT_TAB: '\x1b[Z',
  ENTER: '\r',
  BACKSPACE: '\x7f',
  DELETE: '\x1b[3~',

  // Arrow keys (ANSI escape sequences)
  ARROW_UP: '\x1b[A',
  ARROW_DOWN: '\x1b[B',
  ARROW_RIGHT: '\x1b[C',
  ARROW_LEFT: '\x1b[D',

  // Navigation keys
  HOME: '\x1b[H',
  END: '\x1b[F',
  PAGE_UP: '\x1b[5~',
  PAGE_DOWN: '\x1b[6~',

  // Function keys
  F1: '\x1bOP',
  F2: '\x1bOQ',
  F3: '\x1bOR',
  F4: '\x1bOS',
  F5: '\x1b[15~',
  F6: '\x1b[17~',
  F7: '\x1b[18~',
  F8: '\x1b[19~',
  F9: '\x1b[20~',
  F10: '\x1b[21~',
  F11: '\x1b[23~',
  F12: '\x1b[24~',
} as const

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
