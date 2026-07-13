// Text crossing an untrusted integration boundary must never be able to emit
// terminal control sequences. Replace each contiguous C0/C1 control run with a
// single ordinary space; printable text (including shell metacharacters) stays
// untouched so the user can review and edit it before submitting anything.
export function sanitizeTerminalText(value: unknown): string {
  let cleaned = ''
  let replacingControlRun = false

  for (const character of String(value ?? '')) {
    const codePoint = character.codePointAt(0) ?? 0
    const isTerminalControl = codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
    if (isTerminalControl) {
      if (!replacingControlRun) cleaned += ' '
      replacingControlRun = true
      continue
    }
    cleaned += character
    replacingControlRun = false
  }

  return cleaned
}
