import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cone,
  type DeployDeps,
  deploy,
  installedOpsSha,
  jobResult,
  loadProject,
  NOT_HANDLED,
  type Project,
  parseDeployArgs,
  pruneReleases,
  type Refusal,
  readPackages,
  recoverSwap,
  runningSha,
  selectUnits,
  takeOver,
  touches,
  unitSources,
  withLock,
} from './deploy'
import { run } from './sh'

const repo = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')
const gitAt = (root: string) => (args: string[]) => run('git', ['-C', root, ...args]).out.trim()

describe('unit selection from package cones', () => {
  const sha = gitAt(repo)(['rev-parse', 'HEAD'])
  const packages = readPackages(gitAt(repo), sha)
  const project = loadProject(repo)
  const template = (unit: string) =>
    run('git', ['-C', repo, 'show', `${sha}:scripts/systemd/${unit}`]).out
  const changedBy = (paths: string[]) => (unit: string) =>
    touches(paths, unitSources(project, unit, template(unit), packages))
  const pick = (paths: string[], extra: Partial<Parameters<typeof selectUnits>[1]> = {}) =>
    selectUnits(
      project,
      {
        project: 'aico',
        workers: [],
        includeAllWorkers: false,
        detach: false,
        rollback: false,
        ...extra,
      },
      {
        active: () => true,
        changed: changedBy(paths),
      },
    )

  it('reads cones from workspace dependencies', () => {
    expect(cone(packages, 'jobs')).toEqual(
      expect.arrayContaining(['packages/jobs', 'packages/status', 'packages/store']),
    )
    expect(cone(packages, 'store')).toEqual(['packages/store'])
  })

  it('a store change restarts every unit built on it and flags Tether, which restarts only when named', () => {
    const selection = pick(['packages/store/src/db.ts'])
    expect(selection.restart).toEqual(['aico-web.service', 'aico-jobs.service'])
    expect(selection.stale).toEqual(['tether@default.service'])
  })

  it('a web-frontend change restarts only the unit that serves the page', () => {
    expect(pick(['packages/web-frontend/app/page.tsx'])).toEqual({
      restart: ['aico-web.service'],
      stale: [],
    })
  })

  it('a docs-only change restarts nothing; an explicit scope or worker still does', () => {
    expect(pick(['docs/notes.md']).restart).toEqual([])
    expect(pick(['docs/notes.md'], { scope: 'backend' }).restart).toEqual(['aico-web.service'])
    expect(pick(['docs/notes.md'], { scope: 'aico-jobs' }).restart).toEqual(['aico-jobs.service'])
    expect(pick(['docs/notes.md'], { workers: ['tether@default'] }).restart).toEqual([
      'tether@default.service',
    ])
  })

  it('keeps st service rebuild refusals', () => {
    expect(() => pick([], { workers: ['nope'] })).toThrow(/Unknown worker nope/)
    expect(() => pick([], { scope: 'frontend', workers: ['aico-jobs'] })).toThrow(/frontend-only/)
    expect(() => pick([], { workers: ['tether@default', 'aico-jobs'] })).toThrow(
      /manual worker deploys alone/,
    )
    expect(() => pick([], { scope: 'backend', workers: ['tether@default'] })).toThrow(
      /manual worker deploys alone/,
    )
    expect(() => pick([], { scope: 'everything' })).toThrow(/Unknown scope/)
  })

  it('passes options it does not run back to SummitFlow', () => {
    expect(parseDeployArgs(['aico', '--source-repo', '/x'])).toEqual({
      notHandled: '--source-repo',
    })
    expect(
      parseDeployArgs([
        'aico',
        '--detach',
        '--worker',
        'tether@default',
        '--acceptance',
        '/r.json',
      ]),
    ).toMatchObject({
      project: 'aico',
      detach: true,
      workers: ['tether@default'],
    })
  })

  it('knows the release a rendered unit runs', () => {
    const sha40 = 'a'.repeat(40)
    expect(runningSha(`WorkingDirectory=/r/${sha40}/packages/jobs\n`, '/r')).toBe(sha40)
    expect(
      runningSha(
        'WorkingDirectory=/home/x/.summitflow/services/projects/aico/releases/b/source\n',
        '/r',
      ),
    ).toBeNull()
  })
})

// A small project with one backend unit, deployed for real through git, with npm/systemctl/aico stubbed.
describe('deploy', () => {
  let top = ''
  afterEach(() => {
    if (top) rmSync(top, { recursive: true, force: true })
  })

  function setup(
    options: {
      accept?: (root: string, args: string[]) => number
      guard?: (args: string[]) => { code: number; out: string }
      workers?: string[]
      ops?: boolean
      kill?: (cmd: string, args: string[]) => boolean
    } = {},
  ) {
    top = mkdtempSync(join(tmpdir(), 'aico-ops-'))
    const root = join(top, 'repo')
    mkdirSync(join(root, 'packages/web-server'), { recursive: true })
    mkdirSync(join(root, 'scripts/systemd'), { recursive: true })
    writeFileSync(
      join(root, 'project.identity.json'),
      JSON.stringify({
        project: { id: 'demo', legacy_ids: [] },
        runtime: { backend_port: 3999, health_endpoint: '/health' },
        services: {
          backend: 'demo-web.service',
          default_workers: options.workers ?? [],
          manual_workers: [],
        },
      }),
    )
    writeFileSync(
      join(root, 'packages/web-server/package.json'),
      JSON.stringify({ name: '@demo/web', scripts: { build: 'x' } }),
    )
    writeFileSync(join(root, 'packages/web-server/main.ts'), 'v1\n')
    writeFileSync(
      join(root, 'scripts/systemd/demo-web.service'),
      '[Service]\nWorkingDirectory=__PROJECT_ROOT__/packages/web-server\nExecStart=node __PROJECT_ROOT__/packages/web-server/dist/x.mjs\n',
    )
    if (options.ops) {
      mkdirSync(join(root, 'packages/ops/src'), { recursive: true })
      writeFileSync(
        join(root, 'packages/ops/package.json'),
        JSON.stringify({ name: '@demo/ops', scripts: { build: 'x' } }),
      )
      writeFileSync(join(root, 'packages/ops/src/main.ts'), 'ops v1\n')
    }
    const git = (...args: string[]) => run('git', ['-C', root, ...args])
    git('init', '-q', '-b', 'main')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'one')
    const calls: string[] = []
    const lines: string[] = []
    const rows: { state: string; meaning: string }[] = []
    const deps: DeployDeps = {
      run: (cmd, args, opts) => {
        if (cmd === 'git' || cmd === 'tar' || cmd === 'cp') return run(cmd, args, opts)
        calls.push([cmd, ...args].join(' '))
        if (options.kill?.(cmd, args)) throw new Error('killed')
        if (cmd === 'aico-hook')
          return { ...(options.guard?.(args) ?? { code: 0, out: '' }), err: '' }
        if (cmd === 'aico')
          return { code: options.accept ? options.accept(root, args) : 0, out: '', err: '' }
        if (cmd === 'nice' && args.join(' ') === '-n 10 npm run build -w packages/ops') {
          mkdirSync(join(opts?.cwd as string, 'packages/ops/dist'), { recursive: true })
          writeFileSync(join(opts?.cwd as string, 'packages/ops/dist/aico-ops.mjs'), '// ops\n')
        }
        if (cmd === 'systemctl' && args[1] === 'is-active')
          return { code: 0, out: 'active\n', err: '' }
        return { code: 0, out: '', err: '' }
      },
      out: (line) => lines.push(line),
      err: (line) => lines.push(line),
      env: { AICO_HOOK_BIN: 'aico-hook', AICO_BIN: 'aico' },
      releasesDir: join(top, 'releases'),
      jobsDir: join(top, 'jobs'),
      systemdDir: join(top, 'systemd'),
      probe: async () => 200,
      sleep: async () => {},
      report: async (row) => {
        rows.push(row)
      },
      self: '/bundle.mjs',
      opsLink: join(top, 'ops'),
    }
    const head = git('rev-parse', 'HEAD').out.trim()
    return { root, git, deps, calls, lines, rows, head }
  }
  const request = (extra = {}) => ({
    project: 'demo',
    workers: [],
    includeAllWorkers: false,
    detach: false,
    rollback: false,
    ...extra,
  })

  it('deploys the commit it started on while another builder commits, never the working tree', async () => {
    const { root, git, deps, calls, rows, head } = setup({
      accept: (root) => {
        // Another builder commits during acceptance, and someone has an uncommitted edit.
        writeFileSync(join(root, 'packages/web-server/main.ts'), 'v2\n')
        run('git', [
          '-C',
          root,
          '-c',
          'user.email=t@t',
          '-c',
          'user.name=t',
          'commit',
          '-qam',
          'two',
        ])
        writeFileSync(join(root, 'packages/web-server/main.ts'), 'uncommitted\n')
        return 0
      },
    })
    expect(await deploy(request(), root, deps)).toBe(0)
    expect(git('rev-parse', 'HEAD').out.trim()).not.toBe(head)
    const release = join(deps.releasesDir, head)
    expect(readFileSync(join(release, 'packages/web-server/main.ts'), 'utf8')).toBe('v1\n')
    expect(readFileSync(join(deps.systemdDir, 'demo-web.service'), 'utf8')).toContain(
      `WorkingDirectory=${release}/packages/web-server`,
    )
    expect(calls).toContain(`aico check --acceptance --sha ${head}`)
    expect(calls).toContain('nice -n 10 npm run build -w packages/web-server')
    expect(calls).toContain('systemctl --user restart demo-web.service')
    expect(rows.at(-1)).toMatchObject({ state: 'ok', meaning: expect.stringMatching(/^Deployed /) })
  })

  it('a second deploy with no source change restarts nothing; an older commit never replaces a newer one', async () => {
    const { root, git, deps, calls, lines, head } = setup()
    writeFileSync(join(root, 'packages/web-server/main.ts'), 'v2\n')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'two')
    const newer = git('rev-parse', 'HEAD').out.trim()
    expect(await deploy(request(), root, deps)).toBe(0)
    calls.length = 0
    expect(await deploy(request(), root, deps)).toBe(0)
    expect(calls.filter((call) => call.includes('restart'))).toEqual([])
    expect(await deploy(request({ sha: head }), root, deps)).toBe(0)
    expect(lines.join('\n')).toContain(`already runs ${newer.slice(0, 12)}`)
    expect(readFileSync(join(deps.systemdDir, 'demo-web.service'), 'utf8')).toContain(newer)
  })

  it('refuses on failed acceptance or another agent hold, and answers NOT_HANDLED for other projects', async () => {
    const failing = setup({ accept: () => 1 })
    await expect(deploy(request(), failing.root, failing.deps)).rejects.toThrow(
      /Acceptance .* failed/,
    )
    expect(existsSync(join(failing.deps.systemdDir, 'demo-web.service'))).toBe(false)
    expect(failing.rows.at(-1)?.state).toBe('failed')
    rmSync(top, { recursive: true, force: true })

    const held = setup({
      guard: () => ({ code: 1, out: 'demo: hold integration by cc:other; rebuild refused' }),
    })
    await expect(deploy(request(), held.root, held.deps)).rejects.toMatchObject({
      code: 2,
    } satisfies Partial<Refusal>)
    expect(await deploy(request({ project: 'summitflow' }), held.root, held.deps)).toBe(NOT_HANDLED)
  })

  it("--detach queues a job that runs as the caller, so its acceptance sees the caller's deploy hold", async () => {
    const { root, deps, calls, head } = setup()
    deps.env = { ...deps.env, PATH: '/bin', CLAUDE_CODE_SESSION_ID: 'me', SECRET_TOKEN: 'x' }
    expect(await deploy(request({ detach: true }), root, deps)).toBe(0)
    const queued = calls.find((call) => call.startsWith('systemd-run')) ?? ''
    expect(queued).toContain('--setenv=CLAUDE_CODE_SESSION_ID=me')
    expect(queued).toContain(`deploy demo --sha ${head} --job aico-`)
    expect(queued).not.toContain('SECRET_TOKEN')
  })

  it('restores the previous unit when health fails', async () => {
    const { root, deps } = setup()
    const before = '[Service]\nWorkingDirectory=/old/packages/web-server\n'
    mkdirSync(deps.systemdDir, { recursive: true })
    writeFileSync(join(deps.systemdDir, 'demo-web.service'), before)
    deps.probe = async () => 502
    await expect(deploy(request(), root, deps)).rejects.toThrow(/previous unit files were restored/)
    expect(readFileSync(join(deps.systemdDir, 'demo-web.service'), 'utf8')).toBe(before)
    expect(existsSync(join(deps.releasesDir, '.swap.json'))).toBe(false)
  })

  // Another agent's hold; the holder's yes (an ack id) lets this rebuild through, acceptance included.
  const holdUnlessAck = (args: string[]) =>
    args.includes('--with-ack') && args[args.indexOf('--with-ack') + 1] === 'r1'
      ? { code: 0, out: '' }
      : { code: 1, out: 'demo: hold integration by cc:other; rebuild refused' }

  it('--with-ack reaches acceptance and the detached job', async () => {
    const { root, deps, calls, rows, head } = setup({
      guard: holdUnlessAck,
      accept: (_root, args) => holdUnlessAck(args).code,
    })
    expect(await deploy(request({ withAck: 'r1' }), root, deps)).toBe(0)
    expect(calls).toContain(`aico check --acceptance --sha ${head} --with-ack r1`)
    expect(rows.at(-1)?.state).toBe('ok')
    expect(await deploy(request({ detach: true, withAck: 'r1' }), root, deps)).toBe(0)
    expect(calls.find((call) => call.startsWith('systemd-run'))).toContain(
      `deploy demo --sha ${head} --job aico-`,
    )
    expect(calls.find((call) => call.startsWith('systemd-run'))).toMatch(/--with-ack r1$/)
  })

  it('a hold taken while the deploy waited refuses the swap', async () => {
    let guards = 0
    const { root, deps, calls } = setup({
      guard: () =>
        ++guards > 1
          ? { code: 1, out: 'demo: hold deploy by cc:other; rebuild refused' }
          : { code: 0, out: '' },
    })
    await expect(deploy(request(), root, deps)).rejects.toMatchObject({ code: 2 })
    expect(guards).toBe(2)
    expect(calls.filter((call) => call.includes('restart'))).toEqual([])
    expect(existsSync(join(deps.systemdDir, 'demo-web.service'))).toBe(false)
  })

  it('a deploy killed after writing the units is undone and redeployed by the next one', async () => {
    let killed = false
    const { root, deps, lines, rows } = setup({
      kill: (cmd, args) => {
        if (killed || cmd !== 'systemctl' || args[1] !== 'daemon-reload') return false
        killed = true
        return true
      },
    })
    const before = '[Service]\nWorkingDirectory=/old/packages/web-server\n'
    mkdirSync(deps.systemdDir, { recursive: true })
    writeFileSync(join(deps.systemdDir, 'demo-web.service'), before)
    await expect(deploy(request(), root, deps)).rejects.toThrow(/killed/)
    expect(readFileSync(join(deps.systemdDir, 'demo-web.service'), 'utf8')).not.toBe(before)
    expect(existsSync(join(deps.releasesDir, '.swap.json'))).toBe(true)
    // The same commit must deploy again, rather than treating the interrupted writes as deployed.
    expect(await deploy(request(), root, deps)).toBe(0)
    expect(lines.join('\n')).toMatch(/stopped mid-swap; putting back demo-web.service/)
    expect(rows.at(-1)?.meaning).toMatch(/^Deployed /)
    expect(existsSync(join(deps.releasesDir, '.swap.json'))).toBe(false)
  })

  it('keeps the swap journal when recovery fails, and checks a new hold before recovering', async () => {
    let guards = 0
    const { root, deps, calls } = setup({
      guard: () => (++guards > 1 ? { code: 1, out: 'hold deploy' } : { code: 0, out: '' }),
    })
    mkdirSync(deps.releasesDir, { recursive: true })
    const journal = join(deps.releasesDir, '.swap.json')
    writeFileSync(journal, '{broken')
    expect(() => recoverSwap(deps)).toThrow(/journal is unreadable/)
    expect(existsSync(journal)).toBe(true)
    writeFileSync(
      journal,
      JSON.stringify({ sha: 'a'.repeat(40), previous: { 'demo-web.service': 'old' } }),
    )
    await expect(deploy(request(), root, deps)).rejects.toMatchObject({ code: 2 })
    expect(calls.filter((call) => call.includes('restart'))).toEqual([])
    expect(existsSync(journal)).toBe(true)
    const original = deps.run
    deps.run = (cmd, args, opts) =>
      cmd === 'systemctl' && args[1] === 'restart'
        ? { code: 1, out: '', err: 'failed' }
        : original(cmd, args, opts)
    mkdirSync(deps.systemdDir, { recursive: true })
    expect(() => recoverSwap(deps)).toThrow(/Putting the previous units back failed/)
    expect(existsSync(journal)).toBe(true)
  })

  it('records the detached deploy failure exit code', async () => {
    const { root, deps } = setup({ accept: () => 2 })
    await deploy(request({ detach: true }), root, deps)
    const id = readdirSync(deps.jobsDir)[0].replace(/\.json$/, '')
    await expect(deploy(request({ job: id }), root, deps)).rejects.toMatchObject({ code: 2 })
    expect(await jobResult(id, true, deps)).toBe(2)
  })

  it('checks every template before writing any unit, and says nothing was changed', async () => {
    const { root, deps, rows } = setup({ workers: ['demo-worker.service'] })
    const before = '[Service]\nWorkingDirectory=/old/packages/web-server\n'
    mkdirSync(deps.systemdDir, { recursive: true })
    writeFileSync(join(deps.systemdDir, 'demo-web.service'), before)
    await expect(deploy(request(), root, deps)).rejects.toThrow(
      /demo-worker.service has no template.*Nothing was changed/s,
    )
    expect(readFileSync(join(deps.systemdDir, 'demo-web.service'), 'utf8')).toBe(before)
    expect(rows.at(-1)?.meaning).not.toMatch(/restored/)
  })

  it('removes staging a dead deploy left, under the lock', async () => {
    const { root, deps, lines } = setup()
    const dead = spawnSync('true').pid as number
    const sha = 'a'.repeat(40)
    mkdirSync(join(deps.releasesDir, `.${sha}.${dead}`), { recursive: true })
    writeFileSync(join(deps.releasesDir, `.${sha}.${dead}.tar`), '')
    mkdirSync(join(deps.releasesDir, `.${sha}.${process.pid}`), { recursive: true })
    expect(await deploy(request(), root, deps)).toBe(0)
    expect(existsSync(join(deps.releasesDir, `.${sha}.${dead}`))).toBe(false)
    expect(existsSync(join(deps.releasesDir, `.${sha}.${dead}.tar`))).toBe(false)
    expect(existsSync(join(deps.releasesDir, `.${sha}.${process.pid}`))).toBe(true)
    expect(lines.join('\n')).toContain('left by a deploy that died')
  })

  it('two waiters taking over a stale lock: only one proceeds at a time', async () => {
    const { deps } = setup()
    mkdirSync(deps.releasesDir, { recursive: true })
    const lock = join(deps.releasesDir, '.deploy.pid')
    const stale = `${spawnSync('true').pid} gone\n`
    writeFileSync(lock, stale)
    deps.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5)))
    const events: string[] = []
    let working = 0
    const work = (name: string) =>
      withLock(deps, async (held) => {
        expect(++working).toBe(1)
        events.push(`${name} in`)
        expect(held()).toBe(true)
        await new Promise((resolve) => setTimeout(resolve, 20))
        events.push(`${name} out`)
        working--
      })
    await Promise.all([work('a'), work('b')])
    const first = events[0][0]
    const second = first === 'a' ? 'b' : 'a'
    expect(events).toEqual([`${first} in`, `${first} out`, `${second} in`, `${second} out`])
    expect(existsSync(lock)).toBe(false)

    // A waiter acting on what it read before another took the stale lock over leaves the new lock alone.
    writeFileSync(lock, stale)
    expect(takeOver(lock, stale)).toBe(true)
    writeFileSync(lock, `${process.pid} first\n`, { flag: 'wx' })
    expect(takeOver(lock, stale)).toBe(false)
    expect(readFileSync(lock, 'utf8')).toBe(`${process.pid} first\n`)
  })

  it('st service wait exit codes: 1 while running, the deploy exit code when it failed', async () => {
    const { deps } = setup()
    const job = (state: string, extra = {}) =>
      writeFileSync(
        join(deps.jobsDir, 'aico-000000000001.json'),
        JSON.stringify({
          id: 'aico-000000000001',
          project: 'demo',
          sha: 'f'.repeat(40),
          state,
          argv: [],
          queued_at: '',
          ...extra,
        }),
      )
    mkdirSync(deps.jobsDir, { recursive: true })
    job('running')
    expect(await jobResult('aico-000000000001', false, deps)).toBe(1)
    job('failed', { exit_code: 2 })
    expect(await jobResult('aico-000000000001', true, deps)).toBe(2)
    job('succeeded', { exit_code: 0 })
    expect(await jobResult('aico-000000000001', true, deps)).toBe(0)
  })

  it('installs the ops bundle the commit builds, and only when its sources changed', async () => {
    const { root, git, deps, calls, lines, head } = setup({ ops: true })
    expect(await deploy(request(), root, deps)).toBe(0)
    expect(installedOpsSha(deps)).toBe(head)
    expect(existsSync(join(deps.opsLink, 'packages/ops/dist/aico-ops.mjs'))).toBe(true)
    const commit = (file: string) => {
      writeFileSync(join(root, file), `${Math.random()}\n`)
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A')
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', file)
      return git('rev-parse', 'HEAD').out.trim()
    }
    commit('docs.md')
    expect(await deploy(request(), root, deps)).toBe(0)
    expect(lines.at(-1)).toMatch(/nothing to restart/)
    expect(installedOpsSha(deps)).toBe(head)
    calls.length = 0
    const changed = commit('packages/ops/src/main.ts')
    expect(await deploy(request(), root, deps)).toBe(0)
    expect(installedOpsSha(deps)).toBe(changed)
    expect(calls.filter((call) => call.includes('restart'))).toEqual([])
    expect(lines.at(-1)).toMatch(/the deploy code only/)
  })

  it('prunes old releases but keeps the ones a unit still runs', () => {
    const { deps } = setup()
    const names = ['1', '2', '3', '4', '5'].map((c) => c.repeat(40))
    for (const [i, name] of names.entries()) {
      mkdirSync(join(deps.releasesDir, name), { recursive: true })
      utimesSync(join(deps.releasesDir, name), 1_000 + i, 1_000 + i)
    }
    mkdirSync(deps.systemdDir, { recursive: true })
    writeFileSync(
      join(deps.systemdDir, 'x.service'),
      `WorkingDirectory=${join(deps.releasesDir, names[0] as string)}/packages/a\n`,
    )
    pruneReleases(deps, join(deps.releasesDir, names[4] as string))
    const left = names.filter((name) => existsSync(join(deps.releasesDir, name)))
    expect(left).toEqual([names[0], names[2], names[3], names[4]])
  })
})

export type { Project }
