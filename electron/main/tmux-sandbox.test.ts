import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TetherUnavailable } from 'tether/client'
import { describe, expect, it } from 'vitest'
import {
  attachEnvironment,
  attachFromTether,
  BWRAP_BIN,
  ownAttachTarget,
  sandboxedTmux,
  TMUX_BIN,
  tmuxClientPid,
  trustedSocket,
} from './tmux-sandbox'

const hex = 'ab'.repeat(16)
const agentSocket = `/run/tether/agent/default/tmux/${hex}/server.sock`
const env = { HOME: '/home/me' }
const ownSocket = `/home/me/.local/state/tether/default/tmux/${hex}/server.sock`

describe('trusted sockets', () => {
  it("accepts the agent instance and the caller's own instance", () => {
    expect(trustedSocket(agentSocket, env)).toBe(true)
    expect(trustedSocket(ownSocket, env)).toBe(true)
    expect(trustedSocket(ownSocket, { XDG_STATE_HOME: '/s' })).toBe(false)
    expect(
      trustedSocket(`/s/tether/default/tmux/${hex}/server.sock`, { XDG_STATE_HOME: '/s' }),
    ).toBe(true)
  })

  it.each([
    `/run/tether/agent/other/tmux/${hex}/server.sock`,
    `/run/tether/agent/default/tmux/${'ab'.repeat(15)}/server.sock`,
    `/run/tether/agent/default/tmux/${hex}/../server.sock`,
    `/run/tether/Agent/default/tmux/${hex}/server.sock`,
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
  const good = ['/usr/bin/tmux', '-S', agentSocket, 'attach-session', '-t', '$12']

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
    argv: ['/usr/bin/tmux', '-S', agentSocket, 'attach-session', '-t', '$3'],
    env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', CLICOLOR: '1' },
  }

  it("builds the argv and a fixed-key environment itself from Tether's answer", () => {
    const target = ownAttachTarget({
      ...answer,
      argv: ['/bin/sh', ...answer.argv.slice(1)],
      env: { ...answer.env, LD_PRELOAD: '/x.so', PATH: '/x', CLICOLOR: '1; id' },
    })
    expect(target).toEqual({
      generation: answer.generation,
      argv: ['/usr/bin/tmux', '-S', agentSocket, 'attach-session', '-t', '$3'],
      env: { TERM: 'xterm-256color', LANG: 'C.UTF-8', COLORTERM: 'truecolor' },
    })
    expect(attachEnvironment(target)).toEqual(target.env)
  })

  it('refuses answers that name another socket, a hostile target or extra words', () => {
    const bad = (argv: string[]) =>
      expect(() => ownAttachTarget({ ...answer, argv })).toThrow(TetherUnavailable)
    bad(['tmux', 'attach'])
    bad(['/usr/bin/tmux', '-S', '/tmp/evil.sock', 'attach-session', '-t', '$3'])
    bad(['/usr/bin/tmux', '-S', agentSocket, 'attach-session', '-t', '$3; id'])
    bad(['/usr/bin/tmux', '-S', agentSocket, 'attach-session', '-t', '-d'])
    bad([...answer.argv, '-d'])
  })
})

describe('sandbox argv', () => {
  it('shares the pid namespace, binds read-only and has no shell', () => {
    const argv = sandboxedTmux([TMUX_BIN, '-S', ownSocketIn(), 'attach-session', '-t', '$1'])
    expect(argv[0]).toBe(BWRAP_BIN)
    expect(argv).toContain('--die-with-parent')
    expect(argv).toContain('--unshare-net')
    expect(argv).not.toContain('--unshare-pid')
    expect(argv).not.toContain('--new-session')
    expect(argv).not.toContain('--bind')
    expect(argv).not.toContain('--dev-bind')
    for (const word of ['/bin', '/usr', '/usr/bin', '/bin/sh']) expect(argv).not.toContain(word)
    expect(argv.slice(-6)).toEqual([TMUX_BIN, '-S', ownSocketIn(), 'attach-session', '-t', '$1'])
  })

  it('refuses other programs and sockets', () => {
    expect(() => sandboxedTmux(['/bin/sh', '-S', agentSocket])).toThrow()
    expect(() => sandboxedTmux([TMUX_BIN, '-S', '/tmp/x.sock'])).toThrow()
    expect(() => sandboxedTmux([TMUX_BIN, 'attach-session'])).toThrow()
  })
})

function ownSocketIn(): string {
  return agentSocket
}

const bwrapWorks =
  existsSync(BWRAP_BIN) &&
  existsSync(TMUX_BIN) &&
  spawnSync(BWRAP_BIN, ['--unshare-user', '--ro-bind', '/', '/', '/usr/bin/true']).status === 0

describe.skipIf(!bwrapWorks)('sandbox run', () => {
  it('has no shell or other program inside, but tmux runs', () => {
    const state = mkdtempSync(join(tmpdir(), 'aico-sbx-'))
    const saved = process.env.XDG_STATE_HOME
    try {
      process.env.XDG_STATE_HOME = state
      const dir = join(state, 'tether', 'default', 'tmux', hex)
      mkdirSync(dir, { recursive: true })
      const argv = sandboxedTmux([TMUX_BIN, '-S', join(dir, 'server.sock'), '-V'])
      const at = argv.indexOf('--')
      for (const program of [
        '/bin/sh',
        '/usr/bin/sh',
        '/bin/bash',
        '/usr/bin/env',
        '/usr/bin/id',
      ]) {
        const run = spawnSync(argv[0], [...argv.slice(1, at), '--', program, '-c', 'true'])
        expect(run.status, program).not.toBe(0)
      }
      const version = execFileSync(argv[0], argv.slice(1), {
        encoding: 'utf8',
        env: { TERM: 'xterm' },
      })
      expect(version).toMatch(/^tmux /)
    } finally {
      if (saved === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = saved
      rmSync(state, { recursive: true, force: true })
    }
  })

  it('finds the tmux child bubblewrap forks', async () => {
    const { spawn } = await import('node:child_process')
    const child = spawn(BWRAP_BIN, [
      '--ro-bind',
      '/usr',
      '/usr',
      '--symlink',
      'usr/lib',
      '/lib',
      '--symlink',
      'usr/lib64',
      '/lib64',
      '/usr/bin/sleep',
      '5',
    ])
    try {
      const pid = await tmuxClientPid(child.pid ?? -1)
      expect(pid).not.toBe(child.pid)
      expect(pid).toBeGreaterThan(child.pid ?? 0)
    } finally {
      child.kill()
    }
  })
})
