import { describe, expect, it } from 'vitest'
import { sanitizeTerminalText } from './terminal-text'

describe('sanitizeTerminalText', () => {
  it('collapses C0, ESC, CR/LF, DEL, and C1 runs to ordinary spaces', () => {
    expect(sanitizeTerminalText('one\r\n\u001b[31mred\u007f\u0085two')).toBe('one [31mred two')
  })

  it('preserves printable shell metacharacters as editable text', () => {
    expect(sanitizeTerminalText('echo "$(whoami)"; rm -rf /')).toBe('echo "$(whoami)"; rm -rf /')
  })
})
