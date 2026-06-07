import { describe, expect, it } from 'vitest'
import { terminalClientEnv } from './terminal-env'

describe('terminalClientEnv', () => {
  it('normalizes the outer PTY environment for color TUIs', () => {
    const env = terminalClientEnv({
      HOME: '/home/me',
      TERM: 'tmux-256color',
      COLORTERM: '',
      NO_COLOR: '1',
      LANG: 'C',
      LC_CTYPE: 'C',
    })

    expect(env.HOME).toBe('/home/me')
    expect(env.NO_COLOR).toBeUndefined()
    expect(env.TERM).toBe('xterm-256color')
    expect(env.COLORTERM).toBe('truecolor')
    expect(env.CLICOLOR).toBe('1')
    expect(env.LANG).toBe('en_US.UTF-8')
    expect(env.LC_CTYPE).toBe('C.UTF-8')
  })
})
