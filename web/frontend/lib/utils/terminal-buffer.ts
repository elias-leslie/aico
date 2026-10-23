type XtermTerminal = InstanceType<typeof import('@xterm/xterm').Terminal>

export function getTerminalBufferLines(term: XtermTerminal | null): string[] {
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
export function getTerminalContent(term: XtermTerminal | null): string {
  return getTerminalBufferLines(term).join('\n')
}
