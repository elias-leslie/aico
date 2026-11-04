import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
  loadProject,
  NOT_HANDLED,
  type Project,
  parseDeployArgs,
  pruneReleases,
  type Refusal,
  readPackages,
  runningSha,
  selectUnits,
  touches,
  unitSources,
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
    options: { accept?: (root: string) => number; guard?: { code: number; out: string } } = {},
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
        services: { backend: 'demo-web.service', default_workers: [], manual_workers: [] },
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
        if (cmd === 'aico-hook')
          return { code: options.guard?.code ?? 0, out: options.guard?.out ?? '', err: '' }
        if (cmd === 'aico')
          return { code: options.accept ? options.accept(root) : 0, out: '', err: '' }
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
      guard: { code: 1, out: 'demo: hold integration by cc:other; rebuild refused' },
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
