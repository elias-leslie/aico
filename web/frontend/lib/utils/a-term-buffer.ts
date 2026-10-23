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
