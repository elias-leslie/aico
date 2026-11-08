import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePaths } from '@aico/session-engine/paths'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { attachPlan, main, parseArgs, render, sessionLine, shareBody } from './cli'
import { callSocket } from './client'
import { type RunningDaemon, startDaemon } from './daemon'
import { VERSION } from './version'

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

describe('shareBody', () => {
  const env = { AICO_WIDGET_ID: 'aico-widget-0123abcd' }

  it("shares files from the pane's own session, relative paths from here", () => {
    expect(
      shareBody(['notes.md', '/tmp/prompt.txt', '--title', 'Image and prompt'], env, '/work'),
    ).toEqual({
      session: '0123abcd',
      title: 'Image and prompt',
      paths: ['/work/notes.md', '/tmp/prompt.txt'],
    })
  })

  it('reads the session from a bare widget id, as panes set it', () => {
    expect(shareBody(['/tmp/a'], { AICO_WIDGET_ID: '0f442411' }, '/')).toMatchObject({
      session: '0f442411',
    })
  })

  it('shares a link, and takes an explicit session', () => {
    expect(shareBody(['--url=https://example.com', '--session', 'ffffffff'], env, '/')).toEqual({
      session: 'ffffffff',
      url: 'https://example.com',
    })
  })

  it('leaves the session out outside an Aico pane', () => {
    expect(shareBody(['a.txt'], {}, '/w')).toEqual({ paths: ['/w/a.txt'] })
  })

  it.each([[[]], [['a.txt', '--url', 'https://example.com']], [['--title']]])(
    'refuses %j',
    (args) => {
      expect(typeof shareBody(args, env, '/')).toBe('string')
    },
  )
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
      AICO_TASKS_DB: '/nonexistent/aico/tasks.db',
      // A standalone machine, not this host's live fleet link.
      AICO_FLEET_CONFIG: join(dir, 'no-fleet.json'),
      TETHER_RECONCILE: 'off',
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

  it.each([
    ['serve'],
    ['doctor'],
    ['version'],
    ['sessions'],
    ['sessions', 'create'],
    ['sessions', 'show'],
    ['sessions', 'end'],
    ['sessions', 'attach'],
    ['reboot', 'prepare'],
    ['recovery', 'status'],
    ['import-aico'],
    ['roots'],
    ['share'],
    ['ask', 'create'],
    ['history', 'list'],
    ['history', 'show'],
    ['capture', 'list'],
    ['note', 'add'],
    ['tools'],
    ['projects'],
    ['hosts'],
    ['fleet', 'identity'],
  ])('%s %s --help prints that command and does nothing else', async (...words) => {
    for (const flag of ['--help', '-h']) {
      const { io, out, err } = capture()
      expect(await main(['-i', 'clitest', ...words.filter(Boolean), flag], io)).toBe(0)
      expect(err).toEqual([])
      const text = out.join('\n')
      expect(text).toMatch(/Usage/)
      if (
        ['sessions', 'reboot', 'recovery', 'roots', 'tools', 'share'].includes(words[0] as string)
      )
        expect(text).toContain(`  ${words[0]}`)
      expect(text).not.toContain('Aico window')
    }
  })

  it('narrows help to one subcommand', async () => {
    const { io, out } = capture()
    expect(await main(['sessions', 'create', '--help'], io)).toBe(0)
    expect(out.join('\n')).toContain('sessions create [--tool T]')
    expect(out.join('\n')).toContain('--continue-from ID')
    expect(out.join('\n')).not.toContain('sessions end')
  })

  it('creates a session in one line; --json gives the record', () => {
    expect(
      sessionLine({
        id: 'abcd1234',
        label: 'Session 3',
        tool: 'codex',
        projectId: 'aico',
        status: 'starting',
        state: 'idle',
      }),
    ).toBe('abcd1234  Session 3  codex in aico, starting (idle)')
  })

  it('refuses the retired sessions show with what to do instead', async () => {
    const { io, err } = capture()
    expect(await main(['-i', 'clitest', 'sessions', 'show', 'abcd1234'], io)).toBe(2)
    expect(err.join('\n')).toContain('tether sessions attach')
  })

  it('rejects an incomplete recovery booking before sending a resume', async () => {
    const { io, err } = capture()
    expect(
      await main(['-i', 'clitest', 'recovery', 'resume', 'abcd1234', '--mem-bytes', '1024'], io),
    ).toBe(2)
    expect(err.join('\n')).toContain('both --mem-bytes and --cpus')
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

  it('shares, then removes entries by ID; an unknown ID exits 1 and the rest still go', async () => {
    const link = (url: string) =>
      callSocket(resolvePaths({ instance: 'clitest' }).socket, 'POST', '/v1/show', { url })
    const a = (await link('https://example.com/a')).body as { id: string }
    const b = (await link('https://example.com/b')).body as { id: string }
    const shared = capture()
    expect(
      await main(['-i', 'clitest', 'share', '--url', 'https://example.com/c'], shared.io),
    ).toBe(0)
    expect(shared.out.join('\n')).toMatch(/tether share remove [0-9a-f]{12}/)
    expect(shared.out.join('\n')).toContain('quietly')
    expect(shared.out.join('\n')).toContain('only if they truly need to')

    const listing = capture()
    expect(await main(['-i', 'clitest', 'share', 'list'], listing.io)).toBe(0)
    expect(listing.out.join('\n')).toContain(`${a.id}  https://example.com/a`)
    const coded = await link('https://u:p@example.com/signin?code=abc#frag')
    const withCode = capture()
    expect(await main(['-i', 'clitest', 'share', 'list', '--all'], withCode.io)).toBe(0)
    expect(withCode.out[0]).toBe(`${(coded.body as { id: string }).id}  https://example.com/signin`)
    const asJson = capture()
    expect(await main(['-i', 'clitest', '--json', 'share', 'list'], asJson.io)).toBe(0)
    expect(asJson.out.join('\n')).toContain('https://example.com/signin')
    expect(asJson.out.join('\n')).not.toContain('code=abc')
    expect(asJson.out.join('\n')).not.toContain('u:p')
    const twoAts = await link('https://me@corp.com:hunter2@example.com/x')
    const atsListed = capture()
    expect(await main(['-i', 'clitest', 'share', 'list', '--all'], atsListed.io)).toBe(0)
    expect(atsListed.out.join('\n')).not.toContain('hunter2')
    await main(
      ['-i', 'clitest', 'share', 'remove', (twoAts.body as { id: string }).id],
      capture().io,
    )
    await main(
      ['-i', 'clitest', 'share', 'remove', (coded.body as { id: string }).id],
      capture().io,
    )

    const none = capture()
    expect(await main(['-i', 'clitest', 'share', 'remove'], none.io)).toBe(2)

    const removal = capture()
    expect(
      await main(['-i', 'clitest', 'share', 'remove', a.id, '000000000000', b.id], removal.io),
    ).toBe(1)
    expect(removal.out).toEqual([`Removed ${a.id}`, 'No share 000000000000', `Removed ${b.id}`])
    expect(removal.err.join('\n')).toContain('no such share: 000000000000')
    const left = (
      await callSocket(resolvePaths({ instance: 'clitest' }).socket, 'GET', '/v1/shares')
    ).body as {
      items: { id: string }[]
    }
    expect(left.items.map((item) => item.id)).not.toContain(a.id)
    expect(left.items.map((item) => item.id)).not.toContain(b.id)
    expect(left.items).toHaveLength(1)
  })

  it('lists an empty session catalog and dry-runs an import', async () => {
    const list = capture()
    expect(await main(['-i', 'clitest', 'sessions'], list.io)).toBe(0)
    const missing = capture()
    expect(
      await main(['-i', 'clitest', 'import-aico', '--from', join(dir, 'absent.db')], missing.io),
    ).toBe(2)
    expect(missing.err.join('\n')).toContain('not found')
  })

  it('refuses import-aico without an explicit --from, even when the old Aico catalog exists', async () => {
    const home = process.env.HOME
    const fakeHome = join(dir, 'home-with-aico-db')
    mkdirSync(join(fakeHome, '.local', 'state', 'aico'), { recursive: true })
    writeFileSync(join(fakeHome, '.local', 'state', 'aico', 'aico.db'), '')
    process.env.HOME = fakeHome
    try {
      for (const argv of [['import-aico'], ['import-aico', '--apply']]) {
        const run = capture()
        expect(await main(['-i', 'clitest', ...argv], run.io)).toBe(2)
        const err = run.err.join('\n')
        expect(err).toContain('--from')
        expect(err).not.toContain('not found')
        expect(run.out).toEqual([])
      }
    } finally {
      process.env.HOME = home
    }
  })

  it('prints only JSON for --json version, with or without a daemon', async () => {
    const up = capture()
    expect(await main(['-i', 'clitest', '--json', 'version'], up.io)).toBe(0)
    const body = JSON.parse(up.out.join('\n'))
    expect(body.cli).toBe(VERSION)
    expect(body.apiVersion).toBeGreaterThanOrEqual(1)
    const down = capture()
    const runtime = process.env.TETHER_RUNTIME_DIR
    const xdg = process.env.XDG_RUNTIME_DIR
    delete process.env.TETHER_RUNTIME_DIR
    process.env.XDG_RUNTIME_DIR = join(dir, 'other-runtime')
    const code = await main(['-i', 'nobody', '--json', 'version'], down.io)
    process.env.TETHER_RUNTIME_DIR = runtime
    process.env.XDG_RUNTIME_DIR = xdg
    expect(code).toBe(2)
    expect(JSON.parse(down.out.join('\n'))).toEqual({
      cli: VERSION,
      daemon: null,
      error: 'not_reachable',
    })
    expect(down.err.join('\n')).toContain('not reachable')
  })

  it('names the problem for a typo, a missing id and an unknown session', async () => {
    const said = async (...argv: string[]) => {
      const { io, err, out } = capture()
      const code = await main(['-i', 'clitest', ...argv], io)
      return { code, err: err.join('\n'), out: out.join('\n') }
    }
    const typo = await said('sesions', 'list')
    expect(typo).toMatchObject({ code: 2, out: '' })
    expect(typo.err).toBe(
      'tether: unknown command sesions (did you mean sessions?); tether --help lists them',
    )
    const sub = await said('sessions', 'lst')
    expect(sub.err).toContain('tether sessions: unknown subcommand lst (did you mean list?)')
    expect(sub.err.split('\n')).toHaveLength(1)
    const noId = await said('sessions', 'end')
    expect(noId.code).toBe(2)
    expect(noId.err).toContain(
      'tether sessions end: needs a session id (tether sessions list shows them)',
    )
    expect(noId.err).not.toContain('serve')
    for (const argv of [
      ['sessions', 'end', '99191edc'],
      ['sessions', 'get', '99191edc'],
      ['sessions', 'attach', '99191edc'],
    ]) {
      const unknown = await said(...argv)
      expect(unknown).toMatchObject({ code: 1, out: '' })
      expect(unknown.err).toBe(
        'No session 99191edc (ended or never existed); tether sessions list shows the live ones',
      )
    }
    const json = await said('--json', 'sessions', 'end', '99191edc')
    expect(json.code).toBe(1)
    expect(json.out).toContain('not_found')
  })

  it('says so when there are no sessions or hosts', async () => {
    const list = capture()
    expect(await main(['-i', 'clitest', 'sessions', 'list'], list.io)).toBe(0)
    const short = capture()
    expect(await main(['-i', 'clitest', 'list'], short.io)).toBe(0)
    expect(short.out).toEqual(list.out)
    expect(list.out).toEqual(['No live sessions. Start one: tether sessions create'])
    const hosts = capture()
    expect(await main(['-i', 'clitest', 'hosts'], hosts.io)).toBe(0)
    expect(hosts.out).toEqual(['No other machines are linked.'])
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

describe('tether sessions', () => {
  it('lists with a header, words for the states and what the columns mean', () => {
    const out: string[] = []
    const io = { out: (line: string) => out.push(line), err: () => {} }
    render(io as never, false, 200, {
      items: [
        {
          id: 'fa41c0c8',
          generation: 'g',
          status: 'running',
          state: 'blocked',
          tool: 'claude-code',
          projectId: 'aico',
          label: 'Session 36',
        },
        {
          id: '0123abcd',
          generation: 'g',
          status: 'running',
          state: 'unknown',
          tool: 'codex',
          name: 'x',
        },
      ],
    })
    expect(out[0]).toMatch(/^ID +STATUS +STATE +TOOL +PROJECT +NAME$/)
    expect(out[1]).toMatch(/^fa41c0c8 +running +needs you +claude-code +aico +Session 36$/)
    expect(out[2]).toMatch(/^0123abcd +running +- +codex +- +x$/)
    expect(out[3]).toContain('STATE is the agent in it')
    expect(out.join('\n')).not.toContain('undefined')
  })
})

describe('tether hosts', () => {
  it('prints each host with a header, its link state and last update', () => {
    const out: string[] = []
    const io = { out: (line: string) => out.push(line), err: () => {} }
    render(io as never, false, 200, {
      items: [
        {
          name: 'neri-hunters',
          ssh: 'neri-hunters',
          state: 'live',
          sessions: 2,
          apiVersion: 27,
          update: null,
        },
        {
          name: 'laptop',
          ssh: 'laptop',
          state: 'powered_off',
          sessions: 0,
          apiVersion: null,
          update: { state: 'failed', error: 'the host has no flock' },
        },
      ],
    })
    expect(out[0]).toMatch(/^HOST +LINK +SESSIONS +UPDATE$/)
    expect(out[1]).toMatch(/^neri-hunters +live +2 +-$/)
    expect(out[2]).toContain('failed: the host has no flock')
    expect(out.join('\n')).not.toMatch(/undefined|api/)
  })
})
