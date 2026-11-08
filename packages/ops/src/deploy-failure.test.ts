// A failed deploy leaves the old release running. A stand-in systemd tracks what each unit actually
// runs (the release its unit file names at the moment of its last restart), so these check the
// running service, not just the unit file on disk.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type DeployDeps, deploy } from './deploy'
import { run } from './sh'

const WEB = 'demo-web.service'
const WORKER = 'demo-worker.service'

interface Faults {
  build?: boolean
  accept?: number
  restart?: (unit: string) => boolean
  /** Units that restart fine, then show as failed when asked is-active. */
  inactive?: (unit: string) => boolean
  probe?: number
}

let top = ''
afterEach(() => {
  if (top) rmSync(top, { recursive: true, force: true })
})

function setup() {
  top = mkdtempSync(join(tmpdir(), 'aico-deploy-failure-'))
  const root = join(top, 'repo')
  const unit = (pkg: string) =>
    `[Service]\nWorkingDirectory=__PROJECT_ROOT__/packages/${pkg}\nExecStart=node __PROJECT_ROOT__/packages/${pkg}/dist/x.mjs\n`
  for (const pkg of ['web-server', 'worker']) {
    mkdirSync(join(root, 'packages', pkg), { recursive: true })
    writeFileSync(
      join(root, 'packages', pkg, 'package.json'),
      JSON.stringify({ name: `@demo/${pkg}`, scripts: { build: 'x' } }),
    )
    writeFileSync(join(root, 'packages', pkg, 'main.ts'), 'v1\n')
  }
  mkdirSync(join(root, 'scripts/systemd'), { recursive: true })
  writeFileSync(join(root, 'scripts/systemd', WEB), unit('web-server'))
  writeFileSync(join(root, 'scripts/systemd', WORKER), unit('worker'))
  writeFileSync(
    join(root, 'project.identity.json'),
    JSON.stringify({
      project: { id: 'demo', legacy_ids: [] },
      runtime: { backend_port: 3999, health_endpoint: '/health' },
      services: { backend: WEB, default_workers: [WORKER], manual_workers: [] },
    }),
  )
  const git = (...args: string[]) => run('git', ['-C', root, ...args])
  const commit = (message: string) => {
    git('add', '-A')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', message)
    return git('rev-parse', 'HEAD').out.trim()
  }
  const first = (git('init', '-q', '-b', 'main'), commit('one'))

  const faults: Faults = {}
  const running: Record<string, string> = {}
  const restarts: string[] = []
  const rows: { state: string; meaning: string }[] = []
  const systemdDir = join(top, 'systemd')
  const releasesDir = join(top, 'releases')
  const deps: DeployDeps = {
    run: (cmd, args, opts) => {
      if (cmd === 'git' || cmd === 'tar' || cmd === 'cp') return run(cmd, args, opts)
      if (cmd === 'aico') return { code: faults.accept ?? 0, out: '', err: '' }
      if (cmd === 'nice' && args.includes('build')) {
        if (faults.build) return { code: 1, out: 'build broke', err: '' }
        const pkg = (args.at(-1) as string).replace('packages/', '')
        mkdirSync(join(opts?.cwd as string, 'packages', pkg, 'dist'), { recursive: true })
        writeFileSync(join(opts?.cwd as string, 'packages', pkg, 'dist/x.mjs'), '// built\n')
      }
      if (cmd === 'systemctl' && args[1] === 'restart') {
        const name = args[2] as string
        restarts.push(name)
        // Exit non-zero and stay on what it ran, as systemd does when the new start fails outright.
        if (faults.restart?.(name)) return { code: 1, out: '', err: 'start failed' }
        const text = readFileSync(join(systemdDir, name), 'utf8')
        running[name] = /releases\/([0-9a-f]{40})/.exec(text)?.[1] ?? 'unknown'
      }
      if (cmd === 'systemctl' && args[1] === 'is-active') {
        const state = faults.inactive?.(args[2] as string) ? 'failed' : 'active'
        return { code: 0, out: `${state}\n`, err: '' }
      }
      return { code: 0, out: '', err: '' }
    },
    out: () => {},
    err: () => {},
    env: { AICO_HOOK_BIN: 'true', AICO_BIN: 'aico', AICO_DATA_DIR: join(top, 'state') },
    releasesDir,
    jobsDir: join(top, 'jobs'),
    systemdDir,
    probe: async () => faults.probe ?? 200,
    sleep: async () => {},
    report: async (row) => {
      rows.push(row)
    },
    self: '/bundle.mjs',
    opsLink: join(top, 'ops'),
    processPaths: () => [],
  }
  const request = {
    project: 'demo',
    workers: [],
    includeAllWorkers: false,
    detach: false,
    rollback: false,
  }
  /** One good deploy of the first commit, then a second commit ready to go live. */
  const liveThenChanged = async () => {
    await deploy(request, root, deps)
    expect(running).toEqual({ [WEB]: first, [WORKER]: first })
    writeFileSync(join(root, 'packages/web-server/main.ts'), 'v2\n')
    writeFileSync(join(root, 'packages/worker/main.ts'), 'v2\n')
    const second = commit('two')
    restarts.length = 0
    rows.length = 0
    return second
  }
  const onOldRelease = () => {
    expect(running).toEqual({ [WEB]: first, [WORKER]: first })
    for (const name of [WEB, WORKER])
      expect(readFileSync(join(systemdDir, name), 'utf8')).toContain(`releases/${first}/`)
    expect(existsSync(join(releasesDir, first, 'packages/web-server/dist/x.mjs'))).toBe(true)
    expect(existsSync(join(releasesDir, '.swap.json'))).toBe(false)
    expect(rows.at(-1)?.state).not.toBe('ok')
  }
  return { root, deps, faults, restarts, rows, request, liveThenChanged, onOldRelease }
}

describe('a failed deploy leaves the old release running', () => {
  it('a build that fails restarts nothing', async () => {
    const t = setup()
    await t.liveThenChanged()
    t.faults.build = true
    await expect(deploy(t.request, t.root, t.deps)).rejects.toThrow(/build broke/)
    expect(t.restarts).toEqual([])
    t.onOldRelease()
  })

  it('failed acceptance restarts nothing and builds nothing', async () => {
    const t = setup()
    const second = await t.liveThenChanged()
    t.faults.accept = 1
    await expect(deploy(t.request, t.root, t.deps)).rejects.toThrow(/nothing was deployed/)
    expect(t.restarts).toEqual([])
    expect(existsSync(join(t.deps.releasesDir, second))).toBe(false)
    t.onOldRelease()
  })

  it('a new web server that answers 503 goes back, workers included', async () => {
    const t = setup()
    await t.liveThenChanged()
    t.faults.probe = 503
    await expect(deploy(t.request, t.root, t.deps)).rejects.toThrow(
      /answered 503.*previous unit files were restored/s,
    )
    t.onOldRelease()
    expect(t.rows.at(-1)?.state).toBe('failed')
  })

  it('a second unit that will not start takes the first back with it', async () => {
    const t = setup()
    await t.liveThenChanged()
    let refused = false
    t.faults.restart = (unit) => {
      if (unit !== WORKER || refused) return false
      refused = true
      return true
    }
    await expect(deploy(t.request, t.root, t.deps)).rejects.toThrow(/did not restart/)
    t.onOldRelease()
  })

  it('a unit that restarts then dies goes back too', async () => {
    const t = setup()
    await t.liveThenChanged()
    t.faults.inactive = (unit) => unit === WORKER
    await expect(deploy(t.request, t.root, t.deps)).rejects.toThrow(/is failed/)
    t.onOldRelease()
  })

  it('a deploy after a failed one still goes live', async () => {
    const t = setup()
    const second = await t.liveThenChanged()
    t.faults.probe = 503
    await expect(deploy(t.request, t.root, t.deps)).rejects.toThrow()
    t.faults.probe = 200
    expect(await deploy(t.request, t.root, t.deps)).toBe(0)
    expect(readFileSync(join(t.deps.systemdDir, WEB), 'utf8')).toContain(`releases/${second}/`)
    expect(t.rows.at(-1)?.state).toBe('ok')
  })
})
