type XtermATerm = InstanceType<typeof import('@xterm/xterm').Terminal>

export function getATermBufferLines(term: XtermATerm | null): string[] {
  if (!term) return []
  const buffer = term.buffer.active
  const lines: string[] = []
  for (let i = 0; i <= buffer.baseY + buffer.cursorY; i++) {
    const line = buffer.getLine(i)
    if (line) lines.push(line.translateToString(true))
  }
  return lines
}

/** Extract all visible buffer lines as a newline-joined string. */
export function getATermContent(term: XtermATerm | null): string {
  return getATermBufferLines(term).join('\n')
}

/**
 * Return the text on the current cursor line, with leading prompt stripped.
 * Strips common prompt patterns (e.g. `user@host:~$ `).
 */
export function getATermLastLine(term: XtermATerm | null): string {
  if (!term) return ''
  const buffer = term.buffer.active
  const cursorY = buffer.cursorY + buffer.viewportY
  const line = buffer.getLine(cursorY)
  if (!line) return ''
  let text = line.translateToString(true)
  // Remove common prompt patterns (e.g., "user@host:~$ ")
  text = text.replace(/^.*?[#$%>]\s*/, '')
  return text.trim()
}
