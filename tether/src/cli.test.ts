import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { attachPlan, main, parseArgs } from './cli'
import { resolvePaths } from './config'
import { type RunningDaemon, startDaemon } from './daemon'

function capture() {
  const out: string[] = []
  const err: string[] = []
  return { io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) }, out, err }
}

describe('parseArgs', () => {
  it('reads global flags and keeps argv after --', () => {
    expect(parseArgs(['--instance', 'dev', 'tools', 'add', 'x', 'X', '--', 'x', '--json'])).toEqual(
      {
        instance: 'dev',
        json: false,
        args: ['tools', 'add', 'x', 'X', '--', 'x', '--json'],
      },
    )
    expect(parseArgs(['--json', '--instance=dev', 'tools'])).toMatchObject({
      json: true,
      instance: 'dev',
    })
  })
})

describe('attachPlan', () => {
  const response = {
    argv: ['/usr/bin/tmux', '-S', '/s/server.sock', 'attach-session', '-t', '$1'],
    env: { TERM: 'xterm-256color' },
    unset: ['TMUX', 'TMUX_PANE', 'NO_COLOR'],
  }

  it('applies env overrides and removes the unset keys', () => {
    const plan = attachPlan(response, { PATH: '/bin', TERM: 'dumb', NO_COLOR: '1' })
    expect(plan.env).toEqual({ PATH: '/bin', TERM: 'xterm-256color' })
    expect(plan.argv).toEqual(response.argv)
    expect(plan.notice).toBeUndefined()
  })

  it('nests inside a different tmux server with TMUX unset and a notice', () => {
    const plan = attachPlan(response, { TMUX: '/tmp/tmux-1/default,99,0', TMUX_PANE: '%1' })
    expect(plan.env.TMUX).toBeUndefined()
    expect(plan.env.TMUX_PANE).toBeUndefined()
    expect(plan.argv[3]).toBe('attach-session')
    expect(plan.notice).toContain('/tmp/tmux-1/default')
  })

  it('switches the current client inside the same server', () => {
    const plan = attachPlan(response, { TMUX: '/s/server.sock,99,0' })
    expect(plan.argv).toEqual([
      '/usr/bin/tmux',
      '-S',
      '/s/server.sock',
      'switch-client',
      '-t',
      '$1',
    ])
    expect(plan.env.TMUX).toBe('/s/server.sock,99,0')
    expect(plan.notice).toBeUndefined()
  })
})

describe('main', () => {
  let dir: string
  let daemon: RunningDaemon
  const saved = { ...process.env }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tether-cli-'))
    Object.assign(process.env, {
      TETHER_STATE_DIR: join(dir, 'state'),
      TETHER_RUNTIME_DIR: join(dir, 'run'),
      XDG_CONFIG_HOME: join(dir, 'config'),
    })
    daemon = await startDaemon(resolvePaths({ instance: 'clitest' }), {
      TETHER_SUMMITFLOW_URL: 'off',
      TETHER_RECONCILE: 'off',
      TETHER_ATERM_LEGACY_SOCKET: join(dir, 'no-aterm', 'default'),
    })
    await daemon.ready
  })

  afterAll(async () => {
    await daemon.close()
    process.env = saved
    rmSync(dir, { recursive: true, force: true })
  })

  it('prints usage', async () => {
    const { io, out } = capture()
    expect(await main(['help'], io)).toBe(0)
    expect(out.join('\n')).toContain('tether [--instance NAME]')
  })

  it('lists and edits tools through the socket', async () => {
    const list = capture()
    expect(await main(['-i', 'clitest', 'tools'], list.io)).toBe(0)
    expect(list.out.join('\n')).toMatch(/\* codex +codex --yolo/)

    const add = capture()
    expect(
      await main(
        ['-i', 'clitest', 'tools', 'add', 'aider', 'Aider', '--', 'aider', '--yes'],
        add.io,
      ),
    ).toBe(0)
    const rm = capture()
    expect(await main(['-i', 'clitest', 'tools', 'rm', 'aider'], rm.io)).toBe(0)
  })

  it('lists an empty session catalog and dry-runs an import', async () => {
    const list = capture()
    expect(await main(['-i', 'clitest', 'sessions'], list.io)).toBe(0)
    const legacy = capture()
    expect(await main(['-i', 'clitest', 'legacy'], legacy.io)).toBe(0)
    const missing = capture()
    expect(
      await main(['-i', 'clitest', 'import-aico', '--from', join(dir, 'absent.db')], missing.io),
    ).toBe(2)
    expect(missing.err.join('\n')).toContain('not found')
  })

  it('exits 2 when the daemon is unreachable', async () => {
    const { io, err } = capture()
    const runtime = process.env.TETHER_RUNTIME_DIR
    delete process.env.TETHER_RUNTIME_DIR
    process.env.XDG_RUNTIME_DIR = join(dir, 'other-runtime')
    expect(await main(['-i', 'nobody', 'tools'], io)).toBe(2)
    process.env.TETHER_RUNTIME_DIR = runtime
    expect(err.join('\n')).toContain('not reachable')
  })
})
