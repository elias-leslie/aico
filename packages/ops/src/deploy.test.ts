import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import ops from '../data/ops.json' with { type: 'json' }
import {
  ACCEPTED,
  cone,
  configApiVersion,
  type DeployDeps,
  defaultDeps,
  deploy,
  frontendSpec,
  installedOpsSha,
  jobResult,
  loadProject,
  NOT_HANDLED,
  type Project,
  parseDeployArgs,
  peerPackages,
  prepareRelease,
  procPaths,
  pruneReleases,
  type Refusal,
  readPackages,
  recoverSwap,
  runningSha,
  selectUnits,
  servesLink,
  takeOver,
  touches,
  unitSources,
  withLock,
} from './deploy'
import { run } from './sh'

const repo = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')
const gitAt = (root: string) => (args: string[]) => run('git', ['-C', root, ...args]).out.trim()

/** A pid nothing is running as: a short-lived child's, rechecked in case the number was reused. */
function deadPid(): number {
  for (;;) {
    const pid = spawnSync('true').pid as number
    try {
      process.kill(pid, 0)
    } catch {
      return pid
    }
  }
}

/** How many `flock` processes hold or are queued on this lock file right now (the holder stays alive beside its command). */
function lockClaimants(path: string): () => number {
  return () =>
    readdirSync('/proc').filter((entry) => {
      if (!/^\d+$/.test(entry)) return false
      try {
        const args = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0')
        return args[0].endsWith('flock') && args.includes(path)
      } catch {
        return false
      }
    }).length
}

/** Polls a real condition; the test's own timeout is the only bound. */
async function until(condition: () => boolean) {
  while (!condition()) await new Promise((resolve) => setTimeout(resolve, 2))
}

it('discovers the user bus for every deploy command, preserving explicit settings', () => {
  const runtime = `/run/user/${process.getuid?.() ?? 0}`
  const env = defaultDeps({}).env
  expect(env.XDG_RUNTIME_DIR).toBe(runtime)
  expect(env.DBUS_SESSION_BUS_ADDRESS).toBe(`unix:path=${runtime}/bus`)
  const explicit = {
    XDG_RUNTIME_DIR: '/run/test-user',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/test-bus',
  }
  expect(defaultDeps(explicit).env).toMatchObject(explicit)
})

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

  it('a store change restarts every unit built on it, Tether included', () => {
    const selection = pick(['packages/store/src/db.ts'])
    expect(selection.restart).toEqual([
      'aico-web.service',
      'aico-jobs.service',
      'tether@default.service',
    ])
    expect(selection.auto).toEqual(['tether@default.service'])
  })

  it('a packages/tether change restarts Tether', () => {
    const selection = pick(['packages/tether/src/config.ts'])
    expect(selection.restart).toEqual(['tether@default.service'])
    expect(selection.auto).toEqual(['tether@default.service'])
  })

  it('no Tether change leaves Tether running', () => {
    const selection = pick(['packages/web-frontend/app/page.tsx'])
    expect(selection).toEqual({ restart: ['aico-web.service'], auto: [], stale: [] })
  })

  it('a daemon behind the release restarts even when its sources did not change', () => {
    const behind = (unit: string) => unit === 'tether@default.service'
    const select = (scope?: string) =>
      selectUnits(
        project,
        {
          project: 'aico',
          workers: [],
          includeAllWorkers: false,
          detach: false,
          rollback: false,
          scope,
        },
        { active: () => true, changed: changedBy([]), behind },
      )
    expect(select().restart).toEqual(['tether@default.service'])
    expect(select('backend').restart).toEqual(['aico-web.service', 'tether@default.service'])
  })

  it('a frontend-only or single-unit scope leaves a changed Tether running and flags it', () => {
    const selection = pick(['packages/tether/src/config.ts'], { scope: 'frontend' })
    expect(selection.restart).toEqual(['aico-web.service'])
    expect(selection.stale).toEqual(['tether@default.service'])
    expect(pick(['packages/tether/src/config.ts'], { scope: 'aico-jobs' }).restart).toEqual([
      'aico-jobs.service',
    ])
  })

  it('reads the API version from a release and the running daemon', () => {
    expect(configApiVersion('x\nexport const API_VERSION = 31\n')).toBe(31)
    expect(configApiVersion('nothing')).toBeNull()
  })
  it('every package the scheduler job commands run restarts it', () => {
    // Jobs run web-server/scripts/aico, which dispatches to these bundles in the same release.
    const script = ['scripts/aico', 'scripts/lib/aico-web.sh']
      .map((file) => readFileSync(`${repo}/packages/web-server/${file}`, 'utf8'))
      .join('\n')
    const bundles = [...script.matchAll(/packages\/([a-z-]+)\b/g)].map((m) => m[1])
    expect(bundles).toEqual(expect.arrayContaining(['checks', 'ops', 'web-server']))
    for (const dir of new Set(bundles))
      expect(pick([`packages/${dir}/src/x.ts`]).restart, dir).toContain('aico-jobs.service')
    expect(pick(['packages/checks/src/publish.ts']).restart).toContain('aico-jobs.service')
  })

  it('context and usage changes restart the scheduler that calls their CLI bundle', () => {
    expect(pick(['packages/context/src/db.ts']).restart).toContain('aico-jobs.service')
    expect(pick(['packages/usage/src/db.ts']).restart).toContain('aico-jobs.service')
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
      acceptOut?: string
      guard?: (args: string[]) => { code: number; out: string }
      workers?: string[]
      ops?: boolean
      cli?: boolean
      hostSteward?: boolean
      /** demo-web serves packages/web-frontend's build: from its link when 'link', else its own. */
      frontend?: 'link' | 'bundled'
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
    if (options.cli) {
      mkdirSync(join(root, 'packages/cli/src'), { recursive: true })
      writeFileSync(
        join(root, 'packages/cli/package.json'),
        JSON.stringify({ name: '@demo/cli', scripts: { build: 'x' } }),
      )
      writeFileSync(join(root, 'packages/cli/src/main.ts'), 'cli v1\n')
    }
    const steward = {
      installer: join(top, 'lib/install-signed.py'),
      receipt: join(top, 'lib/installed.json'),
      dataDir: join(top, 'state'),
    }
    if (options.hostSteward) {
      mkdirSync(join(root, 'native/host-steward'), { recursive: true })
      writeFileSync(join(root, 'native/host-steward/install-root.sh'), 'v1\n')
      mkdirSync(join(root, 'packages/ops/data'), { recursive: true })
      // The commit's own deploy data, not the bundled copy, names where the root install lives.
      writeFileSync(
        join(root, 'packages/ops/data/ops.json'),
        JSON.stringify({
          deploy: {
            rootInstall: {
              sources: ['native/host-steward'],
              installer: steward.installer,
              receipt: steward.receipt,
              signingKey: 'update-signing-key',
              declareWhat: 'units',
            },
          },
        }),
      )
      mkdirSync(join(top, 'lib'), { recursive: true })
      writeFileSync(steward.installer, '')
      mkdirSync(join(steward.dataDir, 'secrets'), { recursive: true })
      const key = join(steward.dataDir, 'secrets/update-signing-key')
      run('openssl', ['genpkey', '-algorithm', 'ED25519', '-out', key])
      run('chmod', ['600', key])
      run('openssl', ['pkey', '-in', key, '-pubout', '-out', join(top, 'lib/update-signing.pub')])
    }
    const web = join(top, 'web')
    if (options.frontend) {
      mkdirSync(join(root, 'packages/web-frontend/app'), { recursive: true })
      writeFileSync(
        join(root, 'packages/web-frontend/package.json'),
        JSON.stringify({ name: '@demo/web-frontend', scripts: { build: 'x' } }),
      )
      writeFileSync(join(root, 'packages/web-frontend/app/page.tsx'), 'page v1\n')
      mkdirSync(join(root, 'packages/ops/data'), { recursive: true })
      writeFileSync(
        join(root, 'packages/ops/data/ops.json'),
        JSON.stringify({
          deploy: {
            unitSources: { 'demo-web.service': ['packages/web-frontend'] },
            frontends: {
              'demo-web.service': { package: 'web-frontend', out: 'out', link: web, keep: 1 },
            },
          },
        }),
      )
      if (options.frontend === 'link')
        writeFileSync(
          join(root, 'scripts/systemd/demo-web.service'),
          `[Service]\nWorkingDirectory=__PROJECT_ROOT__/packages/web-server\nEnvironment=AICO_WEB_FRONTEND=${web}/current\nExecStart=node x.mjs\n`,
        )
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
        if (cmd === 'sudo' && args[1] === steward.installer) {
          // The installed installer: verify against the pinned key, record the archive's commit.
          const [archive, signature] = args.slice(2) as [string, string]
          const verified = run('openssl', [
            'pkeyutl',
            '-verify',
            '-rawin',
            '-pubin',
            '-inkey',
            join(top, 'lib/update-signing.pub'),
            '-in',
            archive,
            '-sigfile',
            signature,
          ])
          if (verified.code !== 0) return { code: 1, out: '', err: 'signature is invalid' }
          const commit = spawnSync('git', ['get-tar-commit-id'], {
            input: readFileSync(archive),
          }).stdout.toString()
          writeFileSync(steward.receipt, JSON.stringify({ sha: commit.trim() }))
          return { code: 0, out: 'host-steward installed\n', err: '' }
        }
        if (options.kill?.(cmd, args)) throw new Error('killed')
        if (cmd === 'aico-hook')
          return { ...(options.guard?.(args) ?? { code: 0, out: '' }), err: '' }
        if (cmd === 'aico')
          return {
            code: options.accept ? options.accept(root, args) : 0,
            out: options.acceptOut ?? '',
            err: '',
          }
        if (cmd === 'nice' && args.join(' ') === '-n 10 npm run build -w packages/web-server') {
          mkdirSync(join(opts?.cwd as string, 'packages/web-server/dist'), { recursive: true })
          writeFileSync(join(opts?.cwd as string, 'packages/web-server/dist/x.mjs'), '// web\n')
        }
        if (cmd === 'nice' && args.join(' ') === '-n 10 npm run build -w packages/ops') {
          mkdirSync(join(opts?.cwd as string, 'packages/ops/dist'), { recursive: true })
          writeFileSync(join(opts?.cwd as string, 'packages/ops/dist/aico-ops.mjs'), '// ops\n')
        }
        if (cmd === 'nice' && args.join(' ') === '-n 10 npm run build -w packages/cli') {
          mkdirSync(join(opts?.cwd as string, 'packages/cli/dist'), { recursive: true })
          writeFileSync(join(opts?.cwd as string, 'packages/cli/dist/aico-cli.mjs'), '// cli\n')
        }
        if (cmd === 'nice' && args.join(' ') === '-n 10 npm run build -w packages/web-frontend') {
          const out = join(opts?.cwd as string, 'packages/web-frontend/out')
          mkdirSync(out, { recursive: true })
          writeFileSync(
            join(out, 'index.html'),
            readFileSync(join(opts?.cwd as string, 'packages/web-frontend/app/page.tsx')),
          )
        }
        if (cmd === 'systemctl' && args[1] === 'is-active')
          return { code: 0, out: 'active\n', err: '' }
        return { code: 0, out: '', err: '' }
      },
      out: (line) => lines.push(line),
      err: (line) => lines.push(line),
      env: { AICO_HOOK_BIN: 'aico-hook', AICO_BIN: 'aico', AICO_DATA_DIR: steward.dataDir },
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
      processPaths: () => [],
    }
    const head = git('rev-parse', 'HEAD').out.trim()
    return { root, git, deps, calls, lines, rows, head, steward, web }
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

  it('promotes ops before restarting the services that call its CLI', async () => {
    const { root, deps, head } = setup({ ops: true })
    const original = deps.run
    const observed: (string | null)[] = []
    deps.run = (cmd, args, opts) => {
      if (cmd === 'systemctl' && args.includes('restart')) observed.push(installedOpsSha(deps))
      return original(cmd, args, opts)
    }
    expect(await deploy(request(), root, deps)).toBe(0)
    expect(observed).toEqual([head])
  })

  it('restores the prior ops link with the prior units if a deploy fails health', async () => {
    const { root, git, deps, head } = setup({ ops: true })
    await deploy(request(), root, deps)
    writeFileSync(join(root, 'packages/web-server/main.ts'), 'v2\n')
    writeFileSync(join(root, 'packages/ops/src/main.ts'), 'ops v2\n')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'two')
    const original = deps.run
    const observed: (string | null)[] = []
    deps.run = (cmd, args, opts) => {
      if (cmd === 'systemctl' && args.includes('restart')) observed.push(installedOpsSha(deps))
      return original(cmd, args, opts)
    }
    deps.probe = async () => 503
    await expect(deploy(request(), root, deps)).rejects.toThrow(/previous unit files were restored/)
    expect(observed[0]).not.toBe(head)
    expect(observed.at(-1)).toBe(head)
    expect(installedOpsSha(deps)).toBe(head)
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

  it('refuses a commit beside the running one, as a refusal that changed nothing', async () => {
    const { root, git, deps, rows, head } = setup()
    const commit = (text: string) => {
      writeFileSync(join(root, 'packages/web-server/main.ts'), text)
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', text)
      return git('rev-parse', 'HEAD').out.trim()
    }
    commit('v2\n')
    expect(await deploy(request(), root, deps)).toBe(0)
    git('checkout', '-q', '-b', 'side', head)
    const side = commit('side\n')
    await expect(deploy(request({ sha: side }), root, deps)).rejects.toThrow(/does not contain/)
    expect(rows.at(-1)?.state).toBe('warn')
  })

  it('refuses on failed acceptance or another agent hold, and answers NOT_HANDLED for other projects', async () => {
    const failing = setup({
      accept: () => 1,
      acceptOut:
        'CHECK:acceptance:abc\nCHECK:OK:biome|1s\nCHECK:FAIL:vitest|2s|hint:× a test\n  AssertionError: x\nCHECK:FAIL acceptance 3s',
    })
    const refused = deploy(request(), failing.root, failing.deps)
    await expect(refused).rejects.toThrow(/Acceptance .* failed/)
    // The reason is in the refusal, so nobody has to go through the log for it.
    await expect(refused).rejects.toThrow(
      /CHECK:FAIL:vitest\|2s\|hint:× a test\n {2}AssertionError: x$/,
    )
    expect(existsSync(join(failing.deps.systemdDir, 'demo-web.service'))).toBe(false)
    expect(failing.rows.at(-1)?.state).toBe('warn') // nothing deployed: on the Status screen, no owner ask
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

  it('a second request for the same commit joins the live job and prints its wait hint', async () => {
    const { root, deps, lines, calls } = setup()
    await deploy(request({ detach: true }), root, deps)
    await deploy(request({ detach: true }), root, deps)
    const [only, ...rest] = readdirSync(deps.jobsDir)
    expect(rest).toEqual([])
    const id = only.replace(/\.json$/, '')
    expect(calls.filter((call) => call.startsWith('systemd-run'))).toHaveLength(1)
    expect(lines.some((line) => line.includes(`${id} is already queued`))).toBe(true)
    expect(lines.filter((line) => line.includes(`aico deploy wait ${id}`))).toHaveLength(2)
    // A different request is not a repeat.
    await deploy(request({ detach: true, withAck: 'r1' }), root, deps)
    expect(readdirSync(deps.jobsDir)).toHaveLength(2)
  })

  it('a job whose unit died is not joined', async () => {
    const { root, deps } = setup()
    await deploy(request({ detach: true }), root, deps)
    const original = deps.run
    deps.run = (cmd, args, opts) =>
      cmd === 'systemctl' && args.includes('is-active')
        ? { code: 3, out: 'inactive\n', err: '' }
        : original(cmd, args, opts)
    await deploy(request({ detach: true }), root, deps)
    expect(readdirSync(deps.jobsDir)).toHaveLength(2)
  })

  it('a queued job a newer deploy already covers ends without acceptance', async () => {
    const { root, git, deps, calls, head } = setup()
    await deploy(request({ detach: true }), root, deps)
    const id = readdirSync(deps.jobsDir)[0].replace(/\.json$/, '')
    writeFileSync(join(root, 'packages/web-server/main.ts'), 'v2\n')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'two')
    const newer = git('rev-parse', 'HEAD').out.trim()
    const other = 'aico-0123456789ab'
    writeFileSync(
      join(deps.jobsDir, `${other}.json`),
      JSON.stringify({
        id: other,
        project: 'demo',
        sha: newer,
        state: 'succeeded',
        argv: ['demo', '--sha', newer, '--job', other],
        queued_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      }),
    )
    expect(await deploy(request({ job: id, sha: head }), root, deps)).toBe(0)
    expect(calls.filter((call) => call.includes('--acceptance'))).toEqual([])
    const job = JSON.parse(readFileSync(join(deps.jobsDir, `${id}.json`), 'utf8'))
    expect(job).toMatchObject({ state: 'succeeded', exit_code: 0 })
    expect(job.message).toMatch(/^Not needed: /)
  })

  it('acceptance failing on a safe fix commits it and deploys the new HEAD', async () => {
    let fixedSha = ''
    const { root, deps, calls, head } = setup({
      acceptOut:
        'CHECK:FAIL:biome|1s|hint:x\n  Biome and ruff can fix your own files: st check --fix\n',
      accept: (at, args) => {
        if (args.includes('--repair')) {
          writeFileSync(join(at, 'packages/web-server/main.ts'), 'formatted\n')
          run('git', [
            '-C',
            at,
            '-c',
            'user.email=t@t',
            '-c',
            'user.name=t',
            'commit',
            '-qam',
            'fix',
          ])
          fixedSha = run('git', ['-C', at, 'rev-parse', 'HEAD']).out.trim()
          return 0
        }
        return args.includes(fixedSha) && fixedSha ? 0 : 1
      },
    })
    await deploy(request({ detach: true }), root, deps)
    const id = readdirSync(deps.jobsDir)[0].replace(/\.json$/, '')
    expect(await deploy(request({ job: id, sha: head }), root, deps)).toBe(0)
    expect(calls).toContain('aico check --repair biome')
    const job = JSON.parse(readFileSync(join(deps.jobsDir, `${id}.json`), 'utf8'))
    expect(job).toMatchObject({ state: 'succeeded', sha: fixedSha })
    expect(existsSync(join(deps.releasesDir, fixedSha))).toBe(true)
  })

  it('nothing to fix: no retry, the failure names the file, its commit and who was told', async () => {
    const { root, deps, calls, head } = setup({
      acceptOut:
        'CHECK:FAIL:tsc|1s|hint:packages/web-server/main.ts(1,1): error TS1\n  Biome and ruff can fix your own files: st check --fix\n',
      accept: (_at, args) => (args[0] === 'sessions' ? 0 : args.includes('--repair') ? 1 : 2),
    })
    const receipts = join(root, '.git/aico-checks/receipts')
    mkdirSync(receipts, { recursive: true })
    writeFileSync(join(receipts, `commit-session-${head}.json`), '{"session":"owner-session"}')
    await deploy(request({ detach: true }), root, deps)
    const id = readdirSync(deps.jobsDir)[0].replace(/\.json$/, '')
    await expect(deploy(request({ job: id, sha: head }), root, deps)).rejects.toMatchObject({
      code: 2,
    })
    expect(calls.filter((call) => call.includes('--acceptance'))).toHaveLength(1)
    expect(calls.some((call) => call.startsWith('aico sessions send owner-session '))).toBe(true)
    const job = JSON.parse(readFileSync(join(deps.jobsDir, `${id}.json`), 'utf8'))
    expect(job.state).toBe('failed')
    expect(job.message.split('\n')[0]).toContain(
      `packages/web-server/main.ts, last changed in ${head.slice(0, 10)}`,
    )
    expect(job.message.split('\n')[0]).toContain('told owner-session')
  })

  it('a rollback never repairs its way onto HEAD', async () => {
    const { root, deps, calls, head } = setup({
      acceptOut:
        'CHECK:FAIL:biome|1s|hint:x\n  Biome and ruff can fix your own files: st check --fix\n',
      accept: (_at, args) => (args[0] === 'sessions' ? 0 : 1),
    })
    await expect(deploy(request({ rollback: true, sha: head }), root, deps)).rejects.toThrow(
      /Acceptance of/,
    )
    expect(calls.filter((call) => call.includes('--repair'))).toEqual([])
  })

  it('names a root-level file, and never a directory, with its own failure line', async () => {
    const { root, git, deps, calls, head } = setup({
      acceptOut:
        'CHECK:FAIL:boundaries|1s|hint:packages/web-server bad\n  package.json: pin versions\nCHECK:FAIL:tsc|1s|hint:packages/web-server/main.ts(1,1): error TS1\n',
      accept: (_at, args) => (args[0] === 'sessions' ? 0 : 1),
    })
    const receipts = join(root, '.git/aico-checks/receipts')
    mkdirSync(receipts, { recursive: true })
    writeFileSync(join(receipts, `commit-session-${head}.json`), '{"session":"owner-session"}')
    writeFileSync(join(root, 'package.json'), '{}\n')
    git('add', 'package.json')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'root')
    writeFileSync(
      join(receipts, `commit-session-${git('rev-parse', 'HEAD').out.trim()}.json`),
      '{"session":"other-session"}',
    )
    await expect(deploy(request(), root, deps)).rejects.toThrow(/package\.json, last changed/)
    const sends = calls.filter((call) => call.startsWith('aico sessions send'))
    expect(sends.find((call) => call.includes('package.json fails'))).toContain('pin versions')
    expect(sends.find((call) => call.includes('main.ts fails'))).toContain('TS1')
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

  it('a failed swap recovery is a failed deploy; a hold met before recovery stays a warning', async () => {
    let guards = 0
    const held = setup({
      guard: () => (++guards > 1 ? { code: 1, out: 'hold deploy' } : { code: 0, out: '' }),
    })
    mkdirSync(held.deps.releasesDir, { recursive: true })
    const previous = JSON.stringify({
      sha: 'a'.repeat(40),
      previous: { 'demo-web.service': 'old' },
    })
    writeFileSync(join(held.deps.releasesDir, '.swap.json'), previous)
    await expect(deploy(request(), held.root, held.deps)).rejects.toMatchObject({ code: 2 })
    expect(held.rows.at(-1)?.state).toBe('warn')

    const broken = setup()
    mkdirSync(broken.deps.releasesDir, { recursive: true })
    mkdirSync(broken.deps.systemdDir, { recursive: true })
    writeFileSync(join(broken.deps.releasesDir, '.swap.json'), previous)
    const original = broken.deps.run
    broken.deps.run = (cmd, args, opts) =>
      cmd === 'systemctl' && args[1] === 'restart'
        ? { code: 1, out: '', err: 'failed' }
        : original(cmd, args, opts)
    await expect(deploy(request(), broken.root, broken.deps)).rejects.toThrow(
      /Putting the previous units back failed/,
    )
    expect(broken.rows.at(-1)?.state).toBe('failed')
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
    const dead = deadPid()
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
    const stale = `${deadPid()} gone\n`
    writeFileSync(lock, stale)
    // Neither waiter sees a live owner, so neither may ever sleep waiting for one.
    deps.sleep = async () => {
      throw new Error('a waiter slept on an owner that is not alive')
    }
    const events: string[] = []
    let working = 0
    const claimants = lockClaimants(join(deps.releasesDir, '.deploy.flock'))
    const work = (name: string) =>
      withLock(deps, async (held) => {
        expect(++working).toBe(1)
        events.push(`${name} in`)
        expect(held()).toBe(true)
        // The first holder keeps the lock until the other is really queued on it (the kernel
        // lock's state, not a delay); the second then runs straight through.
        if (events.length === 1) await until(() => claimants() === 2)
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

  it('discovers the user bus and leaves an unreadable deploy unit running', async () => {
    const { deps } = setup()
    mkdirSync(deps.jobsDir, { recursive: true })
    const id = 'aico-000000000001'
    const path = join(deps.jobsDir, `${id}.json`)
    writeFileSync(
      path,
      JSON.stringify({ id, project: 'demo', sha: 'f'.repeat(40), state: 'running' }),
    )
    deps.run = (_cmd, _args, options) => {
      expect(options?.env?.XDG_RUNTIME_DIR).toBe(`/run/user/${process.getuid?.() ?? 0}`)
      expect(options?.env?.DBUS_SESSION_BUS_ADDRESS).toBe(
        `unix:path=/run/user/${process.getuid?.() ?? 0}/bus`,
      )
      return { code: 1, out: '', err: 'Failed to connect to bus' }
    }
    expect(await jobResult(id, false, deps)).toBe(1)
    expect(JSON.parse(readFileSync(path, 'utf8')).state).toBe('running')
  })

  it.each(['inactive', 'failed', 'unknown'])(
    'only systemd evidence %s marks a missing deploy result failed',
    async (state) => {
      const { deps } = setup()
      mkdirSync(deps.jobsDir, { recursive: true })
      const id = 'aico-000000000001'
      const path = join(deps.jobsDir, `${id}.json`)
      writeFileSync(
        path,
        JSON.stringify({ id, project: 'demo', sha: 'f'.repeat(40), state: 'running' }),
      )
      deps.run = () => ({ code: 3, out: state, err: '' })
      expect(await jobResult(id, false, deps)).toBe(1)
      expect(JSON.parse(readFileSync(path, 'utf8')).state).toBe('failed')
    },
  )

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

  it('sets up the st service tools of the release it installs, so the first st service call need not', async () => {
    const { root, git, deps, calls, head } = setup({ ops: true })
    mkdirSync(join(root, 'native/service-tools'), { recursive: true })
    writeFileSync(join(root, 'native/service-tools/uv.lock'), 'lock\n')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'tools')
    const sha = git('rev-parse', 'HEAD').out.trim()
    expect(sha).not.toBe(head)
    expect(await deploy(request(), root, deps)).toBe(0)
    const tools = join(deps.releasesDir, sha, 'native/service-tools')
    expect(calls).toContain(`nice -n 10 uv sync --quiet --locked --no-dev --directory ${tools}`)
  })

  it('builds and refreshes installed commands for a CLI-only commit without restarting units', async () => {
    const { root, git, deps, calls, head } = setup({ ops: true, cli: true })
    expect(await deploy(request(), root, deps)).toBe(0)
    expect(installedOpsSha(deps)).toBe(head)
    expect(existsSync(join(deps.opsLink, 'packages/cli/dist/aico-cli.mjs'))).toBe(true)
    calls.length = 0
    writeFileSync(join(root, 'packages/cli/src/main.ts'), 'cli v2\n')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'CLI change')
    const changed = git('rev-parse', 'HEAD').out.trim()
    expect(await deploy(request(), root, deps)).toBe(0)
    expect(installedOpsSha(deps)).toBe(changed)
    expect(calls).toContain('nice -n 10 npm run build -w packages/cli')
    expect(calls.filter((call) => call.includes('restart'))).toEqual([])
  })

  describe('every accepted release stands alone on a peer', () => {
    const commit = (git: ReturnType<typeof setup>['git'], file: string, text: string) => {
      writeFileSync(file, text)
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A')
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'change')
      return git('rev-parse', 'HEAD').out.trim()
    }
    const built = (deps: DeployDeps, sha: string) =>
      (
        JSON.parse(readFileSync(join(deps.releasesDir, sha, '.aico-release.json'), 'utf8')) as {
          built: string[]
        }
      ).built

    it('a CLI-only deploy carries the unchanged web build over as hard links', async () => {
      const { root, git, deps, calls, head } = setup({ ops: true, cli: true })
      expect(await deploy(request(), root, deps)).toBe(0)
      expect(built(deps, head).sort()).toEqual(['cli', 'ops', 'web-server'])
      calls.length = 0
      const second = commit(git, join(root, 'packages/cli/src/main.ts'), 'cli v2\n')
      expect(await deploy(request(), root, deps)).toBe(0)
      expect(calls).not.toContain('nice -n 10 npm run build -w packages/web-server')
      expect(built(deps, second).sort()).toEqual(['cli', 'ops', 'web-server'])
      const first = join(deps.releasesDir, head, 'packages/web-server/dist/x.mjs')
      const carried = join(deps.releasesDir, second, 'packages/web-server/dist/x.mjs')
      expect(statSync(carried).ino).toBe(statSync(first).ino)
      expect(
        readFileSync(join(deps.releasesDir, second, 'packages/web-server/main.ts'), 'utf8'),
      ).toBe('v1\n')
      expect(readFileSync(join(deps.releasesDir, ACCEPTED), 'utf8').trim()).toBe(second)
    })

    it('builds what changed since the earlier release instead of carrying it', async () => {
      const { root, git, deps, calls, head } = setup({ ops: true, cli: true })
      expect(await deploy(request(), root, deps)).toBe(0)
      const second = commit(git, join(root, 'packages/web-server/main.ts'), 'v2\n')
      calls.length = 0
      const project = loadProject(root)
      const workspace = readPackages(gitAt(root), second)
      const template = (unit: string) =>
        run('git', ['-C', root, 'show', `${second}:scripts/systemd/${unit}`]).out
      expect(peerPackages(project, workspace, ops.deploy, template).sort()).toEqual([
        'cli',
        'ops',
        'web-server',
      ])
      // Only ops was asked for: web-server's source changed since `head`, so it is built here.
      prepareRelease(root, second, ['ops'], deps, {
        packages: ['ops', 'cli', 'web-server'],
        workspace,
        cfg: ops.deploy,
      })
      expect(calls).toContain('nice -n 10 npm run build -w packages/web-server')
      expect(built(deps, second).sort()).toEqual(['cli', 'ops', 'web-server'])
      const own = join(deps.releasesDir, second, 'packages/web-server/dist/x.mjs')
      expect(statSync(own).ino).not.toBe(
        statSync(join(deps.releasesDir, head, 'packages/web-server/dist/x.mjs')).ino,
      )
    })
  })

  it('installs the host-steward root sources signed, and again only when they changed', async () => {
    const { root, git, deps, calls, lines, rows, head, steward } = setup({ hostSteward: true })
    const commit = (file: string, text: string) => {
      writeFileSync(join(root, file), text)
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', file)
      return git('rev-parse', 'HEAD').out.trim()
    }
    const installs = () => calls.filter((call) => call.startsWith(`sudo -n ${steward.installer} `))
    expect(await deploy(request(), root, deps)).toBe(0)
    expect(calls.some((call) => call.startsWith('host-steward declare --host '))).toBe(true)
    expect(installs()).toHaveLength(1)
    expect(JSON.parse(readFileSync(steward.receipt, 'utf8')).sha).toBe(head)
    expect(rows.at(-1)?.meaning).toContain('the host-steward root install')
    // No change since the installed commit, then a change elsewhere: no root install.
    expect(await deploy(request(), root, deps)).toBe(0)
    commit('packages/web-server/main.ts', 'v2\n')
    expect(await deploy(request(), root, deps)).toBe(0)
    expect(installs()).toHaveLength(1)
    expect(lines.join('\n')).toContain(`root install skipped: unchanged since ${head.slice(0, 12)}`)
    // A root source change installs again; a failed host check declaration does not block it.
    const changed = commit('native/host-steward/install-root.sh', 'v2\n')
    const original = deps.run
    deps.run = (cmd, args, opts) =>
      cmd === 'host-steward'
        ? { code: 1, out: '', err: 'host-steward down' }
        : original(cmd, args, opts)
    expect(await deploy(request(), root, deps)).toBe(0)
    expect(installs()).toHaveLength(2)
    expect(JSON.parse(readFileSync(steward.receipt, 'utf8')).sha).toBe(changed)
    expect(lines.join('\n')).toContain('could not declare the host change to the host check')
  })

  it('a failed root install fails the deploy and says the units went live', async () => {
    const { root, deps, rows, steward } = setup({ hostSteward: true })
    const original = deps.run
    deps.run = (cmd, args, opts) =>
      cmd === 'sudo' ? { code: 1, out: '', err: 'installer broke' } : original(cmd, args, opts)
    await expect(deploy(request(), root, deps)).rejects.toThrow(
      /root install failed: installer broke/,
    )
    expect(rows.at(-1)).toMatchObject({
      state: 'failed',
      meaning: expect.stringContaining('demo-web.service deployed'),
    })
    expect(existsSync(steward.receipt)).toBe(false)
  })

  it('installs aico-hook when the commit’s hook sources differ from the installed build', async () => {
    const { root, git, deps, lines, rows } = setup()
    const hookDir = join(deps.releasesDir, '..', 'hook')
    const commit = (file: string, text: string) => {
      mkdirSync(join(root, file, '..'), { recursive: true })
      writeFileSync(join(root, file), text)
      git('add', '-A')
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', file)
      return git('rev-parse', 'HEAD').out.trim()
    }
    const script = (exit: number) =>
      `mkdir -p "$AICO_HOOK_BASE" && ln -sfn "releases/$AICO_HOOK_REL" "$AICO_HOOK_BASE/current"\nexit ${exit}\n`
    commit(
      'packages/ops/data/ops.json',
      JSON.stringify({ deploy: { hookInstall: { source: 'native/hook', dir: hookDir } } }),
    )
    commit('native/hook/install.sh', script(0))
    const original = deps.run
    deps.run = (cmd, args, opts) =>
      cmd === 'bash' ? run(cmd, args, opts) : original(cmd, args, opts)
    const tree = () => git('rev-parse', '--short=12', 'HEAD:native/hook').out.trim()
    const installed = () => readlinkSync(join(hookDir, 'current'))
    expect(await deploy(request(), root, deps)).toBe(0)
    const first = git('rev-parse', 'HEAD').out.trim()
    expect(installed()).toBe(`releases/${tree()}`)
    expect(rows.at(-1)?.meaning).toContain('aico-hook')
    // The same hook tree: nothing to install.
    lines.length = 0
    expect(await deploy(request(), root, deps)).toBe(0)
    expect(lines.join('\n')).not.toContain('installing aico-hook')
    // A newer commit's build stays when an older commit is deployed.
    commit('native/hook/main.go', 'v2\n')
    expect(await deploy(request(), root, deps)).toBe(0)
    const newer = installed()
    await deploy(request({ sha: first }), root, deps).catch(() => {})
    expect(installed()).toBe(newer)
    // A failed install fails the deploy, after the release was accepted.
    commit('packages/web-server/main.ts', 'v2\n')
    const failing = commit('native/hook/install.sh', script(3))
    await expect(deploy(request(), root, deps)).rejects.toThrow(/aico-hook install failed/)
    expect(rows.at(-1)?.state).toBe('failed')
    expect(readFileSync(join(deps.releasesDir, ACCEPTED), 'utf8').trim()).toBe(failing)
  })

  it('leaves aico-hook alone for a commit whose own deploy data has no hook install', async () => {
    const { root, git, deps, lines } = setup()
    mkdirSync(join(root, 'native/hook'), { recursive: true })
    writeFileSync(join(root, 'native/hook/install.sh'), 'exit 1\n')
    git('add', '-A')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'hook')
    expect(await deploy(request(), root, deps)).toBe(0)
    expect(lines.join('\n')).not.toContain('aico-hook')
  })

  it('skips the root install on a machine without the signed installer', async () => {
    const { root, deps, calls, lines, steward } = setup({ hostSteward: true })
    rmSync(steward.installer)
    expect(await deploy(request(), root, deps)).toBe(0)
    expect(calls.some((call) => call.startsWith('sudo'))).toBe(false)
    expect(lines.join('\n')).toContain('root install skipped: this machine has no signed installer')
  })

  describe('a server that serves its frontend build from a link', () => {
    const restarts = (calls: string[]) => calls.filter((call) => call.includes(' restart '))
    const commitIn =
      (git: (...args: string[]) => { out: string }, root: string) =>
      (file: string, text: string) => {
        writeFileSync(join(root, file), text)
        git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', file)
        return git('rev-parse', 'HEAD').out.trim()
      }
    const served = (web: string) => readFileSync(join(web, 'current/index.html'), 'utf8')

    it('a frontend-only change swaps the build without a restart and keeps the one before', async () => {
      const { root, git, deps, calls, rows, head, web } = setup({ frontend: 'link' })
      expect(await deploy(request(), root, deps)).toBe(0)
      expect(restarts(calls)).toEqual(['systemctl --user restart demo-web.service'])
      expect(served(web)).toBe('page v1\n')
      calls.length = 0
      const commit = commitIn(git, root)
      const second = commit('packages/web-frontend/app/page.tsx', 'page v2\n')
      expect(await deploy(request(), root, deps)).toBe(0)
      expect(restarts(calls)).toEqual([])
      expect(served(web)).toBe('page v2\n')
      expect(readFileSync(join(web, `earlier-${head}/index.html`), 'utf8')).toBe('page v1\n')
      expect(rows.at(-1)?.meaning).toContain('the demo-web page (no restart)')
      // The unit still runs the first release; the link serves the second.
      expect(readFileSync(join(deps.systemdDir, 'demo-web.service'), 'utf8')).toContain(head)
      expect(readFileSync(join(deps.releasesDir, second, '.aico-release.json'), 'utf8')).toContain(
        'web-frontend',
      )
      // keep: 1 holds only the build just replaced.
      commit('packages/web-frontend/app/page.tsx', 'page v3\n')
      expect(await deploy(request(), root, deps)).toBe(0)
      expect(readdirSync(web).sort()).toEqual(['current', `earlier-${second}`])
      // A server change still restarts it, and the restarted server serves its own build.
      const fourth = commit('packages/web-server/main.ts', 'v2\n')
      expect(await deploy(request(), root, deps)).toBe(0)
      expect(restarts(calls)).toEqual(['systemctl --user restart demo-web.service'])
      expect(readFileSync(join(deps.systemdDir, 'demo-web.service'), 'utf8')).toContain(fourth)
      expect(served(web)).toBe('page v3\n')
      expect(realpathSync(join(web, 'current'))).toContain(fourth)
    })

    it('a server not yet serving from the link restarts for a frontend change', async () => {
      const { root, git, deps, calls, web } = setup({ frontend: 'bundled' })
      expect(await deploy(request(), root, deps)).toBe(0)
      const commit = commitIn(git, root)
      calls.length = 0
      const second = commit('packages/web-frontend/app/page.tsx', 'page v2\n')
      expect(await deploy(request(), root, deps)).toBe(0)
      expect(restarts(calls)).toEqual(['systemctl --user restart demo-web.service'])
      // The template that turns the link on restarts it once; from then on a build swaps in.
      commit(
        'scripts/systemd/demo-web.service',
        `[Service]\nWorkingDirectory=__PROJECT_ROOT__/packages/web-server\nEnvironment=AICO_WEB_FRONTEND=${web}/current\n`,
      )
      calls.length = 0
      expect(await deploy(request(), root, deps)).toBe(0)
      expect(restarts(calls)).toEqual(['systemctl --user restart demo-web.service'])
      // The build the server answered with before the link existed stays reachable.
      expect(readFileSync(join(web, `earlier-${second}/index.html`), 'utf8')).toBe('page v2\n')
      calls.length = 0
      commit('packages/web-frontend/app/page.tsx', 'page v3\n')
      expect(await deploy(request(), root, deps)).toBe(0)
      expect(restarts(calls)).toEqual([])
      expect(served(web)).toBe('page v3\n')
    })

    it('links the previous build back when the page stops answering, and rolls back by swapping', async () => {
      const { root, git, deps, calls, head, web } = setup({ frontend: 'link' })
      expect(await deploy(request(), root, deps)).toBe(0)
      const commit = commitIn(git, root)
      commit('packages/web-frontend/app/page.tsx', 'page v2\n')
      deps.probe = async () => 503
      await expect(deploy(request(), root, deps)).rejects.toThrow(/previous page was linked back/)
      expect(served(web)).toBe('page v1\n')
      deps.probe = async () => 200
      expect(await deploy(request(), root, deps)).toBe(0)
      expect(served(web)).toBe('page v2\n')
      // An older build never replaces a newer one, except as a rollback.
      calls.length = 0
      expect(await deploy(request({ sha: head }), root, deps)).toBe(0)
      expect(served(web)).toBe('page v2\n')
      expect(await deploy(request({ sha: head, rollback: true }), root, deps)).toBe(0)
      expect(served(web)).toBe('page v1\n')
      expect(restarts(calls)).toEqual([])
    })

    it('a frontend scope swaps the build; a backend scope restarts', async () => {
      const { root, git, deps, calls, web } = setup({ frontend: 'link' })
      expect(await deploy(request(), root, deps)).toBe(0)
      commitIn(git, root)('packages/web-frontend/app/page.tsx', 'page v2\n')
      calls.length = 0
      expect(await deploy(request({ scope: 'frontend' }), root, deps)).toBe(0)
      expect(restarts(calls)).toEqual([])
      expect(served(web)).toBe('page v2\n')
      expect(await deploy(request({ scope: 'backend' }), root, deps)).toBe(0)
      expect(restarts(calls)).toEqual(['systemctl --user restart demo-web.service'])
    })

    it('a release whose build a link serves is never pruned', async () => {
      const { root, git, deps, head, web } = setup({ frontend: 'link' })
      expect(await deploy(request(), root, deps)).toBe(0)
      const commit = commitIn(git, root)
      commit('packages/web-frontend/app/page.tsx', 'page v2\n')
      expect(await deploy(request(), root, deps)).toBe(0)
      const cfg = JSON.parse(readFileSync(join(root, 'packages/ops/data/ops.json'), 'utf8')).deploy
      // Newer, unrelated releases push the served ones out of the newest kept.
      const newer = ['7', '8', '9'].map((c) => c.repeat(40))
      for (const [i, name] of newer.entries()) {
        mkdirSync(join(deps.releasesDir, name), { recursive: true })
        utimesSync(join(deps.releasesDir, name), 4e9 + i, 4e9 + i)
      }
      rmSync(deps.systemdDir, { recursive: true, force: true })
      pruneReleases(deps, join(deps.releasesDir, newer[2] as string), { ...ops.deploy, ...cfg })
      const second = realpathSync(join(web, 'current')).split('/').at(-4)
      expect(existsSync(join(deps.releasesDir, head))).toBe(true)
      expect(existsSync(join(deps.releasesDir, second as string))).toBe(true)
    })

    it('the shipped template serves from the link ops.json names', () => {
      const spec = frontendSpec(ops.deploy, 'aico-web.service')
      expect(spec).not.toBeNull()
      const template = readFileSync(join(repo, 'scripts/systemd/aico-web.service'), 'utf8')
      expect(servesLink(template, spec as NonNullable<typeof spec>)).toBe(true)
    })
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

  it('keeps a release a live process runs from (cwd, exe or command line)', () => {
    const { deps } = setup()
    const names = ['1', '2', '3', '4', '5', '6'].map((c) => c.repeat(40))
    for (const [i, name] of names.entries()) {
      mkdirSync(join(deps.releasesDir, name), { recursive: true })
      utimesSync(join(deps.releasesDir, name), 1_000 + i, 1_000 + i)
    }
    const at = (i: number) => join(deps.releasesDir, names[i] as string)
    deps.processPaths = () => [
      `${at(0)}/packages/jobs`,
      `node ${at(1)}/packages/ops/dist/aico-ops.mjs jobs`,
      '/usr/bin/node',
    ]
    pruneReleases(deps, at(5))
    const left = names.filter((name) => existsSync(join(deps.releasesDir, name)))
    expect(left).toEqual([names[0], names[1], names[3], names[4], names[5]])
  })

  it('reads process paths from a /proc-shaped directory', () => {
    const { deps } = setup()
    const proc = join(deps.releasesDir, '..', 'proc')
    mkdirSync(join(proc, '42'), { recursive: true })
    symlinkSync('/somewhere/cwd', join(proc, '42', 'cwd'))
    writeFileSync(join(proc, '42', 'cmdline'), 'node\0/rel/x.mjs\0')
    mkdirSync(join(proc, 'self'), { recursive: true })
    mkdirSync(join(proc, '42', 'fd'))
    symlinkSync('/rel/open-file', join(proc, '42', 'fd', '3'))
    writeFileSync(join(proc, '42', 'maps'), '7f00-7f01 r-xp 0 08:01 1 /rel/mapped.so\n')
    expect(procPaths(proc)).toEqual([
      '/somewhere/cwd',
      'node /rel/x.mjs ',
      '/rel/open-file',
      '7f00-7f01 r-xp 0 08:01 1 /rel/mapped.so\n',
    ])
  })
})

export type { Project }

describe('run with tee', () => {
  it('returns what it streamed, with the command exit code', () => {
    const shown = run('bash', ['-c', 'echo out; echo err >&2; exit 3'], { tee: true })
    expect(shown.code).toBe(3)
    expect(shown.out).toBe('out\nerr\n')
  })
})
