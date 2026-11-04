import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { controlSocketPath, FLEET_BIN, shellQuote, tmuxIndex } from './remote'

describe('shellQuote', () => {
  it.each(['$3', "a'b", '$(id)', '`id`', 'a b', '', '%12', '\\n', 'ü'])(
    'a POSIX shell reads %j back unchanged',
    (word) => {
      expect(execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(word)}`]).toString()).toBe(word)
    },
  )
})

describe('controlSocketPath', () => {
  it("is the link's master under the runtime dir", () => {
    expect(controlSocketPath('w', { XDG_RUNTIME_DIR: '/run/user/7' })).toBe(
      '/run/user/7/tether/peers/w/exec.sock',
    )
  })
})

describe('tmuxIndex', () => {
  it('finds tmux first locally and after ssh -- remotely', () => {
    expect(tmuxIndex(['tmux', '-S', 's'])).toBe(0)
    expect(tmuxIndex([FLEET_BIN, 'fleet', 'exec', '/x/tmux', '--', 'env', '/usr/bin/tmux'])).toBe(6)
    expect(() => tmuxIndex([FLEET_BIN, 'h', 'tmux'])).toThrow()
  })
})
