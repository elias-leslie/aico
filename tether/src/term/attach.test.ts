import { describe, expect, it } from 'vitest'
import { TetherUnavailable } from '../client/index'
import { attachEnvironment, attachFromTether, ownAttachTarget, trustedSocket } from './attach'

const hex = 'ab'.repeat(16)
const env = { HOME: '/home/me' }
const ownSocket = `/home/me/.local/state/tether/default/tmux/${hex}/server.sock`

describe('trusted sockets', () => {
  it("accepts the caller's own instances", () => {
    expect(trustedSocket(ownSocket, env)).toBe(true)
    expect(trustedSocket(ownSocket.replace('/default/', '/p3test/'), env)).toBe(true)
    expect(trustedSocket(ownSocket, { XDG_STATE_HOME: '/s' })).toBe(false)
    expect(
      trustedSocket(`/s/tether/default/tmux/${hex}/server.sock`, { XDG_STATE_HOME: '/s' }),
    ).toBe(true)
  })

  it.each([
    // The retired agent-user Tether's runtime tree is no longer trusted.
    `/run/tether/agent/default/tmux/${hex}/server.sock`,
    `/home/me/.local/state/tether/default/tmux/${'ab'.repeat(15)}/server.sock`,
    `/home/me/.local/state/tether/default/tmux/${hex}/../server.sock`,
    `/home/me/.local/state/tether/Default/tmux/${hex}/server.sock`,
    `/home/other/.local/state/tether/default/tmux/${hex}/server.sock`,
    '/tmp/x.sock',
    undefined,
  ])('refuses %s', (path) => {
    expect(trustedSocket(path, env)).toBe(false)
  })
})

describe('attach answer', () => {
  const answer = (argv: string[], tetherEnv: Record<string, string> = {}) => ({
    argv,
    env: tetherEnv,
  })
  const good = ['/usr/bin/tmux', '-S', ownSocket, 'attach-session', '-t', '$12']

  it('rebuilds the argv and allows only three environment keys', () => {
    const built = attachFromTether(
      answer(['/bin/sh', ...good.slice(1)], {
        TERM: 'tmux-256color',
        COLORTERM: 'truecolor',
        LD_PRELOAD: '/x.so',
        CLICOLOR: '1; id',
      }),
      env,
    )
    expect(built.argv).toEqual(good)
    expect(built.env).toEqual({ TERM: 'tmux-256color', LANG: 'C.UTF-8', COLORTERM: 'truecolor' })
  })

  it.each(['', '$1; rm -rf /', 'a b', '-d', 'x'.repeat(65), '$(id)', 'a\nb'])(
    'refuses target %j',
    (target) => {
      expect(() => attachFromTether(answer([...good.slice(0, 5), target]), env)).toThrow()
    },
  )
})

describe('attach target', () => {
  const answer = {
    generation: 'a'.repeat(64),
    argv: ['/usr/bin/tmux', '-S', ownSocket, 'attach-session', '-t', '$3'],
    env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', CLICOLOR: '1' },
  }

  it("builds the argv and a fixed-key environment itself from Tether's answer", () => {
    const target = ownAttachTarget(
      {
        ...answer,
        argv: ['/bin/sh', ...answer.argv.slice(1)],
        env: { ...answer.env, LD_PRELOAD: '/x.so', PATH: '/x', CLICOLOR: '1; id' },
      },
      env,
    )
    expect(target).toEqual({
      generation: answer.generation,
      argv: ['/usr/bin/tmux', '-S', ownSocket, 'attach-session', '-t', '$3'],
      env: { TERM: 'xterm-256color', LANG: 'C.UTF-8', COLORTERM: 'truecolor' },
    })
    expect(attachEnvironment(target)).toEqual(target.env)
  })

  it('refuses answers that name another socket, a hostile target or extra words', () => {
    const bad = (argv: string[]) =>
      expect(() => ownAttachTarget({ ...answer, argv }, env)).toThrow(TetherUnavailable)
    bad(['tmux', 'attach'])
    bad(['/usr/bin/tmux', '-S', '/tmp/evil.sock', 'attach-session', '-t', '$3'])
    bad(['/usr/bin/tmux', '-S', ownSocket, 'attach-session', '-t', '$3; id'])
    bad(['/usr/bin/tmux', '-S', ownSocket, 'attach-session', '-t', '-d'])
    bad([...answer.argv, '-d'])
    bad([
      '/usr/bin/tmux',
      '-S',
      `/run/tether/agent/default/tmux/${hex}/server.sock`,
      'attach',
      '-t',
      '$3',
    ])
  })
})
